#include <gtest/gtest.h>

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include <limits>

#include "core/lua-runtime.h"

using namespace lua_core;

// Helper to read a field from a value that may be LuaTableRef or LuaTable.
// For LuaTableRef (metatabled table), uses runtime's GetTableField.
// For LuaTable (plain table), uses direct map lookup.
static LuaPtr getField(LuaRuntime& rt, const LuaPtr& val, const std::string& key) {
  if (std::holds_alternative<LuaTableRef>(val->value)) {
    return rt.GetTableField(std::get<LuaTableRef>(val->value).ref, key);
  }
  return std::get<LuaTable>(val->value).at(key);
}

TEST(LuaRuntimeCore, ReturnsNumbersAndStrings) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return 42, 'ok'");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "ok");
}

TEST(LuaRuntimeCore, HandlesBooleansAndNil) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return true, false, nil");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_EQ(std::get<bool>(vals[0]->value), true);
  EXPECT_EQ(std::get<bool>(vals[1]->value), false);
  EXPECT_TRUE(std::holds_alternative<std::monostate>(vals[2]->value));
}

TEST(LuaRuntimeCore, ArraysAndTables) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetGlobal("x", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42))));
  const auto gv = rt.GetGlobal("x");
  ASSERT_NE(gv, nullptr);
  EXPECT_EQ(std::get<int64_t>(gv->value), 42);

  const auto res = rt.ExecuteScript("return x");
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
}

TEST(LuaRuntimeCore, ErrorPropagation) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  auto res = rt.ExecuteScript("error('boom')");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("boom"), std::string::npos);
}

TEST(LuaRuntimeCore, ArrayVsMapDetection) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
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
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return {}");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaArray>(vals[0]->value));
  const auto& arr = std::get<LuaArray>(vals[0]->value);
  EXPECT_TRUE(arr.empty());
}

TEST(LuaRuntimeCore, DeepRecursionCap) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
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
  const LuaRuntime rt(LuaRuntime::AllLibraries());
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
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return math.maxinteger, math.mininteger, 1.5");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), std::numeric_limits<long long>::max());
  EXPECT_EQ(std::get<int64_t>(vals[1]->value), std::numeric_limits<long long>::min());
  EXPECT_DOUBLE_EQ(std::get<double>(vals[2]->value), 1.5);
}

TEST(LuaRuntimeCore, SpecialDoubles) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return math.huge, -math.huge, 0/0");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_TRUE(std::isinf(std::get<double>(vals[0]->value)) && std::get<double>(vals[0]->value) > 0);
  EXPECT_TRUE(std::isinf(std::get<double>(vals[1]->value)) && std::get<double>(vals[1]->value) < 0);
  EXPECT_TRUE(std::isnan(std::get<double>(vals[2]->value)));
}

TEST(LuaRuntimeCore, MultipleReturnsFive) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return 1,2,3,4,5");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 5u);
  for (int i = 0; i < 5; ++i) {
    EXPECT_EQ(std::get<int64_t>(vals[i]->value), i + 1);
  }
}

TEST(LuaRuntimeCore, BinaryAndUtf8Strings) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.RegisterFunction("oops", [](const std::vector<LuaPtr>&) -> LuaPtr {
    throw std::runtime_error("bad things");
  });
  auto res = rt.ExecuteScript("return oops()");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("threw an exception"), std::string::npos);
}

TEST(LuaRuntimeCore, SetGlobalComplexStructures) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.CreateUserdataGlobal("handle", 42);

  // The global should exist and be userdata
  const auto res = rt.ExecuteScript("return type(handle)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "userdata");
}

TEST(LuaRuntimeUserdata, CreateProxyUserdataGlobalSetsGlobal) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.CreateProxyUserdataGlobal("proxy", 7);

  const auto res = rt.ExecuteScript("return type(proxy)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "userdata");
}

TEST(LuaRuntimeUserdata, OpaqueUserdataReturnHasCorrectRefId) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
  // No GC callback set - should not crash
  rt.IncrementUserdataRefCount(5);
  rt.DecrementUserdataRefCount(5);
  // If we get here without crashing, the test passes
}

