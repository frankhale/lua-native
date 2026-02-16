#include <gtest/gtest.h>

#include <cmath>
#include <limits>

#include "core/lua-runtime.h"

using namespace lua_core;

TEST(LuaRuntimeCore, ReturnsNumbersAndStrings) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return 42, 'ok'");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "ok");
}

TEST(LuaRuntimeCore, HandlesBooleansAndNil) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return true, false, nil");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_EQ(std::get<bool>(vals[0]->value), true);
  EXPECT_EQ(std::get<bool>(vals[1]->value), false);
  EXPECT_TRUE(std::holds_alternative<std::monostate>(vals[2]->value));
}

TEST(LuaRuntimeCore, ArraysAndTables) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return {1, 2, 3}, { a = 1, b = 'x' }");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);

  const auto& arr = std::get<LuaArray>(vals[0]->value);
  ASSERT_EQ(arr.size(), 3u);
  EXPECT_EQ(std::get<int64_t>(arr[0]->value), 1);
  EXPECT_EQ(std::get<int64_t>(arr[1]->value), 2);
  EXPECT_EQ(std::get<int64_t>(arr[2]->value), 3);

  const auto& tbl = std::get<LuaTable>(vals[1]->value);
  EXPECT_EQ(std::get<int64_t>(tbl.at("a")->value), 1);
  EXPECT_EQ(std::get<std::string>(tbl.at("b")->value), "x");
}

TEST(LuaRuntimeCore, RegisterFunctionAndCall) {
  LuaRuntime rt;
  rt.RegisterFunction("adder", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t a = std::get<int64_t>(args[0]->value);
    int64_t b = std::get<int64_t>(args[1]->value);
    return std::make_shared<LuaValue>(LuaValue::from(a + b));
  });

  const auto res = rt.ExecuteScript("return adder(2, 3)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 5);
}

TEST(LuaRuntimeCore, SetGlobalAndGetGlobal) {
  const LuaRuntime rt;
  rt.SetGlobal("x", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42))));
  const auto gv = rt.GetGlobal("x");
  ASSERT_NE(gv, nullptr);
  EXPECT_EQ(std::get<int64_t>(gv->value), 42);

  const auto res = rt.ExecuteScript("return x");
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
}

TEST(LuaRuntimeCore, ErrorPropagation) {
  const LuaRuntime rt;
  auto res = rt.ExecuteScript("error('boom')");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("boom"), std::string::npos);
}

TEST(LuaRuntimeCore, ArrayVsMapDetection) {
  const LuaRuntime rt;
  // Sparse numeric keys -> should be a map with string keys "1" and "3"
  const auto res = rt.ExecuteScript("local t = {}; t[1]=10; t[3]=30; return t");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaTable>(vals[0]->value));
  const auto& tbl = std::get<LuaTable>(vals[0]->value);
  ASSERT_EQ(tbl.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(tbl.at("1")->value), 10);
  EXPECT_EQ(std::get<int64_t>(tbl.at("3")->value), 30);
}

TEST(LuaRuntimeCore, EmptyTableIsArray) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return {}");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaArray>(vals[0]->value));
  const auto& arr = std::get<LuaArray>(vals[0]->value);
  EXPECT_TRUE(arr.empty());
}

TEST(LuaRuntimeCore, DeepRecursionCap) {
  const LuaRuntime rt;
  // Build a nested table 105 levels deep: t.child.child....
  // This should return an error because it exceeds the depth limit
  const auto res = rt.ExecuteScript(R"(
    local function nest(n)
      if n == 0 then return {} end
      return { child = nest(n-1) }
    end
    return nest(105)
  )");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("nesting depth"), std::string::npos);
}

