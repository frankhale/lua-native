#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <thread>

#include "core/lua-runtime.h"

using namespace lua_core;

// Resolves a repo-relative path (e.g. "tests/fixtures/x.lua") regardless of the
// directory the test binary was launched from. Running the binary directly out
// of build/Debug (an IDE run) would otherwise fail these tests with a confusing
// "file not found" instead of exercising the feature (F9).
static std::string RepoPath(const std::string& rel) {
  namespace fs = std::filesystem;
  fs::path dir = fs::current_path();
  for (int i = 0; i < 8; ++i) {
    if (fs::exists(dir / "tests" / "fixtures")) return (dir / rel).string();
    if (!dir.has_parent_path() || dir.parent_path() == dir) break;
    dir = dir.parent_path();
  }
  return rel;  // fall back to the literal path
}

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

TEST(LuaRuntimeCore, SetGlobalPathAutoCreatesIntermediates) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetGlobalPath({"config", "db", "host"},
                   std::make_shared<LuaValue>(LuaValue::from(std::string("localhost"))));
  const auto res = rt.ExecuteScript("return config.db.host, type(config), type(config.db)");
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "localhost");
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "table");
  EXPECT_EQ(std::get<std::string>(vals[2]->value), "table");
}

TEST(LuaRuntimeCore, SetGlobalPathPreservesSiblings) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("config = { db = { host = 'a', port = 1 } }");
  rt.SetGlobalPath({"config", "db", "host"},
                   std::make_shared<LuaValue>(LuaValue::from(std::string("b"))));
  const auto res = rt.ExecuteScript("return config.db.host, config.db.port");
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "b");
  EXPECT_EQ(std::get<int64_t>(vals[1]->value), 1);
}

TEST(LuaRuntimeCore, SetGlobalPathThrowsOnNonTableIntermediate) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetGlobal("config", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(5))));
  EXPECT_THROW(
      rt.SetGlobalPath({"config", "db"},
                       std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)))),
      std::runtime_error);
}

TEST(LuaRuntimeCore, GetGlobalPathReadsNested) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("config = { db = { host = 'localhost', port = 5432 } }");
  const auto host = rt.GetGlobalPath({"config", "db", "host"});
  ASSERT_NE(host, nullptr);
  EXPECT_EQ(std::get<std::string>(host->value), "localhost");
  const auto port = rt.GetGlobalPath({"config", "db", "port"});
  EXPECT_EQ(std::get<int64_t>(port->value), 5432);
}

TEST(LuaRuntimeCore, GetGlobalPathNilShortCircuits) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("config = {}");
  // Missing leaf and missing intermediate both yield nil (monostate), no throw.
  const auto missingLeaf = rt.GetGlobalPath({"config", "db", "host"});
  ASSERT_NE(missingLeaf, nullptr);
  EXPECT_TRUE(std::holds_alternative<std::monostate>(missingLeaf->value));
  const auto missingRoot = rt.GetGlobalPath({"nope", "db", "host"});
  ASSERT_NE(missingRoot, nullptr);
  EXPECT_TRUE(std::holds_alternative<std::monostate>(missingRoot->value));
}

TEST(LuaRuntimeCore, GetGlobalPathThrowsOnNonIndexableIntermediate) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("config = { db = 5 }");  // db is a number
  EXPECT_THROW((void)rt.GetGlobalPath({"config", "db", "host"}), std::runtime_error);
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

// Every "throws with this message" assertion in this file, and every error the
// binding forwards to JS, rests on one std::exception guarantee: the message is
// deep-copied at construction, so what() outlives the std::string it came from.
//
// That guarantee is a *build* property, not a language one. MSVC honours it only
// when _HAS_EXCEPTIONS is 1; with 0 the STL substitutes an exception class that
// stores the pointer, and what() dangles the moment the source string is
// destroyed during unwinding. node's common.gypi defines _HAS_EXCEPTIONS=0 for
// every addon target, so binding.gyp has to override it (see the Windows blocks
// there) — and if that override is ever dropped, ~70 tests across the C++ and
// TS suites start comparing against freed heap instead of text.
//
// This test states the invariant directly, so the cause is named in one line
// rather than inferred from a wall of garbled diffs. It is trivially true on
// libc++/libstdc++ and is aimed at the Windows build.
TEST(ExceptionMessageLifetime, WhatOutlivesTheSourceString) {
  const std::string original = "message that must survive unwinding intact";
  try {
    // Scoped so the source string is destroyed before what() is read — the
    // exact sequence that produced 0xDD fill bytes under _HAS_EXCEPTIONS=0.
    std::string transient = original;
    throw std::runtime_error(transient);
  } catch (const std::runtime_error& e) {
    EXPECT_EQ(std::string(e.what()), original);
  }
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
    FAIL() << "expected SetGlobalMetatable to throw";
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
    FAIL() << "expected SetGlobalMetatable to throw";
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

// M4 remainder: a raising __index/__newindex on the _G metatable reached
// through RegisterFunction / GetGlobalRef / SetGlobalMetatable / AddSearchPath
// must surface as a caught std::runtime_error, not an unprotected panic/abort.
TEST(LuaRuntimeProtectedGlobals, RegisterFunctionSurvivesRaisingNewindexOnG) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript(
    "setmetatable(_G, { __newindex = function() error('no writes') end })");
  EXPECT_THROW({
    rt.RegisterFunction("f", [](const std::vector<LuaPtr>&) -> LuaPtr {
      return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)));
    });
  }, std::runtime_error);
  // The runtime is still usable afterwards (stack was restored, no abort).
  (void)rt.ExecuteScript("setmetatable(_G, nil)");
  rt.RegisterFunction("g", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(2)));
  });
  const auto res = rt.ExecuteScript("return g()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
}

TEST(LuaRuntimeProtectedGlobals, GetGlobalRefSurvivesRaisingIndexOnG) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript(
    "setmetatable(_G, { __index = function() error('trap') end })");
  EXPECT_THROW({ (void)rt.GetGlobalRef("definitely_missing"); },
              std::runtime_error);
}

TEST(LuaRuntimeProtectedGlobals, SetGlobalMetatableSurvivesRaisingIndexOnG) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript(
    "setmetatable(_G, { __index = function() error('trap') end })");
  std::vector<MetatableEntry> entries;
  EXPECT_THROW({ rt.SetGlobalMetatable("definitely_missing", entries); },
              std::runtime_error);
}

TEST(LuaRuntimeProtectedGlobals, AddSearchPathSurvivesRaisingIndexOnG) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  // Remove package so the protected _G["package"] lookup hits __index.
  (void)rt.ExecuteScript(
    "package = nil "
    "setmetatable(_G, { __index = function() error('trap') end })");
  EXPECT_THROW({ rt.AddSearchPath("/tmp/?.lua"); }, std::runtime_error);
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
    // Portable unique name (mkstemp/unistd.h is POSIX-only and would not
    // compile for the Windows target). A per-process counter plus the pid-like
    // address entropy of the counter itself is enough: these files live only
    // for the duration of one test.
    static std::atomic<unsigned> counter{0};
    const auto name = "lua_test_" + std::to_string(counter++) + "_" +
                      std::to_string(
                          std::hash<std::string>{}(
                              ::testing::UnitTest::GetInstance()->current_test_info()->name())) +
                      ".lua";
    tmp_path_ = (std::filesystem::temp_directory_path() / name).string();
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

// ========== Module / Require Tests ==========

TEST(LuaRuntimeModule, AddSearchPathAppendsToPackagePath) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.AddSearchPath("./modules/?.lua");

  const auto res = rt.ExecuteScript("return package.path");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  const auto& path = std::get<std::string>(vals[0]->value);
  EXPECT_NE(path.find("./modules/?.lua"), std::string::npos);
}

TEST(LuaRuntimeModule, AddSearchPathMultiplePaths) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.AddSearchPath("./a/?.lua");
  rt.AddSearchPath("./b/?.lua");

  const auto res = rt.ExecuteScript("return package.path");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& path = std::get<std::string>(std::get<std::vector<LuaPtr>>(res)[0]->value);
  EXPECT_NE(path.find("./a/?.lua"), std::string::npos);
  EXPECT_NE(path.find("./b/?.lua"), std::string::npos);
}

TEST(LuaRuntimeModule, AddSearchPathThrowsWithoutPackageLib) {
  const LuaRuntime rt(std::vector<std::string>{"base"});
  EXPECT_THROW({
    rt.AddSearchPath("./modules/?.lua");
  }, std::runtime_error);

  try {
    rt.AddSearchPath("./modules/?.lua");
    FAIL() << "expected AddSearchPath to throw";
  } catch (const std::runtime_error& e) {
    EXPECT_NE(std::string(e.what()).find("package"), std::string::npos);
  }
}

TEST(LuaRuntimeModule, AddSearchPathStackBalance) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int top_before = lua_gettop(rt.RawState());
  rt.AddSearchPath("./test/?.lua");
  int top_after = lua_gettop(rt.RawState());
  EXPECT_EQ(top_before, top_after);
}

TEST(LuaRuntimeModule, RegisterModuleTableWithFunctions) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mod_add", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    int64_t a = std::get<int64_t>(args[0]->value);
    int64_t b = std::get<int64_t>(args[1]->value);
    return std::make_shared<LuaValue>(LuaValue::from(a + b));
  });

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "add";
  e.is_function = true;
  e.func_name = "__mod_add";
  entries.push_back(std::move(e));
  rt.RegisterModuleTable("mymod", entries);

  const auto res = rt.ExecuteScript("local m = require('mymod'); return m.add(3, 4)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 7);
}

TEST(LuaRuntimeModule, RegisterModuleTableWithValues) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  std::vector<MetatableEntry> entries;
  {
    MetatableEntry e;
    e.key = "name";
    e.is_function = false;
    e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("testmod")));
    entries.push_back(std::move(e));
  }
  {
    MetatableEntry e;
    e.key = "version";
    e.is_function = false;
    e.value = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(2)));
    entries.push_back(std::move(e));
  }
  rt.RegisterModuleTable("info", entries);

  const auto res = rt.ExecuteScript("local m = require('info'); return m.name, m.version");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "testmod");
  EXPECT_EQ(std::get<int64_t>(vals[1]->value), 2);
}

TEST(LuaRuntimeModule, RegisterModuleTableMixed) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mod_greet", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    std::string name = std::get<std::string>(args[0]->value);
    return std::make_shared<LuaValue>(LuaValue::from(std::string("hello " + name)));
  });

  std::vector<MetatableEntry> entries;
  {
    MetatableEntry e;
    e.key = "greet";
    e.is_function = true;
    e.func_name = "__mod_greet";
    entries.push_back(std::move(e));
  }
  {
    MetatableEntry e;
    e.key = "version";
    e.is_function = false;
    e.value = std::make_shared<LuaValue>(LuaValue::from(std::string("1.0")));
    entries.push_back(std::move(e));
  }
  rt.RegisterModuleTable("mixed", entries);

  const auto res = rt.ExecuteScript(R"(
    local m = require('mixed')
    return m.greet('world'), m.version
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "hello world");
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "1.0");
}

TEST(LuaRuntimeModule, RegisterModuleTableThrowsWithoutPackageLib) {
  const LuaRuntime rt(std::vector<std::string>{"base"});
  std::vector<MetatableEntry> entries;
  EXPECT_THROW({
    rt.RegisterModuleTable("mymod", entries);
  }, std::runtime_error);

  try {
    rt.RegisterModuleTable("mymod", entries);
    FAIL() << "expected RegisterModuleTable to throw";
  } catch (const std::runtime_error& e) {
    EXPECT_NE(std::string(e.what()).find("package"), std::string::npos);
  }
}

TEST(LuaRuntimeModule, RegisterModuleTableStackBalance) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mod_fn", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)));
  });

  int top_before = lua_gettop(rt.RawState());

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "fn";
  e.is_function = true;
  e.func_name = "__mod_fn";
  entries.push_back(std::move(e));
  rt.RegisterModuleTable("stacktest", entries);

  int top_after = lua_gettop(rt.RawState());
  EXPECT_EQ(top_before, top_after);
}

TEST(LuaRuntimeModule, RegisterModuleTableCaching) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "val";
  e.is_function = false;
  e.value = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42)));
  entries.push_back(std::move(e));
  rt.RegisterModuleTable("cached", entries);

  // Require twice — should return the same cached module
  const auto res = rt.ExecuteScript(R"(
    local m1 = require('cached')
    local m2 = require('cached')
    return m1 == m2, m1.val
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<bool>(vals[0]->value), true);
  EXPECT_EQ(std::get<int64_t>(vals[1]->value), 42);
}

TEST(LuaRuntimeModule, RegisterModuleTableEmptyModule) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::vector<MetatableEntry> entries; // empty
  rt.RegisterModuleTable("empty", entries);

  const auto res = rt.ExecuteScript("local m = require('empty'); return type(m)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "table");
}

TEST(LuaRuntimeModule, RegisterModuleTableReRegistration) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  // Register first version
  {
    std::vector<MetatableEntry> entries;
    MetatableEntry e;
    e.key = "ver";
    e.is_function = false;
    e.value = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)));
    entries.push_back(std::move(e));
    rt.RegisterModuleTable("versioned", entries);
  }

  // Re-register with new version
  {
    std::vector<MetatableEntry> entries;
    MetatableEntry e;
    e.key = "ver";
    e.is_function = false;
    e.value = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(2)));
    entries.push_back(std::move(e));
    rt.RegisterModuleTable("versioned", entries);
  }

  // Re-registration overwrites package.loaded, so require returns new version
  const auto res = rt.ExecuteScript("local m = require('versioned'); return m.ver");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
}

TEST(LuaRuntimeModule, AddSearchPathAndRequireFile) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  // Get the path to the test fixtures directory
  // This test assumes the test binary is run from the project root
  rt.AddSearchPath(RepoPath("tests/fixtures/modules/?.lua"));

  const auto res = rt.ExecuteScript(R"(
    local m = require('testmod')
    return m.add(10, 20), m.name
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 30);
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "testmod");
}