TEST(LuaRuntimeUserdata, GCCallbackFiresOnLuaCollection) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());

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
  LuaRuntime rt(LuaRuntime::AllLibraries());

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
  LuaRuntime rt(LuaRuntime::AllLibraries());

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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
  LuaRuntime rt(LuaRuntime::AllLibraries());
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
    LuaRuntime rt(LuaRuntime::AllLibraries());
    rt.CreateUserdataGlobal("handle", 1);
    // No GC callback set - destruction should be safe
  }
  // If we get here, the test passes
}

TEST(LuaRuntimeUserdata, NullPropertyHandlersSafeOnDestruction) {
  // Verify that destroying a runtime with active proxy userdata and null handlers
  // doesn't crash
  {
    LuaRuntime rt(LuaRuntime::AllLibraries());
    rt.CreateProxyUserdataGlobal("proxy", 1);
    // No property handlers set - destruction should be safe
  }
  // If we get here, the test passes
}

TEST(LuaRuntimeUserdata, DecrementUnknownRefIdIsNoOp) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool callback_fired = false;
  rt.SetUserdataGCCallback([&](int) {
    callback_fired = true;
  });

  // Decrementing a ref_id that was never incremented should not crash or fire callback
  rt.DecrementUserdataRefCount(9999);
  EXPECT_FALSE(callback_fired);
}

// ========== Metatable Tests ==========

TEST(LuaRuntimeMetatable, StoreHostFunctionDoesNotCreateGlobal) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__hidden_fn", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42)));
  });

  // The function should NOT be accessible as a global
  const auto res = rt.ExecuteScript("return type(__hidden_fn)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "nil");
}

TEST(LuaRuntimeMetatable, StoreHostFunctionIsCallableViaClosure) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_fn", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("stored")));
  });

  // Verify the function is stored in host_functions_ by using it in a metatable
  (void)rt.ExecuteScript("t = {}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = true;
  e.func_name = "__mt_fn";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  const auto res = rt.ExecuteScript("return tostring(t)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "stored");
}

TEST(LuaRuntimeMetatable, SetGlobalMetatableThrowsForNonExistentGlobal) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::vector<MetatableEntry> entries;
  EXPECT_THROW({
    rt.SetGlobalMetatable("nonexistent", entries);
  }, std::runtime_error);

  try {
    rt.SetGlobalMetatable("nonexistent", entries);
  } catch (const std::runtime_error& e) {
    EXPECT_NE(std::string(e.what()).find("does not exist"), std::string::npos);
  }
}

TEST(LuaRuntimeMetatable, SetGlobalMetatableThrowsForNonTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetGlobal("num", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42))));
  std::vector<MetatableEntry> entries;
  EXPECT_THROW({
    rt.SetGlobalMetatable("num", entries);
  }, std::runtime_error);

  try {
    rt.SetGlobalMetatable("num", entries);
  } catch (const std::runtime_error& e) {
    EXPECT_NE(std::string(e.what()).find("not a table"), std::string::npos);
  }
}

TEST(LuaRuntimeMetatable, SetGlobalMetatableThrowsForStringGlobal) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetGlobal("s", std::make_shared<LuaValue>(LuaValue::from(std::string("hello"))));
  std::vector<MetatableEntry> entries;
  EXPECT_THROW({
    rt.SetGlobalMetatable("s", entries);
  }, std::runtime_error);
}

TEST(LuaRuntimeMetatable, SetGlobalMetatableThrowsForBoolGlobal) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetGlobal("b", std::make_shared<LuaValue>(LuaValue::from(true)));
  std::vector<MetatableEntry> entries;
  EXPECT_THROW({
    rt.SetGlobalMetatable("b", entries);
  }, std::runtime_error);
}

TEST(LuaRuntimeMetatable, ToStringMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_tostring", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("custom_repr")));
  });

  (void)rt.ExecuteScript("obj = {x = 10}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = true;
  e.func_name = "__mt_tostring";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("obj", entries);

  const auto res = rt.ExecuteScript("return tostring(obj)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "custom_repr");
}

TEST(LuaRuntimeMetatable, ToStringReceivesTableArg) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_ts", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    EXPECT_EQ(args.size(), 1u);
    auto x = std::get<int64_t>(getField(rt, args[0], "x")->value);
    return std::make_shared<LuaValue>(LuaValue::from(std::string("x=" + std::to_string(x))));
  });

  (void)rt.ExecuteScript("obj = {x = 7}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = true;
  e.func_name = "__mt_ts";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("obj", entries);

  const auto res = rt.ExecuteScript("return tostring(obj)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "x=7");
}

TEST(LuaRuntimeMetatable, AddMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_add", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "value")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "value")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va + vb));
  });

  (void)rt.ExecuteScript("a = {value = 10}; b = {value = 20}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__add";
  e.is_function = true;
  e.func_name = "__mt_add";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a + b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 30);
}