TEST(LuaRuntimeCore, DeepRecursionAtLimit) {
  const LuaRuntime rt;
  // Build a nested table exactly at the depth limit (100 levels)
  // This should succeed because depth never exceeds kMaxDepth
  const auto res = rt.ExecuteScript(R"(
    local function nest(n)
      if n == 0 then return {} end
      return { child = nest(n-1) }
    end
    return nest(100)
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);

  // Walk down to the deepest level
  const LuaPtr* current = &vals[0];
  for (int depth = 0; depth < 100; ++depth) {
    ASSERT_TRUE(std::holds_alternative<LuaTable>((*current)->value));
    const auto& tbl = std::get<LuaTable>((*current)->value);
    auto it = tbl.find("child");
    ASSERT_NE(it, tbl.end());
    current = &it->second;
  }
  // At the bottom we should find an empty array (empty table)
  ASSERT_TRUE(std::holds_alternative<LuaArray>((*current)->value));
}

TEST(LuaRuntimeCore, NumericEdgeCases) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return math.maxinteger, math.mininteger, 1.5");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), std::numeric_limits<long long>::max());
  EXPECT_EQ(std::get<int64_t>(vals[1]->value), std::numeric_limits<long long>::min());
  EXPECT_DOUBLE_EQ(std::get<double>(vals[2]->value), 1.5);
}

TEST(LuaRuntimeCore, SpecialDoubles) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return math.huge, -math.huge, 0/0");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_TRUE(std::isinf(std::get<double>(vals[0]->value)) && std::get<double>(vals[0]->value) > 0);
  EXPECT_TRUE(std::isinf(std::get<double>(vals[1]->value)) && std::get<double>(vals[1]->value) < 0);
  EXPECT_TRUE(std::isnan(std::get<double>(vals[2]->value)));
}

TEST(LuaRuntimeCore, MultipleReturnsFive) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return 1,2,3,4,5");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 5u);
  for (int i = 0; i < 5; ++i) {
    EXPECT_EQ(std::get<int64_t>(vals[i]->value), i + 1);
  }
}

TEST(LuaRuntimeCore, BinaryAndUtf8Strings) {
  const LuaRuntime rt;
  const auto res = rt.ExecuteScript("return string.char(97,0,98), 'héllo'");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);

  const std::string bin = std::get<std::string>(vals[0]->value);
  ASSERT_EQ(bin.size(), 3u);
  EXPECT_EQ(bin[0], 'a');
  EXPECT_EQ(bin[1], '\0');
  EXPECT_EQ(bin[2], 'b');

  EXPECT_EQ(std::get<std::string>(vals[1]->value), "héllo");
}

TEST(LuaRuntimeCore, HostFunctionReturnsArrayAndTable) {
  LuaRuntime rt;
  rt.RegisterFunction("mkArray", [](const std::vector<LuaPtr>&) -> LuaPtr {
    LuaArray a;
    a.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(10))));
    a.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(20))));
    return std::make_shared<LuaValue>(LuaValue::from(std::move(a)));
  });
  rt.RegisterFunction("mkTable", [](const std::vector<LuaPtr>&) -> LuaPtr {
    LuaTable t;
    t.emplace("k", std::make_shared<LuaValue>(LuaValue::from(std::string("v"))));
    return std::make_shared<LuaValue>(LuaValue::from(std::move(t)));
  });

  {
    const auto res = rt.ExecuteScript("local t = mkArray(); return t[1], t[2]");
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 2u);
    EXPECT_EQ(std::get<int64_t>(vals[0]->value), 10);
    EXPECT_EQ(std::get<int64_t>(vals[1]->value), 20);
  }
  {
    const auto res = rt.ExecuteScript("local t = mkTable(); return t.k");
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 1u);
    EXPECT_EQ(std::get<std::string>(vals[0]->value), "v");
  }
}

TEST(LuaRuntimeCore, HostFunctionException) {
  LuaRuntime rt;
  rt.RegisterFunction("oops", [](const std::vector<LuaPtr>&) -> LuaPtr {
    throw std::runtime_error("bad things");
  });
  auto res = rt.ExecuteScript("return oops()");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("threw an exception"), std::string::npos);
}