TEST(LuaRuntimeModule, ModuleNamespaceIsolation) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.StoreHostFunction("__mod_a_fn", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("from_a")));
  });
  rt.StoreHostFunction("__mod_b_fn", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(std::string("from_b")));
  });

  {
    std::vector<MetatableEntry> entries;
    MetatableEntry e;
    e.key = "fn";
    e.is_function = true;
    e.func_name = "__mod_a_fn";
    entries.push_back(std::move(e));
    rt.RegisterModuleTable("mod_a", entries);
  }
  {
    std::vector<MetatableEntry> entries;
    MetatableEntry e;
    e.key = "fn";
    e.is_function = true;
    e.func_name = "__mod_b_fn";
    entries.push_back(std::move(e));
    rt.RegisterModuleTable("mod_b", entries);
  }

  const auto res = rt.ExecuteScript(R"(
    local a = require('mod_a')
    local b = require('mod_b')
    return a.fn(), b.fn()
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "from_a");
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "from_b");
}

TEST(LuaRuntimeModule, AddSearchPathStackBalanceOnFailure) {
  LuaRuntime rt(std::vector<std::string>{"base"});
  int top_before = lua_gettop(rt.RawState());

  try {
    rt.AddSearchPath("./modules/?.lua");
  } catch (...) {
    // expected
  }

  int top_after = lua_gettop(rt.RawState());
  EXPECT_EQ(top_before, top_after);
}

TEST(LuaRuntimeModule, RegisterModuleTableStackBalanceOnFailure) {
  LuaRuntime rt(std::vector<std::string>{"base"});
  int top_before = lua_gettop(rt.RawState());

  std::vector<MetatableEntry> entries;
  try {
    rt.RegisterModuleTable("mymod", entries);
  } catch (...) {
    // expected
  }

  int top_after = lua_gettop(rt.RawState());
  EXPECT_EQ(top_before, top_after);
}

// ============================================
// BYTECODE PRECOMPILATION
// ============================================

TEST(LuaRuntimeBytecode, CompileScriptReturnsBytes) {
  LuaRuntime runtime;
  auto result = runtime.CompileScript("return 42");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(result));
  auto& bytecode = std::get<std::vector<uint8_t>>(result);
  EXPECT_GT(bytecode.size(), 0u);
}

TEST(LuaRuntimeBytecode, CompileScriptSyntaxError) {
  LuaRuntime runtime;
  auto result = runtime.CompileScript("return +");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, CompileScriptWithStripDebug) {
  LuaRuntime runtime;
  auto full = runtime.CompileScript("local x = 1\nlocal y = 2\nreturn x + y");
  auto stripped = runtime.CompileScript("local x = 1\nlocal y = 2\nreturn x + y", true);
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(full));
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(stripped));
  // Strict: an ignored stripDebug would leave the sizes equal.
  EXPECT_LT(std::get<std::vector<uint8_t>>(stripped).size(),
            std::get<std::vector<uint8_t>>(full).size());
}

TEST(LuaRuntimeBytecode, CompileScriptWithChunkName) {
  LuaRuntime runtime;
  auto result = runtime.CompileScript("error('test')", false, "@my-script");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(result));
  auto& bytecode = std::get<std::vector<uint8_t>>(result);
  auto exec = runtime.LoadBytecode(bytecode, "@my-script");
  ASSERT_TRUE(std::holds_alternative<std::string>(exec));
  EXPECT_NE(std::get<std::string>(exec).find("my-script"), std::string::npos);
}

TEST(LuaRuntimeBytecode, CompileDoesNotExecute) {
  LuaRuntime runtime;
  (void)runtime.CompileScript("x = 999");
  auto global = runtime.GetGlobal("x");
  ASSERT_NE(global, nullptr);
  EXPECT_TRUE(std::holds_alternative<std::monostate>(global->value));
}

TEST(LuaRuntimeBytecode, CompileFileReturnsBytes) {
  LuaRuntime runtime(LuaRuntime::AllLibraries());
  auto result = runtime.CompileFile(RepoPath("tests/fixtures/return-values.lua"));
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(result));
  EXPECT_GT(std::get<std::vector<uint8_t>>(result).size(), 0u);
}

TEST(LuaRuntimeBytecode, CompileFileNonexistent) {
  LuaRuntime runtime;
  auto result = runtime.CompileFile("nonexistent.lua");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, CompileFileEmptyPath) {
  LuaRuntime runtime;
  auto result = runtime.CompileFile("");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeExecutesCorrectly) {
  LuaRuntime runtime;
  auto compiled = runtime.CompileScript("return 42");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto result = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(result));
  auto& values = std::get<std::vector<LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<int64_t>(values[0]->value));
  EXPECT_EQ(std::get<int64_t>(values[0]->value), 42);
}

TEST(LuaRuntimeBytecode, LoadBytecodeMatchesExecuteScript) {
  LuaRuntime runtime(LuaRuntime::AllLibraries());

  std::string source = "return 'hello', 42, true";

  auto direct = runtime.ExecuteScript(source);
  auto compiled = runtime.CompileScript(source);
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto loaded = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));

  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(direct));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(loaded));

  auto& dv = std::get<std::vector<LuaPtr>>(direct);
  auto& lv = std::get<std::vector<LuaPtr>>(loaded);
  ASSERT_EQ(dv.size(), lv.size());
  ASSERT_EQ(dv.size(), 3u);

  EXPECT_EQ(std::get<std::string>(dv[0]->value), std::get<std::string>(lv[0]->value));
  EXPECT_EQ(std::get<int64_t>(dv[1]->value), std::get<int64_t>(lv[1]->value));
  EXPECT_EQ(std::get<bool>(dv[2]->value), std::get<bool>(lv[2]->value));
}

TEST(LuaRuntimeBytecode, LoadBytecodeInvalidData) {
  LuaRuntime runtime;
  std::vector<uint8_t> garbage = {0x00, 0x01, 0x02, 0x03};
  auto result = runtime.LoadBytecode(garbage);
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeEmpty) {
  LuaRuntime runtime;
  std::vector<uint8_t> empty;
  auto result = runtime.LoadBytecode(empty);
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeRejectSourceText) {
  LuaRuntime runtime;
  std::string source = "return 42";
  std::vector<uint8_t> text(source.begin(), source.end());
  auto result = runtime.LoadBytecode(text);
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
}

TEST(LuaRuntimeBytecode, LoadBytecodeSameBufferMultipleTimes) {
  LuaRuntime runtime;
  auto compiled = runtime.CompileScript("return 99");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto& bc = std::get<std::vector<uint8_t>>(compiled);

  for (int i = 0; i < 3; ++i) {
    auto result = runtime.LoadBytecode(bc);
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(result));
    auto& values = std::get<std::vector<LuaPtr>>(result);
    ASSERT_EQ(values.size(), 1u);
    EXPECT_EQ(std::get<int64_t>(values[0]->value), 99);
  }
}

TEST(LuaRuntimeBytecode, BytecodePortableBetweenStates) {
  LuaRuntime runtime1;
  LuaRuntime runtime2;

  auto compiled = runtime1.CompileScript("return 'hello'");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));

  auto result = runtime2.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(result));
  auto& values = std::get<std::vector<LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  EXPECT_EQ(std::get<std::string>(values[0]->value), "hello");
}

TEST(LuaRuntimeBytecode, LoadBytecodeWithHostFunctions) {
  LuaRuntime runtime;
  runtime.RegisterFunction("triple", [](const std::vector<LuaPtr>& args) -> LuaPtr {
    if (!args.empty() && std::holds_alternative<int64_t>(args[0]->value)) {
      return std::make_shared<LuaValue>(
        LuaValue::from(std::get<int64_t>(args[0]->value) * 3));
    }
    return std::make_shared<LuaValue>(LuaValue::nil());
  });

  auto compiled = runtime.CompileScript("return triple(10)");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto result = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(result));
  auto& values = std::get<std::vector<LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(values[0]->value), 30);
}

TEST(LuaRuntimeBytecode, LoadBytecodeWithGlobals) {
  LuaRuntime runtime;
  runtime.SetGlobal("factor", std::make_shared<LuaValue>(LuaValue::from(int64_t(7))));

  auto compiled = runtime.CompileScript("return factor * 6");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto result = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(result));
  auto& values = std::get<std::vector<LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(values[0]->value), 42);
}

TEST(LuaRuntimeBytecode, LoadBytecodeReturnsFunction) {
  LuaRuntime runtime;
  auto compiled = runtime.CompileScript("return function(a, b) return a + b end");
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  auto result = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(result));
  auto& values = std::get<std::vector<LuaPtr>>(result);
  ASSERT_EQ(values.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaFunctionRef>(values[0]->value));

  // Call the returned function
  auto& funcRef = std::get<LuaFunctionRef>(values[0]->value);
  std::vector<LuaPtr> args = {
    std::make_shared<LuaValue>(LuaValue::from(int64_t(10))),
    std::make_shared<LuaValue>(LuaValue::from(int64_t(32)))
  };
  auto callResult = runtime.CallFunction(funcRef, args);
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(callResult));
  auto& callValues = std::get<std::vector<LuaPtr>>(callResult);
  ASSERT_EQ(callValues.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(callValues[0]->value), 42);
}

TEST(LuaRuntimeBytecode, CompileFileAndLoadBytecodeMatch) {
  LuaRuntime runtime(LuaRuntime::AllLibraries());

  auto compiled = runtime.CompileFile(RepoPath("tests/fixtures/return-values.lua"));
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));

  auto fromBytecode = runtime.LoadBytecode(std::get<std::vector<uint8_t>>(compiled));
  auto fromFile = runtime.ExecuteFile(RepoPath("tests/fixtures/return-values.lua"));

  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(fromBytecode));
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(fromFile));

  auto& bcVals = std::get<std::vector<LuaPtr>>(fromBytecode);
  auto& fileVals = std::get<std::vector<LuaPtr>>(fromFile);
  ASSERT_EQ(bcVals.size(), fileVals.size());
  // Matching arity is not "matching": compare the values themselves, or wrong
  // results of the right shape pass (F9).
  for (size_t i = 0; i < bcVals.size(); ++i) {
    ASSERT_NE(bcVals[i], nullptr);
    ASSERT_NE(fileVals[i], nullptr);
    EXPECT_EQ(bcVals[i]->value.index(), fileVals[i]->value.index())
        << "type mismatch at result " << i;
    if (std::holds_alternative<int64_t>(bcVals[i]->value)) {
      EXPECT_EQ(std::get<int64_t>(bcVals[i]->value), std::get<int64_t>(fileVals[i]->value));
    } else if (std::holds_alternative<double>(bcVals[i]->value)) {
      EXPECT_DOUBLE_EQ(std::get<double>(bcVals[i]->value), std::get<double>(fileVals[i]->value));
    } else if (std::holds_alternative<std::string>(bcVals[i]->value)) {
      EXPECT_EQ(std::get<std::string>(bcVals[i]->value), std::get<std::string>(fileVals[i]->value));
    } else if (std::holds_alternative<bool>(bcVals[i]->value)) {
      EXPECT_EQ(std::get<bool>(bcVals[i]->value), std::get<bool>(fileVals[i]->value));
    }
  }
}

// --- Table Reference API tests ---

TEST(LuaRuntimeTableAPI, CreateTableReturnsValidRef) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int ref = rt.CreateTable();
  EXPECT_NE(ref, LUA_NOREF);
  EXPECT_NE(ref, LUA_REFNIL);

  // Should be usable as a table
  auto val = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42)));
  rt.SetTableField(ref, "x", val);
  auto result = rt.GetTableField(ref, "x");
  EXPECT_EQ(std::get<int64_t>(result->value), 42);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, CreateTableFromTablePopulatesFields) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  LuaTable initial;
  initial["name"] = std::make_shared<LuaValue>(LuaValue::from(std::string("Alice")));
  initial["age"] = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(30)));

  int ref = rt.CreateTableFrom(initial);
  EXPECT_NE(ref, LUA_NOREF);

  auto name = rt.GetTableField(ref, "name");
  EXPECT_EQ(std::get<std::string>(name->value), "Alice");
  auto age = rt.GetTableField(ref, "age");
  EXPECT_EQ(std::get<int64_t>(age->value), 30);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, KeyedFieldsDistinguishStringFromIntegerKeys) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int ref = rt.CreateTable();

  // A string key "123" and an integer key 123 are distinct Lua slots. The
  // *Keyed API honors the caller's explicit type; the string overload coerces.
  rt.SetTableFieldKeyed(ref, TableKey{std::string("123")},
      std::make_shared<LuaValue>(LuaValue::from(std::string("string-key"))));
  rt.SetTableFieldKeyed(ref, TableKey{static_cast<int64_t>(123)},
      std::make_shared<LuaValue>(LuaValue::from(std::string("integer-key"))));

  auto s = rt.GetTableFieldKeyed(ref, TableKey{std::string("123")});
  EXPECT_EQ(std::get<std::string>(s->value), "string-key");
  auto i = rt.GetTableFieldKeyed(ref, TableKey{static_cast<int64_t>(123)});
  EXPECT_EQ(std::get<std::string>(i->value), "integer-key");
  EXPECT_TRUE(rt.HasTableFieldKeyed(ref, TableKey{std::string("123")}));
  EXPECT_TRUE(rt.HasTableFieldKeyed(ref, TableKey{static_cast<int64_t>(123)}));

  // The coercing string overload reaches only the integer slot for "123".
  auto coerced = rt.GetTableField(ref, "123");
  EXPECT_EQ(std::get<std::string>(coerced->value), "integer-key");

  // A fractional key stays a float key (Int64Value truncation regression).
  rt.SetTableFieldKeyed(ref, TableKey{1.5},
      std::make_shared<LuaValue>(LuaValue::from(std::string("half"))));
  auto half = rt.GetTableFieldKeyed(ref, TableKey{1.5});
  EXPECT_EQ(std::get<std::string>(half->value), "half");

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, CreateTableFromArrayCreatesSequence) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  LuaArray initial;
  initial.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(10))));
  initial.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(20))));
  initial.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(30))));

  int ref = rt.CreateTableFrom(initial);
  EXPECT_NE(ref, LUA_NOREF);

  // Lua arrays are 1-indexed
  auto v1 = rt.GetTableField(ref, "1");
  EXPECT_EQ(std::get<int64_t>(v1->value), 10);
  auto v2 = rt.GetTableField(ref, "2");
  EXPECT_EQ(std::get<int64_t>(v2->value), 20);
  auto v3 = rt.GetTableField(ref, "3");
  EXPECT_EQ(std::get<int64_t>(v3->value), 30);

  EXPECT_EQ(rt.GetTableLength(ref), 3);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, GetGlobalRefReturnsRefForTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("myconfig = { host = 'localhost', port = 5432 }");

  auto result = rt.GetGlobalRef("myconfig");
  ASSERT_TRUE(std::holds_alternative<int>(result));
  int ref = std::get<int>(result);
  EXPECT_NE(ref, LUA_NOREF);

  auto host = rt.GetTableField(ref, "host");
  EXPECT_EQ(std::get<std::string>(host->value), "localhost");
  auto port = rt.GetTableField(ref, "port");
  EXPECT_EQ(std::get<int64_t>(port->value), 5432);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, GetGlobalRefReturnsErrorForNonTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("mynum = 42");

  auto result = rt.GetGlobalRef("mynum");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
  EXPECT_NE(std::get<std::string>(result).find("not a table"), std::string::npos);
}