TEST(LuaRuntimeMetatable, SubMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_sub", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "v")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va - vb));
  });

  (void)rt.ExecuteScript("a = {v = 30}; b = {v = 8}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__sub";
  e.is_function = true;
  e.func_name = "__mt_sub";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a - b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 22);
}

TEST(LuaRuntimeMetatable, MulMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_mul", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "v")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va * vb));
  });

  (void)rt.ExecuteScript("a = {v = 5}; b = {v = 7}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__mul";
  e.is_function = true;
  e.func_name = "__mt_mul";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a * b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 35);
}

TEST(LuaRuntimeMetatable, DivMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_div", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    double va = static_cast<double>(std::get<int64_t>(getField(rt, args[0], "v")->value));
    double vb = static_cast<double>(std::get<int64_t>(getField(rt, args[1], "v")->value));
    return std::make_shared<LuaValue>(LuaValue::from(va / vb));
  });

  (void)rt.ExecuteScript("a = {v = 20}; b = {v = 4}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__div";
  e.is_function = true;
  e.func_name = "__mt_div";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a / b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_DOUBLE_EQ(std::get<double>(std::get<std::vector<LuaPtr>>(res)[0]->value), 5.0);
}

TEST(LuaRuntimeMetatable, UnmMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_unm", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t v = std::get<int64_t>(getField(rt, args[0], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(-v));
  });

  (void)rt.ExecuteScript("a = {v = 42}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__unm";
  e.is_function = true;
  e.func_name = "__mt_unm";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return -a");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), -42);
}

TEST(LuaRuntimeMetatable, ModMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_mod", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "v")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va % vb));
  });

  (void)rt.ExecuteScript("a = {v = 17}; b = {v = 5}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__mod";
  e.is_function = true;
  e.func_name = "__mt_mod";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a % b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
}

TEST(LuaRuntimeMetatable, ConcatMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_concat", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    std::string sa = std::get<std::string>(getField(rt, args[0], "t")->value);
    std::string sb = std::get<std::string>(getField(rt, args[1], "t")->value);
    return std::make_shared<LuaValue>(LuaValue::from(sa + sb));
  });

  (void)rt.ExecuteScript("a = {t = 'hello'}; b = {t = ' world'}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__concat";
  e.is_function = true;
  e.func_name = "__mt_concat";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a .. b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "hello world");
}

TEST(LuaRuntimeMetatable, LenMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_len", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t n = std::get<int64_t>(getField(rt, args[0], "count")->value);
    return std::make_shared<LuaValue>(LuaValue::from(n));
  });

  (void)rt.ExecuteScript("a = {count = 5}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__len";
  e.is_function = true;
  e.func_name = "__mt_len";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return #a");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 5);
}

TEST(LuaRuntimeMetatable, EqMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_eq", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "id")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "id")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va == vb));
  });

  (void)rt.ExecuteScript("a = {id = 1}; b = {id = 1}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__eq";
  e.is_function = true;
  e.func_name = "__mt_eq";
  entries.push_back(std::move(e));
  // Both tables need the same metamethod for __eq to fire
  rt.SetGlobalMetatable("a", entries);
  rt.SetGlobalMetatable("b", entries);

  const auto res = rt.ExecuteScript("return a == b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<bool>(std::get<std::vector<LuaPtr>>(res)[0]->value), true);
}

TEST(LuaRuntimeMetatable, LtMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_lt", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "v")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va < vb));
  });

  (void)rt.ExecuteScript("a = {v = 1}; b = {v = 2}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__lt";
  e.is_function = true;
  e.func_name = "__mt_lt";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);
  rt.SetGlobalMetatable("b", entries);

  {
    const auto res = rt.ExecuteScript("return a < b");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<bool>(std::get<std::vector<LuaPtr>>(res)[0]->value), true);
  }
  {
    const auto res = rt.ExecuteScript("return b < a");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<bool>(std::get<std::vector<LuaPtr>>(res)[0]->value), false);
  }
}

