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
  ASSERT_TRUE(gv.has_value());
  EXPECT_EQ(std::get<int64_t>((*gv)->value), 42);

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

int main(int argc, char **argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}