TEST(LuaRuntimeTableAPI, GetGlobalRefReturnsErrorForNil) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  auto result = rt.GetGlobalRef("nonexistent");
  ASSERT_TRUE(std::holds_alternative<std::string>(result));
  EXPECT_NE(std::get<std::string>(result).find("not a table"), std::string::npos);
}

TEST(LuaRuntimeTableAPI, TablePairsIteratesAllEntries) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = { a = 1, b = 'hello', c = true }");

  auto result = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(result));
  int ref = std::get<int>(result);

  auto pairs = rt.TablePairs(ref);
  EXPECT_EQ(pairs.size(), 3u);

  // Collect into a map for order-independent checking
  std::unordered_map<std::string, LuaPtr> map;
  for (auto& [k, v] : pairs) {
    map[std::get<std::string>(k->value)] = v;
  }
  EXPECT_EQ(std::get<int64_t>(map["a"]->value), 1);
  EXPECT_EQ(std::get<std::string>(map["b"]->value), "hello");
  EXPECT_EQ(std::get<bool>(map["c"]->value), true);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, TablePairsWithNumericKeys) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = { 'x', 'y', 'z' }");

  auto result = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(result));
  int ref = std::get<int>(result);

  auto pairs = rt.TablePairs(ref);
  EXPECT_EQ(pairs.size(), 3u);

  // Keys should be integers 1, 2, 3
  std::vector<int64_t> keys;
  for (auto& [k, v] : pairs) {
    keys.push_back(std::get<int64_t>(k->value));
  }
  std::sort(keys.begin(), keys.end());
  EXPECT_EQ(keys[0], 1);
  EXPECT_EQ(keys[1], 2);
  EXPECT_EQ(keys[2], 3);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, TableIPairsIteratesSequence) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("t = { 10, 20, 30, 40 }");

  auto result = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(result));
  int ref = std::get<int>(result);

  auto ipairs = rt.TableIPairs(ref);
  ASSERT_EQ(ipairs.size(), 4u);
  EXPECT_EQ(ipairs[0].first, 1);
  EXPECT_EQ(std::get<int64_t>(ipairs[0].second->value), 10);
  EXPECT_EQ(ipairs[1].first, 2);
  EXPECT_EQ(std::get<int64_t>(ipairs[1].second->value), 20);
  EXPECT_EQ(ipairs[2].first, 3);
  EXPECT_EQ(std::get<int64_t>(ipairs[2].second->value), 30);
  EXPECT_EQ(ipairs[3].first, 4);
  EXPECT_EQ(std::get<int64_t>(ipairs[3].second->value), 40);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, TableIPairsStopsAtNil) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  // Create table with a gap: {10, 20, nil, 40}
  (void)rt.ExecuteScript("t = {}; t[1]=10; t[2]=20; t[4]=40");

  auto result = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(result));
  int ref = std::get<int>(result);

  auto ipairs = rt.TableIPairs(ref);
  // Should stop at index 3 (nil)
  ASSERT_EQ(ipairs.size(), 2u);
  EXPECT_EQ(ipairs[0].first, 1);
  EXPECT_EQ(std::get<int64_t>(ipairs[0].second->value), 10);
  EXPECT_EQ(ipairs[1].first, 2);
  EXPECT_EQ(std::get<int64_t>(ipairs[1].second->value), 20);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, ReleaseTableRefFreesSlot) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int ref = rt.CreateTable();
  EXPECT_NE(ref, LUA_NOREF);

  auto val = std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)));
  rt.SetTableField(ref, "x", val);

  rt.ReleaseTableRef(ref);

  // Double release should be safe (no-op)
  rt.ReleaseTableRef(ref);
  rt.ReleaseTableRef(LUA_NOREF);
  rt.ReleaseTableRef(LUA_REFNIL);
}

TEST(LuaRuntimeTableAPI, CreateTableSetAsGlobalAccessFromLua) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int ref = rt.CreateTable();

  auto val1 = std::make_shared<LuaValue>(LuaValue::from(std::string("world")));
  rt.SetTableField(ref, "hello", val1);

  // Set the table as a global using LuaTableRef
  rt.SetGlobal("mytable", std::make_shared<LuaValue>(
    LuaValue::from(LuaTableRef(ref, rt.RawState()))));

  auto res = rt.ExecuteScript("return mytable.hello");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), "world");
}

TEST(LuaRuntimeTableAPI, LiveMutationVisibleFromLua) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  // Create table via Lua and get a ref
  (void)rt.ExecuteScript("shared = { x = 1 }");
  auto result = rt.GetGlobalRef("shared");
  ASSERT_TRUE(std::holds_alternative<int>(result));
  int ref = std::get<int>(result);

  // Mutate via C++ API
  rt.SetTableField(ref, "x", std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(99))));

  // Verify Lua sees the change
  auto res = rt.ExecuteScript("return shared.x");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 99);

  // Mutate from Lua
  (void)rt.ExecuteScript("shared.x = 200");

  // Verify C++ API sees the change
  auto val = rt.GetTableField(ref, "x");
  EXPECT_EQ(std::get<int64_t>(val->value), 200);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, TablePairsEmptyTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int ref = rt.CreateTable();
  auto pairs = rt.TablePairs(ref);
  EXPECT_TRUE(pairs.empty());
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeTableAPI, TableIPairsEmptyTable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int ref = rt.CreateTable();
  auto ipairs = rt.TableIPairs(ref);
  EXPECT_TRUE(ipairs.empty());
  rt.ReleaseTableRef(ref);
}

// --- Wall-Clock Timeout Tests ---

namespace {
// A runtime with a wall-clock timeout and, optionally, an instruction limit.
LuaRuntime MakeTimedRuntime(size_t timeout_ms, size_t max_instructions = 0) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.timeout_ms = timeout_ms;
  config.max_instructions = max_instructions;
  return LuaRuntime(config);
}

// Elapsed wall time of `fn`, in milliseconds.
template <typename Fn>
long long ElapsedMs(Fn&& fn) {
  const auto start = std::chrono::steady_clock::now();
  fn();
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start).count();
}
}  // namespace

TEST(LuaRuntimeTimeout, AbortsARunawayScript) {
  LuaRuntime rt = MakeTimedRuntime(100);

  ScriptResult res;
  const long long elapsed = ElapsedMs([&] { res = rt.ExecuteScript("while true do end"); });

  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("execution timeout"), std::string::npos);
  // Generous upper bound: this asserts the loop was interrupted rather than
  // running forever, not that the deadline is precise.
  EXPECT_LT(elapsed, 10000);
}

TEST(LuaRuntimeTimeout, FastScriptsCompleteNormally) {
  LuaRuntime rt = MakeTimedRuntime(30000);

  auto res = rt.ExecuteScript("local s = 0 for i = 1, 100000 do s = s + i end return s");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value),
            5000050000LL);
}

TEST(LuaRuntimeTimeout, ZeroMeansNoTimeout) {
  LuaRuntime rt = MakeTimedRuntime(0);
  EXPECT_EQ(rt.GetTimeout(), 0u);

  auto res = rt.ExecuteScript("local s = 0 for i = 1, 200000 do s = s + i end return s");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
}

TEST(LuaRuntimeTimeout, ContextStaysUsableAfterATimeout) {
  LuaRuntime rt = MakeTimedRuntime(100);

  auto aborted = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(aborted));

  auto after = rt.ExecuteScript("return 2 + 2");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(after));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(after)[0]->value), 4);
}

TEST(LuaRuntimeTimeout, BudgetIsPerExecutionNotCumulative) {
  LuaRuntime rt = MakeTimedRuntime(2000);

  // Several executions that each fit inside the budget must all succeed, even
  // though together they may exceed it — the deadline resets at every entry.
  for (int i = 0; i < 4; ++i) {
    auto res = rt.ExecuteScript("local s = 0 for i = 1, 300000 do s = s + i end");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res)) << "iteration " << i;
  }
}

TEST(LuaRuntimeTimeout, AppliesToCoroutineResumes) {
  LuaRuntime rt = MakeTimedRuntime(100);

  auto fn = rt.ExecuteScript("return function() while true do end end");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(fn));
  const auto& funcRef =
      std::get<LuaFunctionRef>(std::get<std::vector<LuaPtr>>(fn)[0]->value);

  auto co = rt.CreateCoroutine(funcRef);
  ASSERT_TRUE(std::holds_alternative<LuaThreadRef>(co));

  auto result = rt.ResumeCoroutine(std::get<LuaThreadRef>(co), {});
  EXPECT_EQ(result.status, CoroutineStatus::Dead);
  ASSERT_TRUE(result.error.has_value());
  EXPECT_NE(result.error->find("execution timeout"), std::string::npos);
}

TEST(LuaRuntimeTimeout, TighterOfTimeoutAndInstructionLimitWins) {
  // A tiny instruction limit under a long timeout: instructions abort first.
  LuaRuntime instructions_first = MakeTimedRuntime(60000, /*max_instructions=*/50000);
  auto by_instructions = instructions_first.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(by_instructions));
  EXPECT_NE(std::get<std::string>(by_instructions).find("instruction limit exceeded"),
            std::string::npos);

  // A short timeout under an effectively unreachable instruction limit: the
  // clock aborts first. Both share one count-hook installation.
  LuaRuntime timeout_first = MakeTimedRuntime(100, /*max_instructions=*/4000000000ULL);
  auto by_time = timeout_first.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(by_time));
  EXPECT_NE(std::get<std::string>(by_time).find("execution timeout"), std::string::npos);
}

TEST(LuaRuntimeTimeout, SurvivesDebugHookInstallAndRemoval) {
  LuaRuntime rt = MakeTimedRuntime(100);
  int hook_events = 0;
  const auto counting_hook = [&hook_events](const std::string&, int, const std::string&) {
    ++hook_events;
  };

  // A line-only mask must not displace the count hook the timeout relies on.
  rt.SetDebugHook(counting_hook, LUA_MASKLINE);
  auto with_hook = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(with_hook));
  EXPECT_NE(std::get<std::string>(with_hook).find("execution timeout"), std::string::npos);

  EXPECT_GT(hook_events, 0);

  rt.RemoveDebugHook();
  auto without_hook = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(without_hook));
  EXPECT_NE(std::get<std::string>(without_hook).find("execution timeout"),
            std::string::npos);
}

TEST(LuaRuntimeTimeout, SetTimeoutAppliesAndIsReplayable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetTimeout(), 0u);

  rt.SetTimeout(100);
  EXPECT_EQ(rt.GetTimeout(), 100u);
  // Recorded in the config so a replacement state (reset()) inherits it.
  EXPECT_EQ(rt.GetConfig().timeout_ms, 100u);

  auto res = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("execution timeout"), std::string::npos);

  // Clearing it lets a long script run again.
  rt.SetTimeout(0);
  EXPECT_EQ(rt.GetTimeout(), 0u);
  auto after = rt.ExecuteScript("local s = 0 for i = 1, 200000 do s = s + i end return s");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(after));
}

TEST(LuaRuntimeTimeout, ErrorIsCatchableFromLuaPcall) {
  LuaRuntime rt = MakeTimedRuntime(100);

  // The timeout is raised as a normal Lua error, so a script's own pcall sees
  // it. The budget is not refreshed by that, so the next loop aborts at once
  // and the script still terminates.
  auto res = rt.ExecuteScript(
    "local ok, err = pcall(function() while true do end end)\n"
    "return ok, tostring(err)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_FALSE(std::get<bool>(vals[0]->value));
  EXPECT_NE(std::get<std::string>(vals[1]->value).find("execution timeout"),
            std::string::npos);
}

// --- Debug Hook Tests ---

namespace {
// Records every hook event a runtime reports, for the assertions below.
struct HookRecorder {
  struct Event {
    std::string event;
    int line;
    std::string name;
  };
  std::vector<Event> events;

  [[nodiscard]] LuaRuntime::DebugHookCallback Callback() {
    return [this](const std::string& event, int line, const std::string& name) {
      events.push_back({event, line, name});
    };
  }

  [[nodiscard]] size_t CountOf(const std::string& event) const {
    size_t n = 0;
    for (const auto& e : events) {
      if (e.event == event) ++n;
    }
    return n;
  }

  [[nodiscard]] bool Has(const std::string& event) const {
    return CountOf(event) > 0;
  }
};
}  // namespace

TEST(LuaRuntimeDebugHook, LineHookReportsEachLine) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKLINE);

  auto res = rt.ExecuteScript("local a = 1\nlocal b = 2\nlocal c = a + b\nreturn c");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 3);

  // One line event per source line of the chunk.
  EXPECT_EQ(rec.CountOf("line"), 4u);
  std::vector<int> lines;
  for (const auto& e : rec.events) lines.push_back(e.line);
  EXPECT_EQ(lines, (std::vector<int>{1, 2, 3, 4}));

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, CallAndReturnEventsFire) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKCALL | LUA_MASKRET);

  (void)rt.ExecuteScript(
    "local function inner() return 1 end\n"
    "local x = inner()\n"
    "return x");

  EXPECT_TRUE(rec.Has("call"));
  EXPECT_TRUE(rec.Has("return"));
  // The named local is resolvable from the call site.
  bool saw_named_call = false;
  for (const auto& e : rec.events) {
    if (e.event == "call" && e.name == "inner") saw_named_call = true;
  }
  EXPECT_TRUE(saw_named_call);

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, CountEventFiresAtTheRequestedInterval) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKCOUNT, /*count_interval=*/100);

  (void)rt.ExecuteScript("local s = 0 for i = 1, 5000 do s = s + i end");

  // Thousands of instructions at one event per 100 — the exact count depends on
  // the VM, so assert the order of magnitude rather than a fixed number.
  EXPECT_GT(rec.CountOf("count"), 20u);
  EXPECT_EQ(rec.CountOf("line"), 0u);  // only the requested mask fires

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, RemoveStopsFurtherEvents) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKLINE);
  (void)rt.ExecuteScript("local a = 1");
  const size_t after_first = rec.events.size();
  EXPECT_GT(after_first, 0u);

  rt.RemoveDebugHook();
  EXPECT_FALSE(rt.HasDebugHook());

  (void)rt.ExecuteScript("local a = 1\nlocal b = 2\nlocal c = 3");
  EXPECT_EQ(rec.events.size(), after_first);
}