TEST(LuaRuntimeMetatable, LeMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_le", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t va = std::get<int64_t>(getField(rt, args[0], "v")->value);
    int64_t vb = std::get<int64_t>(getField(rt, args[1], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(va <= vb));
  });

  (void)rt.ExecuteScript("a = {v = 3}; b = {v = 3}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__le";
  e.is_function = true;
  e.func_name = "__mt_le";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);
  rt.SetGlobalMetatable("b", entries);

  const auto res = rt.ExecuteScript("return a <= b");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<bool>(std::get<std::vector<LuaPtr>>(res)[0]->value), true);
}

TEST(LuaRuntimeMetatable, CallMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_call", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    // args[0] is the table itself, args[1] is the argument passed in the call
    int64_t factor = std::get<int64_t>(getField(rt, args[0], "factor")->value);
    int64_t x = std::get<int64_t>(args[1]->value);
    return std::make_shared<LuaValue>(LuaValue::from(factor * x));
  });

  (void)rt.ExecuteScript("obj = {factor = 10}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__call";
  e.is_function = true;
  e.func_name = "__mt_call";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("obj", entries);

  const auto res = rt.ExecuteScript("return obj(5)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 50);
}

TEST(LuaRuntimeMetatable, IndexAsFunction) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_index", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    // args[0] = table, args[1] = key
    std::string key = std::get<std::string>(args[1]->value);
    return std::make_shared<LuaValue>(LuaValue::from(std::string("default_" + key)));
  });

  (void)rt.ExecuteScript("obj = {}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__index";
  e.is_function = true;
  e.func_name = "__mt_index";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("obj", entries);

  const auto res = rt.ExecuteScript("return obj.foo");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "default_foo");
}

TEST(LuaRuntimeMetatable, IndexAsTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  (void)rt.ExecuteScript("obj = {}");
  LuaTable fallback;
  fallback.emplace("fallback_key", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(99))));

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__index";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::move(fallback)));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("obj", entries);

  const auto res = rt.ExecuteScript("return obj.fallback_key");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 99);
}

TEST(LuaRuntimeMetatable, NewIndexAsFunction) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::string captured_key;
  int64_t captured_value = 0;

  rt.StoreHostFunction("__mt_newindex", [&](const std::vector<LuaPtr>& args) -> LuaPtr {
    captured_key = std::get<std::string>(args[1]->value);
    captured_value = std::get<int64_t>(args[2]->value);
    return nullptr;
  });

  (void)rt.ExecuteScript("obj = {}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__newindex";
  e.is_function = true;
  e.func_name = "__mt_newindex";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("obj", entries);

  (void)rt.ExecuteScript("obj.x = 42");
  EXPECT_EQ(captured_key, "x");
  EXPECT_EQ(captured_value, 42);

  // rawget should return nil since __newindex intercepted it
  const auto res = rt.ExecuteScript("return rawget(obj, 'x')");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_TRUE(std::holds_alternative<std::monostate>(std::get<std::vector<LuaPtr>>(res)[0]->value));
}

TEST(LuaRuntimeMetatable, MultipleMetamethods) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_ts", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t v = std::get<int64_t>(getField(rt, args[0], "v")->value);
    return std::make_shared<LuaValue>(LuaValue::from(std::string("val:" + std::to_string(v))));
  });
  rt.StoreHostFunction("__mt_add", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(
      std::get<int64_t>(getField(rt, args[0], "v")->value) +
      std::get<int64_t>(getField(rt, args[1], "v")->value)));
  });
  rt.StoreHostFunction("__mt_unm", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(
      -std::get<int64_t>(getField(rt, args[0], "v")->value)));
  });

  (void)rt.ExecuteScript("a = {v = 10}; b = {v = 3}");

  std::vector<MetatableEntry> entries;
  {
    MetatableEntry e;
    e.key = "__tostring";
    e.is_function = true;
    e.func_name = "__mt_ts";
    entries.push_back(std::move(e));
  }
  {
    MetatableEntry e;
    e.key = "__add";
    e.is_function = true;
    e.func_name = "__mt_add";
    entries.push_back(std::move(e));
  }
  {
    MetatableEntry e;
    e.key = "__unm";
    e.is_function = true;
    e.func_name = "__mt_unm";
    entries.push_back(std::move(e));
  }
  rt.SetGlobalMetatable("a", entries);

  {
    const auto res = rt.ExecuteScript("return a + b");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 13);
  }
  {
    const auto res = rt.ExecuteScript("return tostring(a)");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "val:10");
  }
  {
    const auto res = rt.ExecuteScript("return -a");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), -10);
  }
}