TEST(LuaRuntimeCore, SetGlobalComplexStructures) {
  LuaRuntime rt;
  // Set global array t = {5,6}
  {
    LuaArray arr;
    arr.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(5))));
    arr.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(6))));
    rt.SetGlobal("t", std::make_shared<LuaValue>(LuaValue::from(std::move(arr))));
    const auto res = rt.ExecuteScript("return t[1], t[2]");
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    EXPECT_EQ(std::get<int64_t>(vals[0]->value), 5);
    EXPECT_EQ(std::get<int64_t>(vals[1]->value), 6);
  }
  // Set global map m = {a=7, b={c=8}}
  {
    LuaTable inner;
    inner.emplace("c", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(8))));
    LuaTable outer;
    outer.emplace("a", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(7))));
    outer.emplace("b", std::make_shared<LuaValue>(LuaValue::from(std::move(inner))));
    rt.SetGlobal("m", std::make_shared<LuaValue>(LuaValue::from(std::move(outer))));
    const auto res = rt.ExecuteScript("return m.a, m.b.c");
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    EXPECT_EQ(std::get<int64_t>(vals[0]->value), 7);
    EXPECT_EQ(std::get<int64_t>(vals[1]->value), 8);
  }
}

TEST(LuaRuntimeCore, FunctionReregistrationUsesLatest) {
  LuaRuntime rt;
  rt.RegisterFunction("f", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)));
  });
  rt.RegisterFunction("f", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(2)));
  });
  const auto res = rt.ExecuteScript("return f()");
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 2);
}

// ========== Userdata Tests ==========

TEST(LuaRuntimeUserdata, CreateUserdataGlobalSetsGlobal) {
  LuaRuntime rt;
  rt.CreateUserdataGlobal("handle", 42);

  // The global should exist and be userdata
  const auto res = rt.ExecuteScript("return type(handle)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "userdata");
}

TEST(LuaRuntimeUserdata, CreateProxyUserdataGlobalSetsGlobal) {
  LuaRuntime rt;
  rt.CreateProxyUserdataGlobal("proxy", 7);

  const auto res = rt.ExecuteScript("return type(proxy)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "userdata");
}

TEST(LuaRuntimeUserdata, OpaqueUserdataReturnHasCorrectRefId) {
  LuaRuntime rt;
  rt.CreateUserdataGlobal("handle", 99);

  const auto res = rt.ExecuteScript("return handle");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);

  const auto& udRef = std::get<LuaUserdataRef>(vals[0]->value);
  EXPECT_EQ(udRef.ref_id, 99);
  EXPECT_FALSE(udRef.opaque);
  EXPECT_FALSE(udRef.proxy);
}

TEST(LuaRuntimeUserdata, ProxyUserdataReturnHasProxyFlag) {
  LuaRuntime rt;
  rt.CreateProxyUserdataGlobal("proxy", 55);

  const auto res = rt.ExecuteScript("return proxy");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);

  const auto& udRef = std::get<LuaUserdataRef>(vals[0]->value);
  EXPECT_EQ(udRef.ref_id, 55);
  EXPECT_FALSE(udRef.opaque);
  EXPECT_TRUE(udRef.proxy);
}

TEST(LuaRuntimeUserdata, RefCountIncrementDecrement) {
  LuaRuntime rt;
  int gc_called_for = -1;
  rt.SetUserdataGCCallback([&](int ref_id) {
    gc_called_for = ref_id;
  });

  rt.IncrementUserdataRefCount(10);
  rt.IncrementUserdataRefCount(10);

  // First decrement - ref count goes from 2 to 1, no callback
  rt.DecrementUserdataRefCount(10);
  EXPECT_EQ(gc_called_for, -1);

  // Second decrement - ref count goes from 1 to 0, callback fires
  rt.DecrementUserdataRefCount(10);
  EXPECT_EQ(gc_called_for, 10);
}

TEST(LuaRuntimeUserdata, GCCallbackNotCalledWithoutCallback) {
  LuaRuntime rt;
  // No GC callback set - should not crash
  rt.IncrementUserdataRefCount(5);
  rt.DecrementUserdataRefCount(5);
  // If we get here without crashing, the test passes
}