TEST(LuaRuntimeDebugHook, DoesNotDisturbExecutionResults) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKLINE | LUA_MASKCALL | LUA_MASKRET);

  auto res = rt.ExecuteScript(
    "local t = {}\n"
    "for i = 1, 10 do t[i] = i * 2 end\n"
    "return t[10], 'ok'");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 2u);
  EXPECT_EQ(std::get<int64_t>(vals[0]->value), 20);
  EXPECT_EQ(std::get<std::string>(vals[1]->value), "ok");
  EXPECT_GT(rec.events.size(), 0u);

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, ErrorsStillPropagateWithAHookInstalled) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKLINE);

  auto res = rt.ExecuteScript("error('boom')");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("boom"), std::string::npos);

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, ThrowingHookIsContained) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int fired = 0;
  rt.SetDebugHook([&fired](const std::string&, int, const std::string&) {
    ++fired;
    throw std::runtime_error("hook exploded");
  }, LUA_MASKLINE);

  // The exception must not unwind through Lua's C frames; the script completes.
  auto res = rt.ExecuteScript("local a = 1\nreturn a + 1");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
  EXPECT_GT(fired, 0);

  rt.RemoveDebugHook();
  // ...and the state is still usable.
  auto after = rt.ExecuteScript("return 7");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(after));
}

TEST(LuaRuntimeDebugHook, HookRemovingItselfMidDispatchIsSafe) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  int fired = 0;
  // The shared_ptr the dispatcher holds must keep the callback alive while it
  // destroys the runtime's own reference to it.
  rt.SetDebugHook([&rt, &fired](const std::string&, int, const std::string&) {
    ++fired;
    rt.RemoveDebugHook();
  }, LUA_MASKLINE);

  (void)rt.ExecuteScript("local a = 1\nlocal b = 2\nlocal c = 3\nlocal d = 4");

  EXPECT_EQ(fired, 1);  // removed itself on the first event
  EXPECT_FALSE(rt.HasDebugHook());
}

TEST(LuaRuntimeDebugHook, CoexistsWithInstructionLimit) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 200000;
  LuaRuntime rt(config);

  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKCOUNT, /*count_interval=*/7);

  // The limit is still enforced even though the debug hook asked for a much
  // finer count interval (the two share one lua_sethook installation).
  auto res = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"),
            std::string::npos);
  EXPECT_GT(rec.CountOf("count"), 0u);

  // ...and removing the debug hook leaves the limit intact.
  rt.RemoveDebugHook();
  auto again = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(again));
  EXPECT_NE(std::get<std::string>(again).find("instruction limit exceeded"),
            std::string::npos);
}

TEST(LuaRuntimeDebugHook, LineHookDoesNotWeakenTheInstructionLimit) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 100000;
  LuaRuntime rt(config);

  HookRecorder rec;
  // A line-only mask must not displace the count hook the limit relies on.
  rt.SetDebugHook(rec.Callback(), LUA_MASKLINE);

  auto res = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"),
            std::string::npos);

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, CoroutinesCreatedAfterInstallInheritTheHook) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;
  rt.SetDebugHook(rec.Callback(), LUA_MASKLINE);

  auto fn = rt.ExecuteScript("return function() local a = 1 return a end");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(fn));
  const auto& fnVals = std::get<std::vector<LuaPtr>>(fn);
  ASSERT_EQ(fnVals.size(), 1u);
  const auto& funcRef = std::get<LuaFunctionRef>(fnVals[0]->value);

  auto co = rt.CreateCoroutine(funcRef);
  ASSERT_TRUE(std::holds_alternative<LuaThreadRef>(co));

  const size_t before = rec.events.size();
  auto result = rt.ResumeCoroutine(std::get<LuaThreadRef>(co), {});
  EXPECT_EQ(result.status, CoroutineStatus::Dead);
  EXPECT_GT(rec.events.size(), before);  // the thread inherited the hook

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, EmptyMaskOrNullCallbackRemovesTheHook) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder rec;

  rt.SetDebugHook(rec.Callback(), 0);  // no events requested
  EXPECT_FALSE(rt.HasDebugHook());

  rt.SetDebugHook(nullptr, LUA_MASKLINE);  // no callback
  EXPECT_FALSE(rt.HasDebugHook());

  (void)rt.ExecuteScript("local a = 1\nlocal b = 2");
  EXPECT_TRUE(rec.events.empty());

  // A count mask with no interval would never fire; it is dropped rather than
  // installed with a zero count.
  rt.SetDebugHook(rec.Callback(), LUA_MASKCOUNT, /*count_interval=*/0);
  (void)rt.ExecuteScript("local s = 0 for i = 1, 5000 do s = s + i end");
  EXPECT_TRUE(rec.events.empty());

  rt.RemoveDebugHook();
}

TEST(LuaRuntimeDebugHook, ReplacingAHookSwapsTheCallback) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  HookRecorder first;
  HookRecorder second;

  rt.SetDebugHook(first.Callback(), LUA_MASKLINE);
  (void)rt.ExecuteScript("local a = 1");
  const size_t after_first = first.events.size();
  EXPECT_GT(after_first, 0u);

  rt.SetDebugHook(second.Callback(), LUA_MASKLINE);
  (void)rt.ExecuteScript("local a = 1\nlocal b = 2");

  EXPECT_EQ(first.events.size(), after_first);  // the old callback is detached
  EXPECT_GT(second.events.size(), 0u);

  rt.RemoveDebugHook();
}

// --- State Introspection Tests ---

TEST(LuaRuntimeIntrospection, ReportsLuaVersion) {
  // Static: answerable without a state at all.
  const std::string version = LuaRuntime::GetVersion();
  EXPECT_EQ(version, LUA_VERSION);
  EXPECT_EQ(version.rfind("Lua ", 0), 0u);  // "Lua <major>.<minor>"

  const std::string release = LuaRuntime::GetRelease();
  EXPECT_EQ(release, LUA_RELEASE);
  // The release string extends the version with the patch level.
  EXPECT_EQ(release.rfind(version, 0), 0u);
  EXPECT_GT(release.size(), version.size());

  EXPECT_EQ(LuaRuntime::GetVersionNumber(), LUA_VERSION_NUM);
  EXPECT_GE(LuaRuntime::GetVersionNumber(), 504);
}

TEST(LuaRuntimeIntrospection, VersionIsAlsoReachableThroughAnInstance) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetVersion(), LUA_VERSION);
  EXPECT_EQ(rt.GetVersionNumber(), LUA_VERSION_NUM);

  // ...and agrees with what the state itself reports via _VERSION.
  auto res = rt.ExecuteScript("return _VERSION");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value), LuaRuntime::GetVersion());
}

TEST(LuaRuntimeIntrospection, ConfigAndMemoryBackTheInfoSnapshot) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 4 * 1024 * 1024;
  config.max_instructions = 250000;
  const LuaRuntime rt(config);

  // The four values the binding layer reads to build info().
  EXPECT_EQ(rt.GetConfig().libraries, LuaRuntime::SafeLibraries());
  EXPECT_EQ(rt.GetMemoryLimit(), 4u * 1024 * 1024);
  EXPECT_EQ(rt.GetMaxInstructions(), 250000u);
  EXPECT_GT(rt.GetMemoryUsage(), 0u);
  EXPECT_LT(rt.GetMemoryUsage(), rt.GetMemoryLimit());
}

TEST(LuaRuntimeIntrospection, BareStateReportsNoLibrariesAndNoLimits) {
  const LuaRuntime rt;
  EXPECT_TRUE(rt.GetConfig().libraries.empty());
  EXPECT_EQ(rt.GetMemoryLimit(), 0u);
  EXPECT_EQ(rt.GetMaxInstructions(), 0u);
  EXPECT_GT(rt.GetMemoryUsage(), 0u);
}

TEST(LuaRuntimeIntrospection, MemoryUsageTracksAllocation) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const size_t before = rt.GetMemoryUsage();

  (void)rt.ExecuteScript("big = {} for i = 1, 20000 do big[i] = i end");

  EXPECT_GT(rt.GetMemoryUsage(), before);
}

// --- Environment Tables Tests ---

// Runs a script in `env_ref` and returns its single string result, or the error
// message prefixed with "ERROR: " so a failure is legible in the assertion.
static std::string RunInEnvString(const LuaRuntime& rt, int env_ref,
                                  const std::string& script) {
  auto res = rt.ExecuteScriptInEnvironment(env_ref, script);
  if (std::holds_alternative<std::string>(res)) {
    return "ERROR: " + std::get<std::string>(res);
  }
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  if (vals.size() != 1) return "ERROR: expected exactly one result";
  if (const auto* s = std::get_if<std::string>(&vals[0]->value)) return *s;
  return "ERROR: result is not a string";
}

TEST(LuaRuntimeEnvironment, CreateEnvironmentReturnsValidRef) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({});
  EXPECT_NE(ref, LUA_NOREF);
  EXPECT_NE(ref, LUA_REFNIL);
  EXPECT_TRUE(rt.TablePairs(ref).empty());
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, WhitelistedGlobalsAreReachable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({"math", "tostring"});

  EXPECT_EQ(RunInEnvString(rt, ref, "return tostring(math.floor(3.7))"), "3");
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, UnlistedGlobalsAreNil) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({"math"});

  auto res = rt.ExecuteScriptInEnvironment(ref, "return string == nil");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_TRUE(std::get<bool>(vals[0]->value));

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, UnsetWhitelistNameIsSkipped) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({"math", "no_such_global"});
  EXPECT_TRUE(rt.HasTableField(ref, "math"));
  EXPECT_FALSE(rt.HasTableField(ref, "no_such_global"));
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, AssignmentsLandInTheEnvironmentNotGlobals) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("counter = 1");
  const int ref = rt.CreateEnvironment({});

  auto res = rt.ExecuteScriptInEnvironment(ref, "counter = 99");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));

  // The environment captured it; the real global is untouched.
  EXPECT_EQ(std::get<int64_t>(rt.GetTableField(ref, "counter")->value), 99);
  EXPECT_EQ(std::get<int64_t>(rt.GetGlobal("counter")->value), 1);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, TwoEnvironmentsAreIsolated) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int a = rt.CreateEnvironment({});
  const int b = rt.CreateEnvironment({});

  (void)rt.ExecuteScriptInEnvironment(a, "tenant = 'a'");
  (void)rt.ExecuteScriptInEnvironment(b, "tenant = 'b'");

  EXPECT_EQ(RunInEnvString(rt, a, "return tenant"), "a");
  EXPECT_EQ(RunInEnvString(rt, b, "return tenant"), "b");

  rt.ReleaseTableRef(a);
  rt.ReleaseTableRef(b);
}

TEST(LuaRuntimeEnvironment, WhitelistCopiesTheSameTableNotACopy) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("shared = { n = 1 }");
  const int ref = rt.CreateEnvironment({"shared"});

  (void)rt.ExecuteScriptInEnvironment(ref, "shared.n = 99");

  // Same table object, so the mutation is visible globally.
  auto res = rt.ExecuteScript("return shared.n");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 99);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, InheritReadsFallThroughToGlobals) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("app_name = 'demo'");
  const int ref = rt.CreateEnvironment({}, /*inherit=*/true);

  EXPECT_EQ(RunInEnvString(rt, ref, "return app_name"), "demo");
  EXPECT_EQ(RunInEnvString(rt, ref, "return string.upper('hi')"), "HI");

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, InheritWritesShadowRatherThanOverwrite) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("app_name = 'demo'");
  const int ref = rt.CreateEnvironment({}, /*inherit=*/true);

  (void)rt.ExecuteScriptInEnvironment(ref, "app_name = 'sandboxed'");

  EXPECT_EQ(RunInEnvString(rt, ref, "return app_name"), "sandboxed");
  EXPECT_EQ(std::get<std::string>(rt.GetGlobal("app_name")->value), "demo");

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, InheritSeesGlobalsAddedAfterCreation) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({}, /*inherit=*/true);
  (void)rt.ExecuteScript("added_later = 'yes'");
  // __index is a live link to _G, unlike the whitelist's one-time copy.
  EXPECT_EQ(RunInEnvString(rt, ref, "return added_later"), "yes");
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, ReturnsMultipleValues) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({});

  auto res = rt.ExecuteScriptInEnvironment(ref, "return 1, 2, 3");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 3u);
  EXPECT_EQ(std::get<int64_t>(vals[2]->value), 3);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, SyntaxAndRuntimeErrorsAreReported) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({"error"});

  auto syntax = rt.ExecuteScriptInEnvironment(ref, "this is not lua");
  EXPECT_TRUE(std::holds_alternative<std::string>(syntax));

  auto runtime_err = rt.ExecuteScriptInEnvironment(ref, "error('boom')");
  ASSERT_TRUE(std::holds_alternative<std::string>(runtime_err));
  EXPECT_NE(std::get<std::string>(runtime_err).find("boom"), std::string::npos);

  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, RejectsInvalidEnvironmentRef) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  auto noref = rt.ExecuteScriptInEnvironment(LUA_NOREF, "return 1");
  ASSERT_TRUE(std::holds_alternative<std::string>(noref));
  EXPECT_NE(std::get<std::string>(noref).find("invalid environment reference"),
            std::string::npos);

  // An unused registry slot reads back as nil, which is not a table.
  auto bad = rt.ExecuteScriptInEnvironment(999999, "return 1");
  ASSERT_TRUE(std::holds_alternative<std::string>(bad));
  EXPECT_NE(std::get<std::string>(bad).find("not a table"), std::string::npos);
}

TEST(LuaRuntimeEnvironment, StackIsBalancedAcrossManyRuns) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({"math"});
  const int before = lua_gettop(rt.RawState());

  for (int i = 0; i < 50; ++i) {
    (void)rt.ExecuteScriptInEnvironment(ref, "return math.pi");
    (void)rt.ExecuteScriptInEnvironment(ref, "bad syntax here");
    (void)rt.ExecuteScriptInEnvironment(ref, "local x = 1");
  }

  EXPECT_EQ(lua_gettop(rt.RawState()), before);
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, HonorsInstructionLimit) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 100000;
  LuaRuntime rt(config);

  const int ref = rt.CreateEnvironment({});
  auto res = rt.ExecuteScriptInEnvironment(ref, "while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"),
            std::string::npos);

  // The state is still usable afterwards.
  EXPECT_EQ(RunInEnvString(rt, ref, "return 'ok'"), "ok");
  rt.ReleaseTableRef(ref);
}