TEST(LuaRuntimeMetatable, MetatableOnLuaCreatedTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_ts", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t x = std::get<int64_t>(getField(rt, args[0], "x")->value);
    int64_t y = std::get<int64_t>(getField(rt, args[0], "y")->value);
    return std::make_shared<LuaValue>(LuaValue::from(
      std::string("(" + std::to_string(x) + "," + std::to_string(y) + ")")));
  });

  (void)rt.ExecuteScript("point = {x = 5, y = 10}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = true;
  e.func_name = "__mt_ts";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("point", entries);

  const auto res = rt.ExecuteScript("return tostring(point)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "(5,10)");
}

TEST(LuaRuntimeMetatable, EmptyMetatableEntriesDoesNotCrash) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {x = 1}");
  std::vector<MetatableEntry> entries; // empty
  rt.SetGlobalMetatable("t", entries);

  // Table should still work normally
  const auto res = rt.ExecuteScript("return t.x");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 1);
}

TEST(LuaRuntimeMetatable, MetatableExceptionInHostFunction) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_bad", [](const std::vector<LuaPtr>&) -> LuaPtr {
    throw std::runtime_error("metamethod error");
  });

  (void)rt.ExecuteScript("a = {v = 1}; b = {v = 2}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__add";
  e.is_function = true;
  e.func_name = "__mt_bad";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("a", entries);

  const auto res = rt.ExecuteScript("return a + b");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("metamethod error"), std::string::npos);
}

TEST(LuaRuntimeMetatable, StackBalanceAfterSetGlobalMetatable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_ts", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("ok")));
  });

  (void)rt.ExecuteScript("t = {}");
  int top_before = lua_gettop(rt.RawState());

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = true;
  e.func_name = "__mt_ts";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  int top_after = lua_gettop(rt.RawState());
  EXPECT_EQ(top_before, top_after);
}

TEST(LuaRuntimeMetatable, StackBalanceAfterFailedSetGlobalMetatable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int top_before = lua_gettop(rt.RawState());

  std::vector<MetatableEntry> entries;
  try {
    rt.SetGlobalMetatable("nonexistent", entries);
  } catch (...) {
    // expected
  }

  int top_after = lua_gettop(rt.RawState());
  EXPECT_EQ(top_before, top_after);
}

TEST(LuaRuntimeMetatable, MetatableWithStaticValue) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__metatable";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("protected")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  // getmetatable returns __metatable value when set
  const auto res = rt.ExecuteScript("return getmetatable(t)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "protected");
}

TEST(LuaRuntimeMetatable, ReplacingMetatable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_ts1", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("first")));
  });
  rt.StoreHostFunction("__mt_ts2", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("second")));
  });

  (void)rt.ExecuteScript("t = {}");

  // Set first metatable
  {
    std::vector<MetatableEntry> entries;
    MetatableEntry e;
    e.key = "__tostring";
    e.is_function = true;
    e.func_name = "__mt_ts1";
    entries.push_back(std::move(e));
    rt.SetGlobalMetatable("t", entries);
  }

  {
    const auto res = rt.ExecuteScript("return tostring(t)");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "first");
  }

  // Replace with second metatable
  {
    std::vector<MetatableEntry> entries;
    MetatableEntry e;
    e.key = "__tostring";
    e.is_function = true;
    e.func_name = "__mt_ts2";
    entries.push_back(std::move(e));
    rt.SetGlobalMetatable("t", entries);
  }

  {
    const auto res = rt.ExecuteScript("return tostring(t)");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "second");
  }
}

// ========== Table Reference Tests ==========

TEST(LuaRuntimeTableRef, ToLuaValueProducesTableRefForMetatabled) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {x = 1}");

  // Set a metatable on t
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("custom")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto result = rt.GetGlobal("t");
  ASSERT_NE(result, nullptr);
  EXPECT_TRUE(std::holds_alternative<LuaTableRef>(result->value));
}

