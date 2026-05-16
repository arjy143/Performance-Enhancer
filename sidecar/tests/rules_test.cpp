#include <gtest/gtest.h>

#ifdef PERF_LENS_HAVE_LLVM

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "rules/finding.hpp"
#include "rules/rule_base.hpp"
#include "rules/packs/function_attributes/noexcept_move_ops.hpp"
#include "rules/packs/stl_hygiene/range_for_copy.hpp"
#include "rules/packs/hotpath/vector_no_reserve.hpp"
#include "rules/packs/memory_layout/padding_detected.hpp"
#include "rules/packs/constexpr/promotion_variable.hpp"

#include <clang/Tooling/Tooling.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/Frontend/ASTUnit.h>

using namespace perf_lens::rules;
using namespace clang;
using namespace clang::ast_matchers;

// ---------------------------------------------------------------------------
// Helper: run a single rule against C++ source code (as a string).
// ---------------------------------------------------------------------------

static std::vector<Finding> runRule(Rule& rule, const std::string& source,
                                     const std::string& filename = "test.cpp") {
    // Build an in-memory AST from the source string.
    auto ast = clang::tooling::buildASTFromCodeWithArgs(
        source,
        {"-std=c++20", "-w"},   // suppress warnings from fixture code itself
        filename);

    if (!ast) return {};

    MatchFinder finder;
    rule.registerMatchers(finder, "test");
    finder.matchAST(ast->getASTContext());
    return rule.takeFindings();
}

// ---------------------------------------------------------------------------
// NoexceptMoveOpsRule
// ---------------------------------------------------------------------------

TEST(NoexceptMoveOps, FiresOnMissingNoexcept) {
    NoexceptMoveOpsRule rule;
    const char* src = R"(
struct BigObj {
    int data[64];
    BigObj(BigObj&&) {}
    BigObj& operator=(BigObj&&) { return *this; }
};
)";
    const auto findings = runRule(rule, src);
    EXPECT_EQ(findings.size(), 2u);
    for (const auto& f : findings) {
        EXPECT_EQ(f.rule_id, "perf-lens.noexcept.move-ops");
        EXPECT_EQ(f.category, FindingCategory::FunctionAttrib);
        EXPECT_EQ(f.confidence, ConfidenceLevel::High);
    }
}