TEST(LuaRuntimeEnvironment, EnvironmentTableIsAnOrdinaryTableRef) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int ref = rt.CreateEnvironment({"tostring"});

  // Seed a value from C++ and read it back from the script.
  rt.SetTableField(ref, "answer",
    std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42))));
  EXPECT_EQ(RunInEnvString(rt, ref, "return tostring(answer)"), "42");

  // And read back what the script defined.
  (void)rt.ExecuteScriptInEnvironment(ref, "defined_by_script = 7");
  EXPECT_EQ(std::get<int64_t>(rt.GetTableField(ref, "defined_by_script")->value), 7);

  rt.ReleaseTableRef(ref);
}

// --- Memory Limits Tests ---

TEST(LuaRuntimeMemory, MemoryUsageTracking) {
  // Default constructor tracks usage > 0 (Lua state itself uses memory)
  LuaRuntime rt;
  EXPECT_GT(rt.GetMemoryUsage(), 0u);
}

TEST(LuaRuntimeMemory, MemoryLimitConfigConstructor) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_memory = 1024 * 1024;  // 1 MB
  LuaRuntime rt(config);
  EXPECT_EQ(rt.GetMemoryLimit(), 1024u * 1024u);
  EXPECT_GT(rt.GetMemoryUsage(), 0u);
}

TEST(LuaRuntimeMemory, MemoryLimitOOM) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_memory = 256 * 1024;  // 256 KB
  LuaRuntime rt(config);

  // Try to allocate a large string — should fail with OOM
  const auto res = rt.ExecuteScript("return string.rep('x', 1024 * 1024)");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  const auto& err = std::get<std::string>(res);
  EXPECT_TRUE(err.find("memory") != std::string::npos ||
              err.find("mem") != std::string::npos)
      << "Error should mention memory, got: " << err;
}

TEST(LuaRuntimeMemory, MemoryUnlimitedByDefault) {
  // Default constructor has no limit (limit == 0)
  LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetMemoryLimit(), 0u);

  // Large allocation should succeed
  const auto res = rt.ExecuteScript("return string.rep('x', 100000)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  const auto& vals = std::get<std::vector<LuaPtr>>(res);
  ASSERT_EQ(vals.size(), 1u);
  EXPECT_EQ(std::get<std::string>(vals[0]->value).size(), 100000u);
}

TEST(LuaRuntimeMemory, MemoryTrackingAccuracy) {
  LuaRuntime rt(LuaRuntime::AllLibraries());

  size_t before = rt.GetMemoryUsage();

  // Create a table with many entries — should increase usage
  (void)rt.ExecuteScript(R"(
    t = {}
    for i = 1, 1000 do
      t[i] = string.rep('a', 100)
    end
  )");

  size_t after_alloc = rt.GetMemoryUsage();
  EXPECT_GT(after_alloc, before) << "Memory should increase after allocations";

  // Free the table and collect garbage
  (void)rt.ExecuteScript("t = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT);

  size_t after_gc = rt.GetMemoryUsage();
  EXPECT_LT(after_gc, after_alloc) << "Memory should decrease after GC";
}

TEST(LuaRuntimeMemory, MemoryConfigWithNoLimit) {
  // RuntimeConfig with max_memory=0 means unlimited
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_memory = 0;
  LuaRuntime rt(config);
  EXPECT_EQ(rt.GetMemoryLimit(), 0u);

  // Large allocation should succeed
  const auto res = rt.ExecuteScript("return string.rep('x', 100000)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
}

TEST(LuaRuntimeMemory, RecoveryAfterOOM) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_memory = 256 * 1024;  // 256 KB
  LuaRuntime rt(config);

  // Trigger OOM
  const auto res1 = rt.ExecuteScript("return string.rep('x', 1024 * 1024)");
  ASSERT_TRUE(std::holds_alternative<std::string>(res1));

  // Context should still work for small operations
  const auto res2 = rt.ExecuteScript("return 1 + 2");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res2)[0]->value), 3);
}

// ---- Execution time limits (maxInstructions) ----

// --- GC control (lua_gc pass-through) ---

TEST(LuaRuntimeGC, CountReportsPositiveKilobytes) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto res = rt.GarbageCollect("count");
  ASSERT_TRUE(std::holds_alternative<double>(res));
  EXPECT_GT(std::get<double>(res), 0.0);
}

TEST(LuaRuntimeGC, CountTracksAllocationAndCollection) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const double before = std::get<double>(rt.GarbageCollect("count"));

  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(
      rt.ExecuteScript("store = {} for i = 1, 20000 do store[i] = { n = i } end")));
  const double held = std::get<double>(rt.GarbageCollect("count"));
  EXPECT_GT(held, before + 512);  // at least 512KB of live tables

  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(
      rt.ExecuteScript("store = nil")));
  (void)rt.GarbageCollect("collect");
  EXPECT_LT(std::get<double>(rt.GarbageCollect("count")), held - 512);
}

TEST(LuaRuntimeGC, CollectReturnsMonostate) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_TRUE(std::holds_alternative<std::monostate>(rt.GarbageCollect("collect")));
}

TEST(LuaRuntimeGC, CollectRunsFinalizers) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(rt.ExecuteScript(R"(
    finalized = 0
    do
      local t = setmetatable({}, { __gc = function() finalized = finalized + 1 end })
    end
  )")));
  (void)rt.GarbageCollect("collect");
  EXPECT_EQ(std::get<int64_t>(rt.GetGlobal("finalized")->value), 1);
}

TEST(LuaRuntimeGC, StopRestartAndIsRunning) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_TRUE(std::get<bool>(rt.GarbageCollect("isrunning")));

  EXPECT_TRUE(std::holds_alternative<std::monostate>(rt.GarbageCollect("stop")));
  EXPECT_FALSE(std::get<bool>(rt.GarbageCollect("isrunning")));

  EXPECT_TRUE(std::holds_alternative<std::monostate>(rt.GarbageCollect("restart")));
  EXPECT_TRUE(std::get<bool>(rt.GarbageCollect("isrunning")));
}

TEST(LuaRuntimeGC, StepReturnsBoolAndEventuallyFinishesACycle) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_TRUE(std::holds_alternative<bool>(rt.GarbageCollect("step")));

  (void)rt.GarbageCollect("stop");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(
      rt.ExecuteScript("for i = 1, 20000 do local t = { n = i } end")));
  bool finished = false;
  for (int i = 0; i < 10000 && !finished; ++i) {
    finished = std::get<bool>(rt.GarbageCollect("step", 4096));
  }
  EXPECT_TRUE(finished);
  (void)rt.GarbageCollect("restart");
}

TEST(LuaRuntimeGC, ModeSwitchReturnsPreviousMode) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  // Whatever the starting mode, the reported previous mode must track the
  // switches we make.
  (void)rt.GarbageCollect("incremental");
  EXPECT_EQ(std::get<std::string>(rt.GarbageCollect("generational")), "incremental");
  EXPECT_EQ(std::get<std::string>(rt.GarbageCollect("incremental")), "generational");
}

TEST(LuaRuntimeGC, UnknownCommandThrows) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_THROW((void)rt.GarbageCollect("explode"), std::runtime_error);
  EXPECT_THROW((void)rt.GarbageCollect(""), std::runtime_error);
}

TEST(LuaRuntimeGC, ParamReadsAndWrites) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  const int original = rt.GarbageCollectParam("pause", -1);
  EXPECT_GT(original, 0);
  // A negative value reads without writing.
  EXPECT_EQ(rt.GarbageCollectParam("pause", -1), original);
  // A write returns the previous value and takes effect.
  EXPECT_EQ(rt.GarbageCollectParam("pause", 400), original);
  EXPECT_EQ(rt.GarbageCollectParam("pause", -1), 400);
}

TEST(LuaRuntimeGC, ParamAcceptsEveryDocumentedName) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  for (const char* name : {"minormul", "majorminor", "minormajor",
                           "pause", "stepmul", "stepsize"}) {
    EXPECT_GE(rt.GarbageCollectParam(name, -1), 0) << "param: " << name;
  }
}

TEST(LuaRuntimeGC, ParamRejectsUnknownNameAndOutOfRangeValue) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_THROW((void)rt.GarbageCollectParam("nope", -1), std::runtime_error);
  EXPECT_THROW((void)rt.GarbageCollectParam("pause", LuaRuntime::kMaxGCParam + 1),
               std::runtime_error);
}

TEST(LuaRuntimeGC, WorksOnABareStateWithNoLibraries) {
  const LuaRuntime rt;
  EXPECT_GT(std::get<double>(rt.GarbageCollect("count")), 0.0);
  EXPECT_TRUE(std::get<bool>(rt.GarbageCollect("isrunning")));
  EXPECT_TRUE(std::holds_alternative<std::monostate>(rt.GarbageCollect("collect")));
}

TEST(LuaRuntimeGC, StoppedCollectorStillHonorsTheMemoryLimit) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_memory = 4 * 1024 * 1024;
  const LuaRuntime rt(config);
  (void)rt.GarbageCollect("stop");

  // Lua runs an emergency collection when an allocation would exceed the cap,
  // even with automatic collection stopped, so transient garbage is survivable.
  EXPECT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(
      rt.ExecuteScript("for i = 1, 2000 do local s = string.rep('x', 1024) end")));

  // The cap is nonetheless still a cap.
  const auto res = rt.ExecuteScript(
      "keep = {} for i = 1, 1e6 do keep[i] = string.rep('x', 1024) end");
  EXPECT_TRUE(std::holds_alternative<std::string>(res));
}

// --- GetConfig: the record a caller replays to build a replacement state
// (how the binding layer implements reset()) ---

TEST(LuaRuntimeConfig, ConfigConstructorRoundTrips) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 4 * 1024 * 1024;
  config.max_instructions = 500000;
  const LuaRuntime rt(config);

  EXPECT_EQ(rt.GetConfig().libraries, LuaRuntime::SafeLibraries());
  EXPECT_EQ(rt.GetConfig().max_memory, 4u * 1024 * 1024);
  EXPECT_EQ(rt.GetConfig().max_instructions, 500000u);
}

TEST(LuaRuntimeConfig, LibraryListConstructorRecordsLibraries) {
  const LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetConfig().libraries, LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetConfig().max_memory, 0u);
  EXPECT_EQ(rt.GetConfig().max_instructions, 0u);
}

TEST(LuaRuntimeConfig, DefaultConstructorRecordsBareState) {
  const LuaRuntime rt;
  EXPECT_TRUE(rt.GetConfig().libraries.empty());
}

// --- Id(): the identity token the binding stamps class instances with.
// It must be monotonic rather than address-derived: the binding used a raw
// LuaRuntime*, and once a context was collected the allocator handed its block
// to the next state, so an instance from the dead context passed the live one's
// ownership check (CR-14 F2).

TEST(LuaRuntimeIdentity, DistinctRuntimesHaveDistinctIds) {
  const LuaRuntime a;
  const LuaRuntime b;
  EXPECT_NE(a.Id(), b.Id());
  EXPECT_EQ(a.Id(), a.Id());  // stable for a given state
}

TEST(LuaRuntimeIdentity, IdIsNotReusedAfterAStateIsDestroyed) {
  // The property the raw pointer did not have. Record an id, destroy the state,
  // then build replacements in the same storage and confirm none reuses it.
  uint64_t retired = 0;
  const void* retired_addr = nullptr;
  {
    const LuaRuntime doomed;
    retired = doomed.Id();
    retired_addr = static_cast<const void*>(&doomed);
  }

  bool address_was_reused = false;
  for (int i = 0; i < 32; ++i) {
    const auto fresh = std::make_unique<LuaRuntime>();
    EXPECT_NE(fresh->Id(), retired);
    if (static_cast<const void*>(fresh.get()) == retired_addr) {
      address_was_reused = true;
    }
  }
  // Not an assertion about the allocator — just a note that when reuse does
  // happen (it commonly does), the id still separates the two states.
  (void)address_was_reused;
}

TEST(LuaRuntimeConfig, SetMaxInstructionsUpdatesConfig) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetMaxInstructions(250000);
  EXPECT_EQ(rt.GetConfig().max_instructions, 250000u);
}

TEST(LuaRuntimeConfig, ReplayedConfigProducesAnEquivalentState) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_instructions = 1000000;
  auto original = std::make_unique<LuaRuntime>(config);
  original->SetGlobal("x", std::make_shared<LuaValue>(LuaValue::from(int64_t{42})));

  // Build the replacement from the original's own record, then drop the
  // original — the sequence reset() performs.
  auto replacement = std::make_unique<LuaRuntime>(original->GetConfig());
  original.reset();

  // Same libraries: 'safe' has math but not os.
  EXPECT_EQ(std::get<int64_t>(
      std::get<std::vector<LuaPtr>>(
          replacement->ExecuteScript("return math.floor(3.7)"))[0]->value), 3);
  EXPECT_TRUE(std::holds_alternative<std::monostate>(
      replacement->GetGlobal("os")->value));

  // Clean globals: the original's global did not carry over.
  EXPECT_TRUE(std::holds_alternative<std::monostate>(
      replacement->GetGlobal("x")->value));

  // Same execution limit, still enforced.
  EXPECT_EQ(replacement->GetMaxInstructions(), 1000000u);
  const auto res = replacement->ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"),
            std::string::npos);
}

TEST(LuaRuntimeInstructions, UnlimitedByDefault) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetMaxInstructions(), 0u);
  // A long but finite loop completes when unlimited.
  const auto res = rt.ExecuteScript("local s=0; for i=1,2000000 do s=s+1 end; return s");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2000000);
}

TEST(LuaRuntimeInstructions, ConfigConstructorSetsLimit) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 1000000;
  LuaRuntime rt(config);
  EXPECT_EQ(rt.GetMaxInstructions(), 1000000u);
}

TEST(LuaRuntimeInstructions, InfiniteLoopAborts) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 1000000;
  LuaRuntime rt(config);

  const auto res = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"), std::string::npos)
      << "got: " << std::get<std::string>(res);
}