TEST(LuaRuntimeTableRef, ToLuaValueProducesTableForPlain) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  // Plain table (no metatable) should still be LuaTable/LuaArray
  {
    const auto res = rt.ExecuteScript("return {a = 1, b = 2}");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 1u);
    EXPECT_TRUE(std::holds_alternative<LuaTable>(vals[0]->value));
  }
  {
    const auto res = rt.ExecuteScript("return {1, 2, 3}");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
    const auto& vals = std::get<std::vector<LuaPtr>>(res);
    ASSERT_EQ(vals.size(), 1u);
    EXPECT_TRUE(std::holds_alternative<LuaArray>(vals[0]->value));
  }
}

TEST(LuaRuntimeTableRef, PushLuaValueRoundTrips) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {x = 42}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("T")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  // Get the table ref
  auto ref = rt.GetGlobal("t");
  ASSERT_TRUE(std::holds_alternative<LuaTableRef>(ref->value));

  // Push it back as a global and read from Lua
  rt.SetGlobal("t2", ref);
  const auto res = rt.ExecuteScript("return t2.x");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 42);
}

TEST(LuaRuntimeTableRef, GetTableFieldBasicRead) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {x = 10, y = 'hello'}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("T")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  auto xVal = rt.GetTableField(tableRef.ref, "x");
  EXPECT_EQ(std::get<int64_t>(xVal->value), 10);

  auto yVal = rt.GetTableField(tableRef.ref, "y");
  EXPECT_EQ(std::get<std::string>(yVal->value), "hello");

  auto nilVal = rt.GetTableField(tableRef.ref, "missing");
  EXPECT_TRUE(std::holds_alternative<std::monostate>(nilVal->value));
}

TEST(LuaRuntimeTableRef, GetTableFieldTriggersIndex) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_index", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    std::string key = std::get<std::string>(args[1]->value);
    return std::make_shared<LuaValue>(LuaValue::from(std::string("indexed_" + key)));
  });

  (void)rt.ExecuteScript("t = {}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__index";
  e.is_function = true;
  e.func_name = "__mt_index";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  auto val = rt.GetTableField(tableRef.ref, "foo");
  EXPECT_EQ(std::get<std::string>(val->value), "indexed_foo");
}

TEST(LuaRuntimeTableRef, SetTableFieldTriggersNewindex) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::string captured_key;
  int64_t captured_value = 0;

  rt.StoreHostFunction("__mt_newindex", [&](const std::vector<LuaPtr>& args) -> LuaPtr {
    captured_key = std::get<std::string>(args[1]->value);
    captured_value = std::get<int64_t>(args[2]->value);
    return nullptr;
  });

  (void)rt.ExecuteScript("t = {}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__newindex";
  e.is_function = true;
  e.func_name = "__mt_newindex";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  auto val = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(99)));
  rt.SetTableField(tableRef.ref, "mykey", val);

  EXPECT_EQ(captured_key, "mykey");
  EXPECT_EQ(captured_value, 99);
}

TEST(LuaRuntimeTableRef, HasTableFieldBasicCheck) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {x = 1}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("T")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  EXPECT_TRUE(rt.HasTableField(tableRef.ref, "x"));
  EXPECT_FALSE(rt.HasTableField(tableRef.ref, "nonexistent"));
}

TEST(LuaRuntimeTableRef, GetTableKeysReturnsAllKeys) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {a = 1, b = 2, c = 3}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("T")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  auto keys = rt.GetTableKeys(tableRef.ref);
  std::sort(keys.begin(), keys.end());
  ASSERT_EQ(keys.size(), 3u);
  EXPECT_EQ(keys[0], "a");
  EXPECT_EQ(keys[1], "b");
  EXPECT_EQ(keys[2], "c");
}

TEST(LuaRuntimeTableRef, GetTableLengthBasic) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {10, 20, 30}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("T")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  EXPECT_EQ(rt.GetTableLength(tableRef.ref), 3);
}

TEST(LuaRuntimeTableRef, GetTableLengthWithMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mt_len", [&rt](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t n = std::get<int64_t>(getField(rt, args[0], "count")->value);
    return std::make_shared<LuaValue>(LuaValue::from(n));
  });

  (void)rt.ExecuteScript("t = {count = 42}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__len";
  e.is_function = true;
  e.func_name = "__mt_len";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  EXPECT_EQ(rt.GetTableLength(tableRef.ref), 42);
}