TEST(NoexceptMoveOps, SilentWhenNoexceptPresent) {
    NoexceptMoveOpsRule rule;
    const char* src = R"(
struct Good {
    int x;
    Good(Good&&) noexcept = default;
    Good& operator=(Good&&) noexcept = default;
};
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(NoexceptMoveOps, SilentForCopyOps) {
    NoexceptMoveOpsRule rule;
    // Copy ctor/assign without noexcept — this rule should not fire for these.
    const char* src = R"(
struct S {
    int x;
    S(const S&) {}
    S& operator=(const S&) { return *this; }
};
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// RangeForCopyRule
// ---------------------------------------------------------------------------

TEST(RangeForCopy, FiresOnNonTrivialCopy) {
    RangeForCopyRule rule;
    const char* src = R"(
#include <vector>
#include <string>
void f(const std::vector<std::string>& v) {
    for (auto s : v) { (void)s; }
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.stl.range-for-copy");
}

TEST(RangeForCopy, SilentForConstRef) {
    RangeForCopyRule rule;
    const char* src = R"(
#include <vector>
#include <string>
void f(const std::vector<std::string>& v) {
    for (const auto& s : v) { (void)s; }
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(RangeForCopy, SilentForTrivialTypes) {
    RangeForCopyRule rule;
    const char* src = R"(
#include <vector>
void f(const std::vector<int>& v) {
    for (auto i : v) { (void)i; }
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// VectorNoReserveRule
// ---------------------------------------------------------------------------

TEST(VectorNoReserve, FiresOnPushBackInLoop) {
    VectorNoReserveRule rule;
    const char* src = R"(
#include <vector>
std::vector<int> build(int n) {
    std::vector<int> v;
    for (int i = 0; i < n; ++i)
        v.push_back(i);
    return v;
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.vector-no-reserve");
    EXPECT_EQ(findings[0].confidence, ConfidenceLevel::Medium);
}

TEST(VectorNoReserve, SilentOutsideLoop) {
    VectorNoReserveRule rule;
    const char* src = R"(
#include <vector>
void f(std::vector<int>& v, int x) {
    v.push_back(x);  // single push_back, not in a loop
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// PaddingDetectedRule
// ---------------------------------------------------------------------------

TEST(PaddingDetected, FiresOnWastedBytes) {
    PaddingDetectedRule rule;
    const char* src = R"(
struct Wasteful {
    char   a;
    double b;
    int    c;
};
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.padding.detected");
    EXPECT_EQ(findings[0].category, FindingCategory::MemoryLayout);
    EXPECT_NE(findings[0].message.find("padding"), std::string::npos);
}

TEST(PaddingDetected, SilentForOptimalLayout) {
    PaddingDetectedRule rule;
    const char* src = R"(
struct Optimal {
    double a;
    int    b;
    short  c;
    char   d;
    char   e;
};
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// PromotionVariableRule
// ---------------------------------------------------------------------------

TEST(PromotionVariable, FiresOnConstWithLiteralInit) {
    PromotionVariableRule rule;
    const char* src = R"(
void f() {
    const int x = 42;
    (void)x;
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.constexpr.promotion-variable");
}

TEST(PromotionVariable, SilentWhenAlreadyConstexpr) {
    PromotionVariableRule rule;
    const char* src = R"(
void f() {
    constexpr int x = 42;
    (void)x;
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(PromotionVariable, SilentForRuntimeInit) {
    PromotionVariableRule rule;
    const char* src = R"(
int get();
void f() {
    const int x = get();
    (void)x;
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// FindingStore
// ---------------------------------------------------------------------------

class FindingStoreTest : public ::testing::Test {
protected:
    std::filesystem::path db_path{"/tmp/perf-lens-test-findings.sqlite"};

    void SetUp()    override { std::filesystem::remove(db_path); }
    void TearDown() override { std::filesystem::remove(db_path); }
};

TEST_F(FindingStoreTest, InsertAndQueryByFile) {
    perf_lens::rules::FindingStore store(db_path);

    Finding f;
    f.rule_id    = "perf-lens.noexcept.move-ops";
    f.title      = "test";
    f.message    = "test message";
    f.file       = "/tmp/test.cpp";
    f.line       = 10;
    f.category   = FindingCategory::FunctionAttrib;
    f.confidence = ConfidenceLevel::High;
    f.build_id   = "test";

    EXPECT_EQ(store.insertBulk({f}), 1);

    const auto results = store.getFindings("/tmp/test.cpp");
    ASSERT_EQ(results.size(), 1u);
    EXPECT_EQ(results[0].rule_id, "perf-lens.noexcept.move-ops");
}

TEST_F(FindingStoreTest, ClearFileRemovesEntries) {
    perf_lens::rules::FindingStore store(db_path);

    Finding f;
    f.rule_id  = "perf-lens.stl.range-for-copy";
    f.file     = "/tmp/a.cpp";
    f.line     = 5;
    f.build_id = "t";

    store.insertBulk({f});
    EXPECT_EQ(store.getFindings("/tmp/a.cpp").size(), 1u);

    store.clearFile("/tmp/a.cpp");
    EXPECT_TRUE(store.getFindings("/tmp/a.cpp").empty());
}

TEST_F(FindingStoreTest, AffectedFilesReturnsDistinct) {
    perf_lens::rules::FindingStore store(db_path);

    auto make = [](const char* file) {
        Finding f;
        f.rule_id = "r"; f.file = file; f.line = 1; f.build_id = "t";
        return f;
    };
    store.insertBulk({make("/a.cpp"), make("/a.cpp"), make("/b.cpp")});

    EXPECT_EQ(store.affectedFiles().size(), 2u);
}

#else
// When LLVM is not available, provide a placeholder so the test binary still links.
TEST(RuleTests, LlvmNotAvailable) {
    GTEST_SKIP() << "LLVM not available — static analysis rule tests skipped";
}
#endif // PERF_LENS_HAVE_LLVM