TEST(LuaRuntimeInstructions, NormalScriptCompletes) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 1000000;
  LuaRuntime rt(config);

  const auto res = rt.ExecuteScript("local s=0; for i=1,100 do s=s+i end; return s");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 5050);
}

TEST(LuaRuntimeInstructions, BudgetResetsBetweenExecutions) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 200000;
  LuaRuntime rt(config);

  // Each call runs well under the limit; the counter must not carry over.
  for (int i = 0; i < 20; ++i) {
    const auto res = rt.ExecuteScript("local s=0; for j=1,1000 do s=s+j end; return s");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res))
        << "iteration " << i << " failed: " << std::get<std::string>(res);
    EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 500500);
  }
}

TEST(LuaRuntimeInstructions, ContextRecoversAfterAbort) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 1000000;
  LuaRuntime rt(config);

  const auto res1 = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res1));

  const auto res2 = rt.ExecuteScript("return 1 + 2");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res2)[0]->value), 3);
}

TEST(LuaRuntimeInstructions, SetMaxInstructionsPostConstruction) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_EQ(rt.GetMaxInstructions(), 0u);

  rt.SetMaxInstructions(500000);
  EXPECT_EQ(rt.GetMaxInstructions(), 500000u);
  const auto res = rt.ExecuteScript("while true do end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"), std::string::npos);

  // Removing the limit lets a finite loop complete again.
  rt.SetMaxInstructions(0);
  EXPECT_EQ(rt.GetMaxInstructions(), 0u);
  const auto res2 = rt.ExecuteScript("local s=0; for i=1,2000000 do s=s+1 end; return s");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res2));
}

// M5: allocating API methods run under a protected frame, so hitting maxMemory
// throws a catchable std::runtime_error instead of an unprotected panic/abort.
// Drives a runtime's maxMemory budget to within a few bytes of the wall and
// leaves it there, so the next allocation Lua attempts genuinely fails. The
// failing allocation triggers an emergency GC, which hands back whatever garbage
// the run itself made — hence the repeat until a round can no longer fit even
// one more node. Nodes are fixed-size on purpose: a growing array that fails to
// double leaves a doubling's worth of slack behind, which is plenty of room for
// the small allocations these tests are trying to make fail.
static void ExhaustLuaMemory(const LuaRuntime& rt) {
  (void)rt.ExecuteScript("ballast = nil; added = 0");
  for (int round = 0; round < 16; ++round) {
    const auto exhaust = rt.ExecuteScript(R"(
      added = 0
      pcall(function()
        while true do ballast = {prev = ballast}; added = added + 1 end
      end)
      return added
    )");
    if (!std::holds_alternative<std::vector<LuaPtr>>(exhaust)) break;
    const auto& added = std::get<std::vector<LuaPtr>>(exhaust);
    if (added.empty() || std::get<int64_t>(added[0]->value) == 0) break;
  }
}

TEST(LuaRuntimeProtectedAlloc, CreateTableFromOverLimitThrowsInsteadOfAborting) {
  RuntimeConfig config;
  config.max_memory = 512 * 1024;  // small budget; bare state fits easily
  LuaRuntime rt(config);

  // A large array initializer forces lua_createtable to pre-size an array part
  // far bigger than the remaining budget → LUA_ERRMEM inside the protected frame.
  LuaArray big;
  big.reserve(300000);
  for (int i = 0; i < 300000; ++i) {
    big.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(i))));
  }
  EXPECT_THROW({ (void)rt.CreateTableFrom(big); }, std::runtime_error);

  // The runtime is not corrupted: a small table still builds fine afterward.
  const int ref = rt.CreateTable();
  EXPECT_NE(ref, LUA_NOREF);
  EXPECT_NE(ref, LUA_REFNIL);
}

// CR-2 M5 residual, pinned to a concrete instance by CR-7: materializing a
// *result* that has to survive as a registry reference — a metatabled table,
// function, thread or Lua userdata — runs luaL_ref, which allocates. On the
// bare-API paths that conversion happens after the execution pcall has already
// returned, so under an exhausted maxMemory the LUA_ERRMEM longjmped with no
// protected frame in sight → panic → process abort. It must now come back as an
// ordinary error result.
TEST(LuaRuntimeProtectedAlloc, ResultConversionUnderExhaustedMemoryReportsInsteadOfAborting) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 1024 * 1024;  // bare state + safe libraries fit comfortably
  LuaRuntime rt(config);

  // Take the function handle first — everything the call itself needs must exist
  // before the budget is gone.
  const auto setup = rt.ExecuteScript(R"(
    marked = setmetatable({}, {})
    return function() return marked end
  )");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(setup));
  const auto& setupValues = std::get<std::vector<LuaPtr>>(setup);
  ASSERT_EQ(setupValues.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaFunctionRef>(setupValues[0]->value));
  const auto& funcRef = std::get<LuaFunctionRef>(setupValues[0]->value);

  ExhaustLuaMemory(rt);

  // Every call refs `marked` into the registry again, and holding the results
  // keeps those slots off the free list — so within a few iterations the registry
  // has to grow, an allocation that can no longer succeed. The assertion that
  // really matters is that the process is still alive to make it.
  std::vector<ScriptResult> held;
  bool reportedError = false;
  for (int i = 0; i < 512 && !reportedError; ++i) {
    held.push_back(rt.CallFunction(funcRef, {}));
    reportedError = std::holds_alternative<std::string>(held.back());
  }
  EXPECT_TRUE(reportedError);
}

// The other half of the M5 residual class: the bare-API entry points used to
// stage their arguments — the key string, and for the setters the entire
// PushLuaValue of the caller's value — on the caller's stack BEFORE entering the
// protected frame, so an OOM while staging panicked just as the result
// conversion did. Keys/values here are >40 chars so Lua allocates a long string
// rather than reusing an interned short one, which makes the failure exact
// rather than incidental.
TEST(LuaRuntimeProtectedAlloc, ArgumentStagingUnderExhaustedMemoryThrowsInsteadOfAborting) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 1024 * 1024;
  LuaRuntime rt(config);

  const int tableRef = rt.CreateTable();  // taken while there is still budget
  ASSERT_NE(tableRef, LUA_NOREF);

  // Well past 40 chars, so Lua allocates a fresh long string rather than reusing
  // an interned short one — and large enough that it cannot fit in the few
  // hundred bytes of slack the emergency GC hands back when the budget is hit.
  const std::string longKey(64 * 1024, 'k');
  const auto longValue = std::make_shared<LuaValue>(
    LuaValue::from(std::string(64 * 1024, 'v')));

  // Each failed attempt leaves a little slack behind — the emergency GC that
  // accompanies the failure reclaims the garbage that attempt made — so the
  // budget is driven back to the wall before every case.
  const auto atTheWall = [&](const char* what, const std::function<void()>& op) {
    ExhaustLuaMemory(rt);
    SCOPED_TRACE(what);
    EXPECT_THROW(op(), std::runtime_error);
  };

  // Reading a global: the key push inside PushProtectedGlobal.
  atTheWall("GetGlobal", [&]() { (void)rt.GetGlobal(longKey); });
  // Writing a global: the key push AND the whole of PushLuaValue.
  atTheWall("SetGlobal", [&]() { rt.SetGlobal(longKey, longValue); });
  // The same two staging steps on the table-reference API, string and typed keys.
  atTheWall("GetTableField", [&]() { (void)rt.GetTableField(tableRef, longKey); });
  atTheWall("SetTableField", [&]() { rt.SetTableField(tableRef, longKey, longValue); });
  atTheWall("HasTableFieldKeyed",
            [&]() { (void)rt.HasTableFieldKeyed(tableRef, TableKey(longKey)); });
  atTheWall("SetTableFieldKeyed",
            [&]() { rt.SetTableFieldKeyed(tableRef, TableKey(longKey), longValue); });
}

TEST(LuaRuntimeProtectedAlloc, RegisterFunctionAndCreateTableStillWorkUnderLimit) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 4 * 1024 * 1024;  // ample
  LuaRuntime rt(config);

  // Normal (within-budget) protected operations succeed unchanged.
  rt.RegisterFunction("answer", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(42)));
  });
  const auto res = rt.ExecuteScript("return answer()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 42);

  const int ref = rt.CreateTableFrom(LuaArray{
    std::make_shared<LuaValue>(LuaValue::from(std::string("ok")))});
  EXPECT_NE(ref, LUA_NOREF);
}

// CR-8 F6: an ERRMEM raised by the result push inside a host-call bridge used
// to longjmp straight to the enclosing pcall, skipping the destructors of the
// bridge's live C++ locals (the args vector and the result holder — here a
// 200k-element LuaArray of shared_ptrs). The push now runs in its own pcall
// frame, so the failure comes back as an ordinary Lua error after the locals
// are destroyed. The leak is pinned via the sentinel's use_count — LSan is not
// available under Apple clang, so the refcount is the observable.
TEST(LuaRuntimeProtectedAlloc, HostFunctionResultPushUnderExhaustedMemoryReportsAndFrees) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 1024 * 1024;
  LuaRuntime rt(config);

  // Built in C++ heap (unbounded); only the *push* into Lua hits maxMemory.
  LuaArray big;
  big.reserve(200000);
  for (int i = 0; i < 200000; ++i) {
    big.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(i))));
  }
  auto sentinel = std::make_shared<LuaValue>(LuaValue::from(std::move(big)));
  rt.RegisterFunction("bigresult",
    [sentinel](const std::vector<LuaPtr>&) -> LuaPtr { return sentinel; });

  // Take the function handle while there is still budget, so the call itself
  // needs no compilation once the budget is gone.
  const auto setup = rt.ExecuteScript("return bigresult");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(setup));
  const auto& setupValues = std::get<std::vector<LuaPtr>>(setup);
  ASSERT_EQ(setupValues.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaFunctionRef>(setupValues[0]->value));
  const auto& funcRef = std::get<LuaFunctionRef>(setupValues[0]->value);

  ExhaustLuaMemory(rt);

  // The 200k-element push cannot fit in the emergency-GC slack, so the first
  // call's result push fails and must surface as an ordinary error result.
  const auto res = rt.CallFunction(funcRef, {});
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("memory"), std::string::npos);

  // The F6 pin: the bridge's resultHolder was destroyed on the failure path.
  // Before the fix the ERRMEM longjmp skipped its destructor, leaving this
  // count at 3 forever. Expected owners now: this local + the lambda capture.
  EXPECT_EQ(sentinel.use_count(), 2);

  // The runtime is not corrupted: release the ballast and run something small
  // (the 200k result itself can never fit a 1 MB budget, exhausted or not).
  (void)rt.ExecuteScript("ballast = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);
  const auto again = rt.ExecuteScript("return 1 + 1");
  EXPECT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(again));
}

// The same F6 class on the property-getter bridge (UserdataIndex): the pushed
// property value fails mid-push under an exhausted budget and must surface as
// a Lua error, not longjmp over the getter result's destructor.
TEST(LuaRuntimeProtectedAlloc, PropertyGetterPushUnderExhaustedMemoryReportsAndFrees) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::SafeLibraries();
  config.max_memory = 1024 * 1024;
  LuaRuntime rt(config);

  LuaArray big;
  big.reserve(200000);
  for (int i = 0; i < 200000; ++i) {
    big.push_back(std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(i))));
  }
  auto sentinel = std::make_shared<LuaValue>(LuaValue::from(std::move(big)));
  rt.SetPropertyHandlers(
    [sentinel](int, const std::string&) -> LuaPtr { return sentinel; },
    nullptr);
  rt.CreateProxyUserdataGlobal("obj", 1);

  // A closure taken up front, so the failing call needs no compilation.
  const auto setup = rt.ExecuteScript("return function() return obj.anything end");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(setup));
  const auto& setupValues = std::get<std::vector<LuaPtr>>(setup);
  ASSERT_EQ(setupValues.size(), 1u);
  ASSERT_TRUE(std::holds_alternative<LuaFunctionRef>(setupValues[0]->value));
  const auto& funcRef = std::get<LuaFunctionRef>(setupValues[0]->value);

  ExhaustLuaMemory(rt);

  const auto res = rt.CallFunction(funcRef, {});
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("memory"), std::string::npos);

  // The F6 pin (see the host-function variant): the getter result's holder
  // must have been destroyed despite the failed push.
  EXPECT_EQ(sentinel.use_count(), 2);

  (void)rt.ExecuteScript("ballast = nil");
  lua_gc(rt.RawState(), LUA_GCCOLLECT, 0);
  const auto again = rt.ExecuteScript("return 1 + 1");
  EXPECT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(again));
}

// H9c: registry unrefs are deferred while a worker run is bracketed and drained
// by EndWorkerUnrefDeferral, and are immediate otherwise. (The thread-safety is
// exercised by the async TS suite; this pins the queue-or-drain logic.)
TEST(LuaRuntimeWorkerUnref, DeferredDuringWorkerThenDrainedLeavesStateUsable) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  lua_State* L = rt.RawState();

  rt.BeginWorkerUnrefDeferral();
  // Stand in for main-thread finalizers freeing registry slots mid-run.
  std::vector<int> refs;
  for (int i = 0; i < 128; ++i) {
    lua_pushinteger(L, i);
    refs.push_back(luaL_ref(L, LUA_REGISTRYINDEX));
  }
  for (int ref : refs) rt.UnrefOrDefer(ref);  // queued, not unref'd yet
  rt.EndWorkerUnrefDeferral();                 // drains the queue

  // The state is intact and fully usable after the drain.
  const auto res = rt.ExecuteScript("return 1 + 1");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
}

TEST(LuaRuntimeWorkerUnref, ImmediateUnrefWhenNoWorkerActive) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  lua_State* L = rt.RawState();

  // Outside a worker bracket, UnrefOrDefer frees the slot immediately, so it is
  // available for reuse by the next luaL_ref.
  lua_pushinteger(L, 42);
  const int ref = luaL_ref(L, LUA_REGISTRYINDEX);
  rt.UnrefOrDefer(ref);
  lua_pushinteger(L, 43);
  const int reused = luaL_ref(L, LUA_REGISTRYINDEX);
  EXPECT_EQ(reused, ref);  // Lua's registry free-list reclaims the freed slot
  luaL_unref(L, LUA_REGISTRYINDEX, reused);
}

// ---- CODE-REVIEW-9 regressions ----