TEST(LuaRuntimeTableRef, IntegerKeyHandling) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = {10, 20, 30}");

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__tostring";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("T")));
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  auto ref = rt.GetGlobal("t");
  const auto& tableRef = std::get<LuaTableRef>(ref->value);

  // Integer keys via string representation
  auto v1 = rt.GetTableField(tableRef.ref, "1");
  EXPECT_EQ(std::get<int64_t>(v1->value), 10);
  auto v2 = rt.GetTableField(tableRef.ref, "2");
  EXPECT_EQ(std::get<int64_t>(v2->value), 20);
  auto v3 = rt.GetTableField(tableRef.ref, "3");
  EXPECT_EQ(std::get<int64_t>(v3->value), 30);

  // Set via integer key
  auto newVal = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(99)));
  rt.SetTableField(tableRef.ref, "2", newVal);
  auto updated = rt.GetTableField(tableRef.ref, "2");
  EXPECT_EQ(std::get<int64_t>(updated->value), 99);
}

// --- File Execution ---

// Helper to write a temporary Lua file for testing
class LuaFileTest : public ::testing::Test {
protected:
  std::string tmp_path_;

  void WriteFile(const std::string& content) {
    std::string tpl = (std::filesystem::temp_directory_path() / "lua_test_XXXXXX").string();
    int fd = mkstemp(tpl.data());
    close(fd);
    tmp_path_ = tpl + ".lua";
    std::rename(tpl.c_str(), tmp_path_.c_str());
    std::ofstream ofs(tmp_path_);
    ofs << content;
    ofs.close();
  }

  void TearDown() override {
    if (!tmp_path_.empty()) {
      std::remove(tmp_path_.c_str());
    }
  }
};

TEST_F(LuaFileTest, ExecuteFileReturnsValues) {
  WriteFile("return 42, 'hello'");
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile(tmp_path_);
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 42);
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "hello");
}

TEST_F(LuaFileTest, ExecuteFileReturnsTable) {
  WriteFile("return { x = 10, y = 20 }");
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile(tmp_path_);
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  const auto& tbl = std::get<LuaTable>(vals[0]->value);
  EXPECT_EQ(std::get<int64_t>(tbl.at("x")->value), 10);
  EXPECT_EQ(std::get<int64_t>(tbl.at("y")->value), 20);
}

TEST_F(LuaFileTest, ExecuteFileSetsGlobals) {
  WriteFile("my_global = 'from file'");
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile(tmp_path_);
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  auto val = rt.GetGlobal("my_global");
  EXPECT_EQ(std::get<std::string>(val->value), "from file");
}

TEST_F(LuaFileTest, ExecuteFileWithCallbacks) {
  WriteFile("return add(3, 4)");
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.RegisterFunction("add", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    auto a = std::get<int64_t>(args[0]->value);
    auto b = std::get<int64_t>(args[1]->value);
    return std::make_shared<LuaValue>(LuaValue::from(a + b));
  });
  const auto res = rt.ExecuteFile(tmp_path_);
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 7);
}

TEST_F(LuaFileTest, ExecuteFileNotFound) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile("/nonexistent/path/to/file.lua");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  const auto& err = std::get<std::string>(res);
  EXPECT_NE(err.find("cannot open"), std::string::npos);
}

TEST_F(LuaFileTest, ExecuteFileSyntaxError) {
  WriteFile("this is not valid lua");
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile(tmp_path_);
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
}

TEST_F(LuaFileTest, ExecuteFileEmptyPath) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile("");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_EQ(std::get<std::string>(res), "File path cannot be empty");
}

TEST_F(LuaFileTest, ExecuteFileNoReturnValue) {
  WriteFile("local x = 42");
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteFile(tmp_path_);
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_TRUE(std::get<std::vector<LuaPtr>>(res).empty());
}

// --- Standard Library Loading ---

TEST(LuaRuntimeLibraries, BareStateByDefault) {
  const LuaRuntime rt;
  // Basic Lua works without any libraries
  const auto res = rt.ExecuteScript("return 1 + 2");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 3);
  // Standard library functions are not available
  const auto res2 = rt.ExecuteScript("return math.floor(3.7)");
  ASSERT_TRUE(std::holds_alternative<std::string>(res2));
}

TEST(LuaRuntimeLibraries, AllLibsViaHelper) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.ExecuteScript("return math.floor(3.7)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 3);
  const auto res2 = rt.ExecuteScript("return string.upper('hello')");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res2)[0]->value), "HELLO");
  const auto res3 = rt.ExecuteScript("return type(io)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res3));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res3)[0]->value), "table");
}