TEST(LuaRuntimeUserdata, GCCallbackFiresOnLuaCollection) {
  LuaRuntime rt;
  int gc_ref_id = -1;
  rt.SetUserdataGCCallback([&](int ref_id) {
    gc_ref_id = ref_id;
  });

  rt.CreateUserdataGlobal("handle", 42);
  EXPECT_EQ(gc_ref_id, -1); // Not collected yet

  // Nil the global and force full GC
  (void)rt.ExecuteScript("handle = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);

  EXPECT_EQ(gc_ref_id, 42);
}

TEST(LuaRuntimeUserdata, MultipleRefsSameIdOnlyOneCallback) {
  LuaRuntime rt;
  int gc_count = 0;
  rt.SetUserdataGCCallback([&](int ref_id) {
    if (ref_id == 20) gc_count++;
  });

  // Create two globals with the same ref_id
  rt.CreateUserdataGlobal("a", 20);
  rt.CreateUserdataGlobal("b", 20);

  // Nil one - should not fire callback (ref count still > 0)
  (void)rt.ExecuteScript("a = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);
  EXPECT_EQ(gc_count, 0);

  // Nil the other - should fire callback (ref count reaches 0)
  (void)rt.ExecuteScript("b = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);
  EXPECT_EQ(gc_count, 1);
}

TEST(LuaRuntimeUserdata, PropertyGetterViaIndex) {
  LuaRuntime rt;
  rt.SetPropertyHandlers(
    // Getter: return property values based on key
    [](int ref_id, const std::string& key) -> LuaPtr {
      if (ref_id == 1 && key == "name") {
        return std::make_shared<LuaValue>(LuaValue::from(std::string("Alice")));
      }
      if (ref_id == 1 && key == "age") {
        return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(30)));
      }
      return std::make_shared<LuaValue>(LuaValue::nil());
    },
    nullptr
  );

  rt.CreateProxyUserdataGlobal("obj", 1);

  {
    const auto res = rt.ExecuteScript("return obj.name");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 1u);
    EXPECT_EQ(std::get<std::string>(vals[0]->value), "Alice");
  }
  {
    const auto res = rt.ExecuteScript("return obj.age");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 1u);
    EXPECT_EQ(std::get<int64_t>(vals[0]->value), 30);
  }
  {
    const auto res = rt.ExecuteScript("return obj.missing");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 1u);
    EXPECT_TRUE(std::holds_alternative<std::monostate>(vals[0]->value));
  }
}

TEST(LuaRuntimeUserdata, PropertySetterViaNewIndex) {
  LuaRuntime rt;
  std::string last_key;
  int64_t last_value = 0;
  int setter_ref_id = -1;

  rt.SetPropertyHandlers(
    // Getter (not used here but needed)
    [](int, const std::string&) -> LuaPtr {
      return std::make_shared<LuaValue>(LuaValue::nil());
    },
    // Setter: capture what was written
    [&](int ref_id, const std::string& key, const LuaPtr& value) {
      setter_ref_id = ref_id;
      last_key = key;
      last_value = std::get<int64_t>(value->value);
    }
  );

  rt.CreateProxyUserdataGlobal("obj", 3);

  const auto res = rt.ExecuteScript("obj.score = 100");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(setter_ref_id, 3);
  EXPECT_EQ(last_key, "score");
  EXPECT_EQ(last_value, 100);
}

TEST(LuaRuntimeUserdata, PropertyGetterAndSetterRoundTrip) {
  LuaRuntime rt;
  std::unordered_map<std::string, LuaPtr> store;

  rt.SetPropertyHandlers(
    [&](int, const std::string& key) -> LuaPtr {
      auto it = store.find(key);
      if (it != store.end()) return it->second;
      return std::make_shared<LuaValue>(LuaValue::nil());
    },
    [&](int, const std::string& key, const LuaPtr& value) {
      store[key] = value;
    }
  );

  rt.CreateProxyUserdataGlobal("obj", 1);

  // Write then read back
  const auto res = rt.ExecuteScript(R"(
    obj.x = 42
    obj.y = 'hello'
    return obj.x, obj.y
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "hello");
}