// F1: the core now owns the "Lua is executing on this state" fact, so a caller
// that would free or replace the lua_State (the binding layer's reset()) can
// consult it instead of relying on a binding-side counter that only eight of
// the thirty-six entry points maintained.
TEST(LuaRuntimeExecuting, FalseWhenIdle) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  EXPECT_FALSE(rt.IsExecuting());
  (void)rt.ExecuteScript("return 1");
  EXPECT_FALSE(rt.IsExecuting());  // and again once the execution has returned
}

TEST(LuaRuntimeExecuting, TrueInsideAHostCallback) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool observed = false;
  rt.RegisterFunction("probe", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    observed = rt.IsExecuting();
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  (void)rt.ExecuteScript("probe()");
  EXPECT_TRUE(observed);
}

// The paths CR-9 F1 found unguarded: a metamethod reached through the
// protected-global path and through the table-reference API. Both run Lua, and
// before the fix neither marked the state as executing.
TEST(LuaRuntimeExecuting, TrueInsideAGlobalsMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool observed = false;
  rt.RegisterFunction("probe", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    observed = rt.IsExecuting();
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  (void)rt.ExecuteScript(
    "setmetatable(_G, { __index = function(t, k) probe() return 7 end })");
  observed = false;
  (void)rt.GetGlobal("no_such_global");   // fires __index via PushProtectedGlobal
  EXPECT_TRUE(observed);
  EXPECT_FALSE(rt.IsExecuting());         // and is cleared on the way out
}

TEST(LuaRuntimeExecuting, TrueInsideATableRefMetamethod) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool observed = false;
  rt.RegisterFunction("probe", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    observed = rt.IsExecuting();
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  (void)rt.ExecuteScript(
    "t = setmetatable({}, { __index = function(tbl, k) probe() return 7 end })");
  const auto ref = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(ref));
  observed = false;
  (void)rt.GetTableField(std::get<int>(ref), "missing");  // RunProtected path
  EXPECT_TRUE(observed);
  EXPECT_FALSE(rt.IsExecuting());
}

// The vector that needed no metatable at all: an ordinary __gc finalizer
// reached from lua_gc, which is the one path into user Lua that goes through no
// lua_pcall of ours.
TEST(LuaRuntimeExecuting, TrueInsideAGcFinalizer) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool observed = false;
  bool ran = false;
  rt.RegisterFunction("probe", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    ran = true;
    observed = rt.IsExecuting();
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  (void)rt.ExecuteScript(
    "do local t = setmetatable({}, { __gc = function() probe() end }) end");
  (void)rt.GarbageCollect("collect");
  ASSERT_TRUE(ran) << "the finalizer never ran; the test proves nothing";
  EXPECT_TRUE(observed);
  EXPECT_FALSE(rt.IsExecuting());
}

// F2: the per-execution budget is started by the same scope, so a metamethod
// reached through the table-reference API gets a fresh budget instead of
// inheriting whatever the previous execution left behind.
TEST(LuaRuntimeTimeout, TableRefMetamethodGetsAFreshDeadline) {
  LuaRuntime rt = MakeTimedRuntime(200);
  (void)rt.ExecuteScript(
    "t = setmetatable({}, { __index = function(tbl, k)"
    "  local s = 0 for i = 1, 20000 do s = s + i end return s end })");
  const auto ref = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(ref));

  // Idle past the deadline the execute_script above set. Before the fix the
  // read below was judged against it and aborted with "execution timeout".
  std::this_thread::sleep_for(std::chrono::milliseconds(400));
  const LuaPtr value = rt.GetTableField(std::get<int>(ref), "anything");
  ASSERT_TRUE(std::holds_alternative<int64_t>(value->value));
  EXPECT_EQ(std::get<int64_t>(value->value), 200010000);
}

TEST(LuaRuntimeInstructions, TableRefMetamethodBudgetDoesNotAccumulate) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 200000;
  LuaRuntime rt(config);
  (void)rt.ExecuteScript(
    "t = setmetatable({}, { __index = function(tbl, k)"
    "  local s = 0 for i = 1, 20000 do s = s + i end return s end })");
  const auto ref = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(ref));

  // Each read costs ~20k instructions, an order of magnitude inside the limit.
  // Before the fix the tally carried across reads and the fifth one raised.
  for (int i = 0; i < 30; ++i) {
    const LuaPtr value = rt.GetTableField(std::get<int>(ref), "k");
    ASSERT_TRUE(std::holds_alternative<int64_t>(value->value))
      << "read " << i << " did not return a number (budget exhausted?)";
    EXPECT_EQ(std::get<int64_t>(value->value), 200010000);
  }
}

// The limits must still bind on those paths — the defect was mistimed
// enforcement, never an escape.
TEST(LuaRuntimeTimeout, EndlessTableRefMetamethodStillAborts) {
  LuaRuntime rt = MakeTimedRuntime(200);
  (void)rt.ExecuteScript(
    "t = setmetatable({}, { __index = function() while true do end end })");
  const auto ref = rt.GetGlobalRef("t");
  ASSERT_TRUE(std::holds_alternative<int>(ref));
  EXPECT_THROW((void)rt.GetTableField(std::get<int>(ref), "x"), std::runtime_error);
}

// A nested entry shares the enclosing budget rather than refreshing it, so
// re-entering Lua from a host callback can no longer extend a limit the outer
// execution is already spending.
TEST(LuaRuntimeInstructions, NestedExecutionDoesNotRefreshTheBudget) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 300000;
  LuaRuntime rt(config);
  rt.RegisterFunction("reenter", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    (void)rt.ExecuteScript("return 1");  // nested: must not reset the tally
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  const auto res = rt.ExecuteScript("while true do reenter() end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"),
            std::string::npos);
}

// F4: the output handler is invoked through a copied owner, so a handler that
// clears itself mid-call cannot destroy the std::function it is running on.
TEST(LuaRuntimeOutput, HandlerMayClearItselfMidCall) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::vector<std::string> seen;
  rt.SetOutputHandler([&](const std::string& text) {
    seen.push_back(text);
    if (seen.size() == 2) rt.SetOutputHandler(nullptr);
  });
  (void)rt.ExecuteScript(R"(print("a") print("b") print("c"))");
  EXPECT_EQ(seen.size(), 2u);
  const auto res = rt.ExecuteScript("return 1 + 1");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
}

TEST(LuaRuntimeOutput, HandlerMayReplaceItselfMidCall) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::vector<std::string> seen;
  rt.SetOutputHandler([&](const std::string& text) {
    seen.push_back("1:" + text);
    if (seen.size() == 2) {
      rt.SetOutputHandler([&](const std::string& t) { seen.push_back("2:" + t); });
    }
  });
  (void)rt.ExecuteScript(R"(print("a") print("b") print("c"))");
  ASSERT_EQ(seen.size(), 3u);
  EXPECT_EQ(seen[2].substr(0, 2), "2:");
}

// Lua is built as C: an exception from the handler must not unwind through the
// print C frame.
TEST(LuaRuntimeOutput, ThrowingHandlerIsContained) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.SetOutputHandler([](const std::string&) {
    throw std::runtime_error("handler blew up");
  });
  const auto res = rt.ExecuteScript(R"(print("x") return 1 + 1)");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 2);
}

// ---- CODE-REVIEW-10 regressions ----

namespace {

// A chunk long enough that parsing it allocates continuously, and whose final
// line is a syntax error. The parse therefore does thousands of allocations —
// each able to drive a GC step — and then fails, so the body NEVER runs. Any
// finalizer observed while loading this chunk was reached from the parser, not
// from executing it, which is what makes the F1 pins airtight.
std::string BigUnparseableChunk() {
  std::string s = "local x = 0\n";
  for (int i = 0; i < 4000; ++i) s += "x = x + 1\n";
  s += "this is not lua\n";
  return s;
}

// Creates `n` finalizable objects whose __gc calls the host function "probe",
// leaving GC work pending for whatever runs next.
void ArmFinalizers(const LuaRuntime& rt, int n) {
  (void)rt.ExecuteScript(
    "for i = 1, " + std::to_string(n) +
    " do local t = setmetatable({}, { __gc = function() probe() end }); t = nil end");
}

// Shared body of the F1 pins: arm finalizers, run `load` (which parses the
// unparseable chunk), and report whether a finalizer was reached from inside it
// and what it saw IsExecuting() report. Repeats until a finalizer actually fires
// so the assertion can never pass vacuously.
struct LoadProbe {
  bool ran = false;
  bool observed = false;
  bool in_load = false;   // gates recording to the load under test
};

// Held by shared_ptr and captured *by value*: the registered wrapper is stored
// on the runtime and therefore outlives this function, so capturing the state by
// reference would leave the lambda reading a dead stack frame when a finalizer
// fires later (notably during ~LuaRuntime's lua_close). UBSan catches it.
using LoadProbePtr = std::shared_ptr<LoadProbe>;

LoadProbePtr ProbeChunkLoad(LuaRuntime& rt, const std::function<void()>& load) {
  auto probe = std::make_shared<LoadProbe>();
  LuaRuntime* rt_ptr = &rt;   // outlives the lambda: the lambda lives inside rt
  rt.RegisterFunction("probe", [probe, rt_ptr](const std::vector<LuaPtr>&) -> LuaPtr {
    // Only count finalizers reached from inside the load under test; the
    // ArmFinalizers script below is itself an execution and would otherwise
    // answer the question for us.
    if (probe->in_load) {
      probe->ran = true;
      probe->observed = rt_ptr->IsExecuting();
    }
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  for (int attempt = 0; attempt < 25 && !probe->ran; ++attempt) {
    ArmFinalizers(rt, 200);
    probe->in_load = true;
    load();
    probe->in_load = false;
  }
  return probe;
}

}  // namespace

// F1: a chunk load allocates continuously while parsing, so it can drive a GC
// step whose __gc finalizers re-enter the host. That makes the loaders as
// re-entrant as any metamethod even though no user Lua "runs" in them — the
// trigger for opening an ExecutionScope is "can allocate from Lua", not "runs
// Lua". Before the fix these reported IsExecuting() == false, which disarmed
// reset()'s reentrancy guard and freed the lua_State under the parser.
TEST(LuaRuntimeExecuting, TrueInsideAFinalizerReachedByCompileScript) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const std::string chunk = BigUnparseableChunk();
  const LoadProbePtr p = ProbeChunkLoad(rt, [&] { (void)rt.CompileScript(chunk); });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the parse; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

TEST(LuaRuntimeExecuting, TrueInsideAFinalizerReachedByExecuteScriptLoad) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const std::string chunk = BigUnparseableChunk();
  const LoadProbePtr p = ProbeChunkLoad(rt, [&] { (void)rt.ExecuteScript(chunk); });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the parse; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

TEST(LuaRuntimeExecuting, TrueInsideAFinalizerReachedByCreateCoroutineFromScript) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const std::string chunk = BigUnparseableChunk();
  const LoadProbePtr p =
    ProbeChunkLoad(rt, [&] { (void)rt.CreateCoroutineFromScript(chunk); });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the parse; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

TEST(LuaRuntimeExecuting, TrueInsideAFinalizerReachedByExecuteScriptInEnvironment) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const int env = rt.CreateEnvironment({}, /*inherit=*/true);
  const std::string chunk = BigUnparseableChunk();
  const LoadProbePtr p =
    ProbeChunkLoad(rt, [&] { (void)rt.ExecuteScriptInEnvironment(env, chunk); });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the parse; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

TEST_F(LuaFileTest, ExecutingIsTrueInsideAFinalizerReachedByCompileFile) {
  WriteFile(BigUnparseableChunk());
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const LoadProbePtr p = ProbeChunkLoad(rt, [&] { (void)rt.CompileFile(tmp_path_); });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the parse; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

TEST_F(LuaFileTest, ExecutingIsTrueInsideAFinalizerReachedByExecuteFileLoad) {
  WriteFile(BigUnparseableChunk());
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const LoadProbePtr p = ProbeChunkLoad(rt, [&] { (void)rt.ExecuteFile(tmp_path_); });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the parse; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

// LoadBytecode undumps rather than parses, which allocates the same way: the
// chunk is constant-heavy rather than instruction-heavy because the undumper
// interns every distinct string it reads, and all 6000 live inside a function
// the chunk never calls so the body stays trivial.
//
// This one is a **guard, not a regression pin**, and passes with or without the
// load's ExecutionScope. Unlike its six siblings above, LoadBytecode's failure
// mode cannot be isolated: its ProtectedCall has been bracketed since CR-9, so
// a finalizer that misses the undump window is still caught microseconds later
// by the call. Attempts to force the finalizer into the undump alone (a
// truncated dump; a body that allocates nothing) did not reproduce. Kept
// because it does verify the combined path never reports IsExecuting() ==
// false, which is the property reset() actually depends on.
TEST(LuaRuntimeExecuting, TrueInsideAFinalizerReachedByLoadBytecode) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::string source = "local function unused()\n  local a\n";
  for (int i = 0; i < 6000; ++i) {
    source += "  a = \"lua-native-unique-constant-" + std::to_string(i) + "\"\n";
  }
  source += "end\nreturn 1";
  const auto compiled = rt.CompileScript(source);
  ASSERT_TRUE(std::holds_alternative<std::vector<uint8_t>>(compiled));
  const auto& bytecode = std::get<std::vector<uint8_t>>(compiled);

  const LoadProbePtr p = ProbeChunkLoad(rt, [&] {
    const auto res = rt.LoadBytecode(bytecode);
    // The body must stay trivial — if it ever starts doing real work this stops
    // isolating the undump.
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  });
  ASSERT_TRUE(p->ran) << "no finalizer ran during the undump; the pin proves nothing";
  EXPECT_TRUE(p->observed);
  EXPECT_FALSE(rt.IsExecuting());
}

// The scope must not leak past the load: a chunk load is not an execution, and
// leaving the depth raised would wedge reset() permanently.
TEST(LuaRuntimeExecuting, FalseAfterAFailedChunkLoad) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.CompileScript("this is not lua");
  EXPECT_FALSE(rt.IsExecuting());
  (void)rt.ExecuteScript("this is not lua either");
  EXPECT_FALSE(rt.IsExecuting());
  (void)rt.CreateCoroutineFromScript("nor is this @@@");
  EXPECT_FALSE(rt.IsExecuting());
}

// F3: only the collecting lua_gc commands run finalizers, so only they claim
// IsExecuting(). Bracketing the read-only ones made the flag mean less than it
// says (and needlessly restarted the per-execution budget).
TEST(LuaRuntimeExecuting, FalseForNonCollectingGcCommands) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.GarbageCollect("count");
  EXPECT_FALSE(rt.IsExecuting());
  (void)rt.GarbageCollect("isrunning");
  EXPECT_FALSE(rt.IsExecuting());
  (void)rt.GarbageCollectParam("pause", -1);
  EXPECT_FALSE(rt.IsExecuting());
  // ...but the collecting ones still do (the CR-9 F1 vector).
  bool observed = false, ran = false;
  rt.RegisterFunction("probe", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    ran = true;
    observed = rt.IsExecuting();
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  (void)rt.ExecuteScript(
    "do local t = setmetatable({}, { __gc = function() probe() end }) end");
  (void)rt.GarbageCollect("collect");
  ASSERT_TRUE(ran);
  EXPECT_TRUE(observed);
}

// A read-only gc() command must not restart the per-execution instruction
// budget — it runs no Lua, so it is not an execution boundary.
TEST(LuaRuntimeInstructions, ReadOnlyGcCommandDoesNotRefreshTheBudget) {
  RuntimeConfig config;
  config.libraries = LuaRuntime::AllLibraries();
  config.max_instructions = 200000;
  LuaRuntime rt(config);

  // A host callback that burns budget, then calls a read-only gc() command. If
  // gc('count') restarted the budget, the loop below would never be aborted.
  rt.RegisterFunction("peek", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    (void)rt.GarbageCollect("count");
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  const auto res = rt.ExecuteScript("while true do peek() end");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("instruction limit exceeded"),
            std::string::npos);
}

// F2: the binding owner unbinds the JS-callback bridge before its own members
// die. ~LuaRuntime clears the other four handler slots for exactly this reason;
// host_functions_ had no equivalent, so lua_close's __gc metamethods dispatched
// into a half-destroyed owner.
TEST(LuaRuntimeHostFunctions, ClearHostFunctionsUnbindsTheBridge) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool called = false;
  rt.RegisterFunction("cb", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    called = true;
    return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(1)));
  });
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(rt.ExecuteScript("return cb()")));
  ASSERT_TRUE(called);

  rt.ClearHostFunctions();
  called = false;
  // The Lua-side closure survives; calling it now raises rather than dispatching
  // into the (notionally destroyed) owner.
  const auto res = rt.ExecuteScript("return cb()");
  ASSERT_TRUE(std::holds_alternative<std::string>(res));
  EXPECT_NE(std::get<std::string>(res).find("not found"), std::string::npos);
  EXPECT_FALSE(called);
}