TEST(LuaRuntimeLibraries, SafeLibsViaHelper) {
  const LuaRuntime rt(LuaRuntime::SafeLibraries());
  // Safe libs should be available
  const auto res = rt.ExecuteScript("return math.floor(3.7)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 3);
  const auto res2 = rt.ExecuteScript("return string.upper('hello')");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res2)[0]->value), "HELLO");
  // Dangerous libs should NOT be available
  const auto res3 = rt.ExecuteScript("return type(io)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res3));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res3)[0]->value), "nil");
  const auto res4 = rt.ExecuteScript("return type(os)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res4));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res4)[0]->value), "nil");
  const auto res5 = rt.ExecuteScript("return type(debug)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res5));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res5)[0]->value), "nil");
}

TEST(LuaRuntimeLibraries, SelectiveLoading) {
  const LuaRuntime rt(std::vector<std::string>{"base", "math"});
  const auto res = rt.ExecuteScript("return math.floor(3.7)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 3);
  const auto res2 = rt.ExecuteScript("return type(string)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res2)[0]->value), "nil");
}

TEST(LuaRuntimeLibraries, EmptyLibrariesCreatesBareState) {
  const LuaRuntime rt(std::vector<std::string>{});
  const auto res = rt.ExecuteScript("return 1 + 2");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 3);
}

TEST(LuaRuntimeLibraries, UnknownLibraryThrows) {
  EXPECT_THROW({
    LuaRuntime rt(std::vector<std::string>{"nonexistent"});
  }, std::runtime_error);
}

TEST(LuaRuntimeLibraries, UnknownLibraryErrorMessage) {
  try {
    LuaRuntime rt(std::vector<std::string>{"fakename"});
    FAIL() << "Expected std::runtime_error";
  } catch (const std::runtime_error& e) {
    EXPECT_NE(std::string(e.what()).find("Unknown Lua library"), std::string::npos);
    EXPECT_NE(std::string(e.what()).find("fakename"), std::string::npos);
  }
}

TEST(LuaRuntimeLibraries, OmittedLibsNotAvailable) {
  const LuaRuntime rt(std::vector<std::string>{"base", "string"});
  const auto res = rt.ExecuteScript("return type(math)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "nil");
  const auto res2 = rt.ExecuteScript("return type(io)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res2)[0]->value), "nil");
}

TEST(LuaRuntimeLibraries, HostFunctionsWorkWithSelectiveLibs) {
  LuaRuntime rt(std::vector<std::string>{"base"});
  rt.RegisterFunction("double_it", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    auto n = std::get<int64_t>(args[0]->value);
    return std::make_shared<LuaValue>(LuaValue::from(n * 2));
  });
  const auto res = rt.ExecuteScript("return double_it(21)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 42);
}

// ============================================
// ASYNC MODE
// ============================================

TEST(LuaRuntimeAsync, AsyncModeFlagDefaultsOff) {
  const LuaRuntime rt;
  EXPECT_FALSE(rt.IsAsyncMode());
}

TEST(LuaRuntimeAsync, AsyncModeBlocksHostFunctions) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.RegisterFunction("greet", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("hello")));
  });

  // Works normally
  auto res = rt.ExecuteScript("return greet()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "hello");

  // Blocked in async mode
  rt.SetAsyncMode(true);
  auto res2 = rt.ExecuteScript("return greet()");
  ASSERT_TRUE(std::holds_alternative<std::string>(res2));
  EXPECT_NE(std::get<std::string>(res2).find("async mode"), std::string::npos);

  // Works again after clearing
  rt.SetAsyncMode(false);
  auto res3 = rt.ExecuteScript("return greet()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res3));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res3)[0]->value), "hello");
}

TEST(LuaRuntimeAsync, PureLuaWorksInAsyncMode) {
  LuaRuntime rt;
  rt.SetAsyncMode(true);
  auto res = rt.ExecuteScript("return 6 * 7");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 42);
  rt.SetAsyncMode(false);
}

TEST(LuaRuntimeAsync, StdlibWorksInAsyncMode) {
  LuaRuntime rt(std::vector<std::string>{"base", "string"});
  rt.SetAsyncMode(true);
  auto res = rt.ExecuteScript("return string.upper('hello')");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value), "HELLO");
  rt.SetAsyncMode(false);
}

int main(int argc, char **argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}