TEST(LuaRuntimeUserdata, OpaqueUserdataCannotBeIndexed) {
  LuaRuntime rt;
  rt.SetPropertyHandlers(
    [](int, const std::string&) -> LuaPtr {
      return std::make_shared<LuaValue>(LuaValue::from(std::string("should not reach")));
    },
    nullptr
  );

  rt.CreateUserdataGlobal("opaque", 1);

  // Attempting to index opaque userdata should error
  const auto res = rt.ExecuteScript("return opaque.name");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
}

TEST(LuaRuntimeUserdata, UserdataPassthroughViaHostFunction) {
  LuaRuntime rt;
  int received_ref_id = -1;

  rt.SetUserdataGCCallback([](int) {});

  rt.RegisterFunction("check", [&](const std::vector<LuaPtr>& args) -> LuaPtr {
    EXPECT_EQ(args.size(), 1u);
    const auto& udRef = std::get<LuaUserdataRef>(args[0]->value);
    received_ref_id = udRef.ref_id;
    // Return it back to Lua
    return args[0];
  });

  rt.CreateUserdataGlobal("handle", 77);

  const auto res = rt.ExecuteScript("return check(handle)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(received_ref_id, 77);

  // The returned value should also be userdata with the same ref_id
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  const auto& udRef = std::get<LuaUserdataRef>(vals[0]->value);
  EXPECT_EQ(udRef.ref_id, 77);
}

TEST(LuaRuntimeUserdata, ProxyUserdataPassthroughPreservesProxyFlag) {
  LuaRuntime rt;

  rt.SetPropertyHandlers(
    [](int, const std::string& key) -> LuaPtr {
      if (key == "val") return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(999)));
      return std::make_shared<LuaValue>(LuaValue::nil());
    },
    nullptr
  );

  rt.RegisterFunction("passthrough", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    const auto& udRef = std::get<LuaUserdataRef>(args[0]->value);
    EXPECT_TRUE(udRef.proxy);
    return args[0];
  });

  rt.CreateProxyUserdataGlobal("proxy", 5);

  // Pass through host function and verify property access still works
  const auto res = rt.ExecuteScript(R"(
    local p = passthrough(proxy)
    return p.val
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 999);
}

TEST(LuaRuntimeUserdata, ForeignUserdataDetectedAsOpaque) {
  LuaRuntime rt;

  // io.tmpfile() creates a userdata with io library's metatable
  const auto res = rt.ExecuteScript("return io.tmpfile()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);

  const auto& udRef = std::get<LuaUserdataRef>(vals[0]->value);
  EXPECT_EQ(udRef.ref_id, -1);     // Not JS-created
  EXPECT_TRUE(udRef.opaque);        // Foreign userdata is opaque
  EXPECT_NE(udRef.registry_ref, LUA_NOREF);  // Has a registry reference
}

TEST(LuaRuntimeUserdata, ForeignUserdataRoundTripViaHostFunction) {
  LuaRuntime rt;

  LuaPtr captured_ud;
  rt.RegisterFunction("capture", [&](const std::vector<LuaPtr>& args) -> LuaPtr {
    captured_ud = args[0];
    return nullptr; // return nil
  });
  rt.RegisterFunction("release", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    return captured_ud;
  });

  // Create a tmpfile, pass to host, get it back, verify it's still usable
  const auto res = rt.ExecuteScript(R"(
    local f = io.tmpfile()
    capture(f)
    local f2 = release()
    f2:write("hello")
    f2:seek("set")
    local content = f2:read("*a")
    f2:close()
    return content
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "hello");
}

TEST(LuaRuntimeUserdata, MultipleUserdataIndependence) {
  // gc_ids must be declared before rt so it outlives the runtime destructor,
  // which fires __gc callbacks during lua_close() for remaining userdata
  std::vector<int> gc_ids;
  LuaRuntime rt;
  rt.SetUserdataGCCallback([&](int ref_id) {
    gc_ids.push_back(ref_id);
  });

  rt.CreateUserdataGlobal("a", 10);
  rt.CreateUserdataGlobal("b", 20);
  rt.CreateUserdataGlobal("c", 30);

  // Nil only 'b'
  (void)rt.ExecuteScript("b = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);

  ASSERT_EQ(gc_ids.size(), 1u);
  EXPECT_EQ(gc_ids[0], 20);

  // 'a' and 'c' should still be accessible
  {
    const auto res = rt.ExecuteScript("return type(a), type(c)");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 2u);
    EXPECT_EQ(std::get<std::string>(vals[0]->value), "userdata");
    EXPECT_EQ(std::get<std::string>(vals[1]->value), "userdata");
  }
}