// The state must stay usable afterwards: clearing the bridge is a teardown step,
// not a corruption.
TEST(LuaRuntimeHostFunctions, StateRemainsUsableAfterClearHostFunctions) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  rt.RegisterFunction("cb", [](const std::vector<LuaPtr>&) -> LuaPtr {
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  rt.ClearHostFunctions();
  const auto res = rt.ExecuteScript("return 6 * 7");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(res)[0]->value), 42);
}

// A __gc finalizer firing after the bridge is cleared must degrade to a
// contained Lua warning, not a crash — the teardown shape, exercised while the
// runtime is still alive so the failure mode is observable.
TEST(LuaRuntimeHostFunctions, FinalizerAfterClearHostFunctionsIsContained) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  bool called = false;
  rt.RegisterFunction("cb", [&](const std::vector<LuaPtr>&) -> LuaPtr {
    called = true;
    return std::make_shared<LuaValue>(LuaValue::nil());
  });
  (void)rt.ExecuteScript(
    "do local t = setmetatable({}, { __gc = function() cb() end }) end");
  rt.ClearHostFunctions();
  (void)rt.GarbageCollect("collect");   // fires the finalizer; must not abort
  EXPECT_FALSE(called);
  const auto res = rt.ExecuteScript("return 1 + 1");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(res));
}

// ---- CODE-REVIEW-11 regressions ----

// F3: the "can allocate from Lua" invariant (CR-10 F1) reaches further than the
// chunk loaders. Any allocation can drive a GC step, a GC step runs pending
// __gc finalizers, and a finalizer is Lua that can re-enter the host — so
// argument staging (which pushes caller-supplied tables, strings and closures)
// and the collector-mode switches (which drive a full cycle) must be bracketed
// too.
//
// These pins live here rather than in the TypeScript suite deliberately: every
// binding entry point that reaches these paths opens its own CallScope, so
// reset() is rejected either way and a JS-level test cannot fail. The fact
// under test is the core's, and only the core can observe it.
namespace {
// Arms a __gc finalizer that records rt.IsExecuting() each time it runs, and
// leaves `count` finalizable objects pending. Returns the recorder.
//
// Declare one BEFORE its LuaRuntime: members are destroyed in reverse order, so
// a probe declared after the runtime would be gone by the time ~LuaRuntime's
// lua_close fires the still-pending finalizers into it — the exact use-after-
// free shape CR-10 F2 is about, and ASan catches it in the harness too.
struct ExecutingProbe {
  std::vector<bool> observations;

  void Arm(LuaRuntime& rt, int count) {
    rt.RegisterFunction("probe", [this, &rt](const std::vector<LuaPtr>&) -> LuaPtr {
      observations.push_back(rt.IsExecuting());
      return std::make_shared<LuaValue>(LuaValue::nil());
    });
    (void)rt.ExecuteScript(
      "function mk(n) for i=1,n do "
      "  local t = setmetatable({}, {__gc = function() probe() end}); t = nil "
      "end end");
    (void)rt.ExecuteScript("mk(" + std::to_string(count) + ")");
    observations.clear();
  }

  [[nodiscard]] bool AnyAtDepthZero() const {
    for (const bool executing : observations) {
      if (!executing) return true;
    }
    return false;
  }
};

// A caller-supplied argument big enough that staging it certainly allocates —
// and therefore certainly drives a GC step with finalizers pending.
LuaPtr BigArgument() {
  LuaTable big;
  for (int i = 0; i < 40000; ++i) {
    big.emplace("k" + std::to_string(i),
                std::make_shared<LuaValue>(LuaValue::from(std::string(96, 'x'))));
  }
  return std::make_shared<LuaValue>(LuaValue::from(std::move(big)));
}
}  // namespace

TEST(LuaRuntimeExecuting, TrueWhileStagingCallFunctionArguments) {
  ExecutingProbe probe;  // outlives rt: see ExecutingProbe
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("function target(x) return 1 end");
  probe.Arm(rt, 4000);

  const LuaPtr fn = rt.GetGlobal("target");
  ASSERT_TRUE(std::holds_alternative<LuaFunctionRef>(fn->value));
  (void)rt.CallFunction(std::get<LuaFunctionRef>(fn->value), {BigArgument()});

  // The staging must actually have driven the collector, or the pin is vacuous.
  ASSERT_FALSE(probe.observations.empty())
    << "no finalizer ran during argument staging; the probe proves nothing";
  EXPECT_FALSE(probe.AnyAtDepthZero());
  EXPECT_FALSE(rt.IsExecuting());  // and the scope is closed on the way out
}

TEST(LuaRuntimeExecuting, TrueWhileStagingResumeArguments) {
  ExecutingProbe probe;  // outlives rt: see ExecutingProbe
  LuaRuntime rt(LuaRuntime::AllLibraries());
  (void)rt.ExecuteScript("co_body = function(x) return 1 end");
  const LuaPtr fn = rt.GetGlobal("co_body");
  ASSERT_TRUE(std::holds_alternative<LuaFunctionRef>(fn->value));
  const auto co = rt.CreateCoroutine(std::get<LuaFunctionRef>(fn->value));
  ASSERT_TRUE(std::holds_alternative<LuaThreadRef>(co));
  probe.Arm(rt, 4000);

  (void)rt.ResumeCoroutine(std::get<LuaThreadRef>(co), {BigArgument()});

  ASSERT_FALSE(probe.observations.empty());
  EXPECT_FALSE(probe.AnyAtDepthZero());
}

TEST(LuaRuntimeExecuting, TrueWhileStagingAsyncResumeValues) {
  ExecutingProbe probe;  // outlives rt: see ExecutingProbe
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const auto co = rt.CreateCoroutineFromScript("local a = ... ; return 1");
  ASSERT_TRUE(std::holds_alternative<LuaThreadRef>(co));
  probe.Arm(rt, 4000);

  (void)rt.ResumeAsyncStep(std::get<LuaThreadRef>(co), {BigArgument()}, false);

  ASSERT_FALSE(probe.observations.empty());
  EXPECT_FALSE(probe.AnyAtDepthZero());
}

// CR-10 F3 narrowed GarbageCollect's scope to "collect"/"step". The collector
// mode switches also run finalizers — luaC_changemode drives a full cycle,
// including the state that calls __gc — so they lost a guard they had.
TEST(LuaRuntimeExecuting, TrueInsideAModeSwitchFinalizer) {
  ExecutingProbe probe;  // outlives rt: see ExecutingProbe
  LuaRuntime rt(LuaRuntime::AllLibraries());
  probe.Arm(rt, 600);

  (void)rt.GarbageCollect("generational");

  ASSERT_FALSE(probe.observations.empty())
    << "gc('generational') ran no finalizer; the pin proves nothing";
  EXPECT_FALSE(probe.AnyAtDepthZero());
  EXPECT_FALSE(rt.IsExecuting());
}

// Control: the read-only commands genuinely run no Lua, so CR-10 F3 was right
// about those and they must stay unbracketed.
TEST(LuaRuntimeExecuting, ReadOnlyGcCommandsAreNotExecutions) {
  ExecutingProbe probe;  // outlives rt: see ExecutingProbe
  LuaRuntime rt(LuaRuntime::AllLibraries());
  probe.Arm(rt, 600);

  (void)rt.GarbageCollect("count");
  (void)rt.GarbageCollect("isrunning");
  (void)rt.GarbageCollect("stop");
  (void)rt.GarbageCollect("restart");

  EXPECT_TRUE(probe.observations.empty())
    << "a read-only gc() command ran a finalizer; it needs a scope after all";
  EXPECT_FALSE(rt.IsExecuting());
}

// F2: a host function that replaces its own registration mid-call used to
// move-assign over the std::function being executed, freeing its captures.
//
// The capture list is deliberately larger than libc++'s small-object buffer
// (3 pointers). A callable that fits inline lives in the map node rather than
// on the heap, so the same defect corrupts nothing an allocator can see — the
// binding's wrapper captures a LuaContext*, a std::string and a shared_ptr and
// is comfortably past the threshold, so the pin must be too. `tag` is read
// *after* the re-registration, which is the access that faulted.
TEST(LuaRuntimeHostFunctions, ReplacingAHostFunctionMidCallIsSafe) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  std::string observed;
  const std::string tag(64, 'x');  // by value below: forces heap storage
  rt.RegisterFunction("swap", [&rt, &observed, tag](const std::vector<LuaPtr>&) -> LuaPtr {
    // Replace this very name while its callable is on the C stack.
    rt.RegisterFunction("swap", [](const std::vector<LuaPtr>&) -> LuaPtr {
      return std::make_shared<LuaValue>(LuaValue::from(std::string("second")));
    });
    // Then keep using state the (now-replaced) closure captured.
    observed = "first" + tag.substr(0, 0);
    return std::make_shared<LuaValue>(LuaValue::from(std::string("first")));
  });

  const auto first = rt.ExecuteScript("return swap()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(first));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(first)[0]->value), "first");
  EXPECT_EQ(observed, "first");

  // The replacement takes effect from the next call, not the in-flight one.
  const auto second = rt.ExecuteScript("return swap()");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(second));
  EXPECT_EQ(std::get<std::string>(std::get<std::vector<LuaPtr>>(second)[0]->value), "second");
}

TEST(LuaRuntimeHostFunctions, ReplacingAMetamethodHostFunctionMidCallIsSafe) {
  LuaRuntime rt(LuaRuntime::AllLibraries());
  const std::string tag(64, 'y');  // see above: keeps the closure off the SBO
  rt.StoreHostFunction("mm", [&rt, tag](const std::vector<LuaPtr>&) -> LuaPtr {
    rt.StoreHostFunction("mm", [](const std::vector<LuaPtr>&) -> LuaPtr {
      return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(2)));
    });
    // Read a capture after the replacement — the faulting access.
    return std::make_shared<LuaValue>(
      LuaValue::from(static_cast<int64_t>(tag.empty() ? 0 : 1)));
  });
  (void)rt.ExecuteScript("t = {}");
  std::vector<MetatableEntry> entries;
  MetatableEntry e;
  e.key = "__index";
  e.is_function = true;
  e.func_name = "mm";
  entries.push_back(std::move(e));
  rt.SetGlobalMetatable("t", entries);

  const auto r1 = rt.ExecuteScript("return t.anything");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(r1));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(r1)[0]->value), 1);
  const auto r2 = rt.ExecuteScript("return t.anything");
  ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(r2));
  EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(r2)[0]->value), 2);
}

// F5: ~LuaRuntime cleared three of the five handlers that bridge into an owner,
// leaving the proxy-userdata property handlers installed across lua_close. A
// __gc finalizer that reads a property off a proxy userdata during teardown
// reached them. The binding detaches them itself, so this is only observable
// from direct use of the core — which is exactly why the core must not rely on
// its caller, as the destructor's own comment says.
TEST(LuaRuntimeHostFunctions, PropertyHandlersAreUnboundBeforeClose) {
  bool getter_ran_during_teardown = false;
  bool closing = false;
  {
    LuaRuntime rt(LuaRuntime::AllLibraries());
    rt.SetPropertyHandlers(
      [&](int, const std::string&) -> LuaPtr {
        if (closing) getter_ran_during_teardown = true;
        return std::make_shared<LuaValue>(LuaValue::from(static_cast<int64_t>(7)));
      },
      [](int, const std::string&, const LuaPtr&) {});
    rt.CreateProxyUserdataGlobal("ud", 1);
    // The handler is reachable while the state is open...
    const auto live = rt.ExecuteScript("return ud.field");
    ASSERT_TRUE(std::holds_alternative<std::vector<LuaPtr>>(live));
    EXPECT_EQ(std::get<int64_t>(std::get<std::vector<LuaPtr>>(live)[0]->value), 7);
    // ...and a finalizer that indexes it is left pending at lua_close.
    (void)rt.ExecuteScript(
      "_G.keep = setmetatable({}, { __gc = function() local _ = ud.field end })");
    closing = true;
  }  // ~LuaRuntime: lua_close fires the finalizer
  EXPECT_FALSE(getter_ran_during_teardown);
}

int main(int argc, char **argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}