TEST(LuaRuntimeUserdata, PropertyGetterWithDifferentRefIds) {
  LuaRuntime rt;
  rt.SetPropertyHandlers(
    [](int ref_id, const std::string& key) -> LuaPtr {
      if (key == "id") {
        return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(ref_id)));
      }
      return std::make_shared<LuaValue>(LuaValue::nil());
    },
    nullptr
  );

  rt.CreateProxyUserdataGlobal("obj1", 100);
  rt.CreateProxyUserdataGlobal("obj2", 200);

  const auto res = rt.ExecuteScript("return obj1.id, obj2.id");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 100);
  EXPECT_EQ(std::get<int64_t>(vals[1]->value), 200);
}

TEST(LuaRuntimeUserdata, PropertyGetterExceptionBecomesLuaError) {
  LuaRuntime rt;
  rt.SetPropertyHandlers(
    [](int, const std::string&) -> LuaPtr {
      throw std::runtime_error("access denied");
    },
    nullptr
  );

  rt.CreateProxyUserdataGlobal("obj", 1);

  const auto res = rt.ExecuteScript("return obj.secret");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("access denied"), std::string::npos);
}

TEST(LuaRuntimeUserdata, PropertySetterExceptionBecomesLuaError) {
  LuaRuntime rt;
  rt.SetPropertyHandlers(
    nullptr,
    [](int, const std::string&, const LuaPtr&) {
      throw std::runtime_error("read only");
    }
  );

  rt.CreateProxyUserdataGlobal("obj", 1);

  const auto res = rt.ExecuteScript("obj.value = 42");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("read only"), std::string::npos);
}

TEST(LuaRuntimeUserdata, UserdataStoredInLocalVariable) {
  LuaRuntime rt;
  int gc_ref_id = -1;
  rt.SetUserdataGCCallback([&](int ref_id) {
    gc_ref_id = ref_id;
  });

  rt.CreateUserdataGlobal("handle", 50);

  // Store in local, nil the global - local still holds a reference via Lua's stack
  // After script ends, local goes out of scope and GC should collect
  (void)rt.ExecuteScript(R"(
    local h = handle
    handle = nil
  )");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);

  // The local is gone after the script completes, so GC should collect
  EXPECT_EQ(gc_ref_id, 50);
}

TEST(LuaRuntimeUserdata, NullGCCallbackSafeOnDestruction) {
  // Verify that destroying a runtime with active userdata and a null GC callback
  // doesn't crash (the __gc metamethod fires during lua_close)
  {
    LuaRuntime rt;
    rt.CreateUserdataGlobal("handle", 1);
    // No GC callback set - destruction should be safe
  }
  // If we get here, the test passes
}

TEST(LuaRuntimeUserdata, NullPropertyHandlersSafeOnDestruction) {
  // Verify that destroying a runtime with active proxy userdata and null handlers
  // doesn't crash
  {
    LuaRuntime rt;
    rt.CreateProxyUserdataGlobal("proxy", 1);
    // No property handlers set - destruction should be safe
  }
  // If we get here, the test passes
}

TEST(LuaRuntimeUserdata, DecrementUnknownRefIdIsNoOp) {
  LuaRuntime rt;
  bool callback_fired = false;
  rt.SetUserdataGCCallback([&](int) {
    callback_fired = true;
  });

  // Decrementing a ref_id that was never incremented should not crash or fire callback
  rt.DecrementUserdataRefCount(9999);
  EXPECT_FALSE(callback_fired);
}

int main(int argc, char **argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}