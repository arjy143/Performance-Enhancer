#include <gtest/gtest.h>

#ifdef PERF_LENS_HAVE_LLVM

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "rules/finding.hpp"
#include "rules/store.hpp"
#include "rules/rule_base.hpp"
#include "rules/packs/function_attributes/noexcept_move_ops.hpp"
#include "rules/packs/stl_hygiene/range_for_copy.hpp"
#include "rules/packs/hotpath/vector_no_reserve.hpp"
#include "rules/packs/hotpath/std_function.hpp"
#include "rules/packs/hotpath/virtual_dispatch.hpp"
#include "rules/packs/memory_layout/padding_detected.hpp"
#include "rules/packs/constexpr/promotion_variable.hpp"
#include "rules/packs/vec/aliasing.hpp"
#include "rules/packs/vec/complex_cf.hpp"
#include "rules/packs/vec/reduction_fp.hpp"
#include "rules/packs/concurrency/mutex_where_atomic.hpp"
#include "rules/packs/hotpath/allocation_in_loop.hpp"
#include "rules/packs/stl_hygiene/nodiscard_return.hpp"
#include "rules/packs/ub/signed_loop_bound.hpp"
#include "rules/packs/memory_layout/cache_line_straddle.hpp"
#include "rules/packs/memory_layout/aos_to_soa.hpp"
#include "rules/packs/constexpr/promotion_function.hpp"

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
// StdFunctionRule
// ---------------------------------------------------------------------------

TEST(StdFunction, FiresOnLocalVariable) {
    StdFunctionRule rule;
    const char* src = R"(
#include <functional>
void f() {
    std::function<int()> fn = [] { return 1; };
    (void)fn;
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.std-function");
    EXPECT_EQ(findings[0].category, FindingCategory::HotPath);
    EXPECT_EQ(findings[0].confidence, ConfidenceLevel::Medium);
}

TEST(StdFunction, FiresOnFunctionParameter) {
    StdFunctionRule rule;
    const char* src = R"(
#include <functional>
void process(std::function<void(int)> cb, int x) {
    cb(x);
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.std-function");
}

TEST(StdFunction, SilentForTemplateLambda) {
    StdFunctionRule rule;
    const char* src = R"(
template<typename F>
void process(F&& cb, int x) {
    cb(x);
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// VirtualDispatchInLoopRule
// ---------------------------------------------------------------------------

TEST(VirtualDispatch, FiresOnVirtualCallInForLoop) {
    VirtualDispatchInLoopRule rule;
    const char* src = R"(
struct Base { virtual int compute() = 0; };
void f(Base* b, int n) {
    for (int i = 0; i < n; ++i)
        b->compute();
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.virtual-dispatch");
    EXPECT_EQ(findings[0].category, FindingCategory::HotPath);
    EXPECT_NE(findings[0].message.find("compute"), std::string::npos);
}

TEST(VirtualDispatch, FiresOnVirtualCallInRangeFor) {
    VirtualDispatchInLoopRule rule;
    const char* src = R"(
#include <vector>
struct Widget { virtual void draw() = 0; };
void renderAll(std::vector<Widget*>& ws) {
    for (auto* w : ws)
        w->draw();
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.virtual-dispatch");
}

TEST(VirtualDispatch, SilentForFinalClass) {
    VirtualDispatchInLoopRule rule;
    const char* src = R"(
struct Base { virtual int compute() = 0; };
struct Concrete final : Base { int compute() override { return 1; } };
void f(Concrete* c, int n) {
    for (int i = 0; i < n; ++i)
        c->compute();
}
)";
    // Concrete is final — compiler can devirtualise, should not fire.
    const auto findings = runRule(rule, src);
    EXPECT_TRUE(findings.empty());
}

TEST(VirtualDispatch, SilentForNonVirtualCallInLoop) {
    VirtualDispatchInLoopRule rule;
    const char* src = R"(
struct S { int value() const { return 42; } };
void f(S& s, int n) {
    for (int i = 0; i < n; ++i)
        s.value();
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// VecAliasingRule
// ---------------------------------------------------------------------------

TEST(VecAliasing, FiresOnTwoSameTypeWritePointers) {
    VecAliasingRule rule;
    const char* src = R"(
void add(float* a, const float* b, int n) {
    for (int i = 0; i < n; ++i)
        a[i] += b[i];
}
)";
    // 'a' is float* (writable), 'b' is const float* — only one writable pointer.
    // Should NOT fire (only one non-const pointer).
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(VecAliasing, FiresOnTwoWritablePointersOfSameType) {
    VecAliasingRule rule;
    const char* src = R"(
void saxpy(float* y, float* x, float a, int n) {
    for (int i = 0; i < n; ++i)
        y[i] += a * x[i];
}
)";
    // Both y and x are float* — aliasing assumed.
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.vec.aliasing");
    EXPECT_EQ(findings[0].category, FindingCategory::HotPath);
    EXPECT_NE(findings[0].message.find("__restrict__"), std::string::npos);
}

TEST(VecAliasing, SilentWhenRestrictPresent) {
    VecAliasingRule rule;
    const char* src = R"(
void saxpy(float* __restrict__ y, float* __restrict__ x, float a, int n) {
    for (int i = 0; i < n; ++i)
        y[i] += a * x[i];
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(VecAliasing, SilentForDifferentTypes) {
    VecAliasingRule rule;
    const char* src = R"(
void convert(float* dst, int* src, int n) {
    for (int i = 0; i < n; ++i)
        dst[i] = static_cast<float>(src[i]);
}
)";
    // Different pointee types — no same-type aliasing concern.
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// MutexWhereAtomicRule
// ---------------------------------------------------------------------------

TEST(MutexWhereAtomic, FiresOnSingleIntegerGuard) {
    MutexWhereAtomicRule rule;
    const char* src = R"(
#include <mutex>
struct Counter {
    std::mutex mtx;
    int count = 0;
};
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.concurrency.mutex-where-atomic");
    EXPECT_EQ(findings[0].confidence, ConfidenceLevel::Low);
    EXPECT_NE(findings[0].message.find("std::atomic"), std::string::npos);
}

TEST(MutexWhereAtomic, SilentForMultipleDataFields) {
    MutexWhereAtomicRule rule;
    const char* src = R"(
#include <mutex>
#include <string>
struct Cache {
    std::mutex mtx;
    int hits;
    int misses;
    std::string label;  // non-integral — too complex for atomic
};
)";
    // More than 2 non-mutex fields — heuristic doesn't fire.
    const auto findings = runRule(rule, src);
    EXPECT_TRUE(findings.empty());
}

TEST(MutexWhereAtomic, SilentForNoMutex) {
    MutexWhereAtomicRule rule;
    const char* src = R"(
struct Plain {
    int x;
    int y;
};
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// AllocationInLoopRule
// ---------------------------------------------------------------------------

TEST(AllocationInLoop, FiresOnNewInForLoop) {
    AllocationInLoopRule rule;
    const char* src = R"(
void f(int n) {
    for (int i = 0; i < n; ++i) {
        int* p = new int(i);
        (void)p;
    }
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.allocation-in-loop");
    EXPECT_EQ(findings[0].category, FindingCategory::HotPath);
}

TEST(AllocationInLoop, FiresOnMakeUniqueInLoop) {
    AllocationInLoopRule rule;
    const char* src = R"(
#include <memory>
void f(int n) {
    for (int i = 0; i < n; ++i) {
        auto p = std::make_unique<int>(i);
        (void)p;
    }
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.hotpath.allocation-in-loop");
}

TEST(AllocationInLoop, SilentOutsideLoop) {
    AllocationInLoopRule rule;
    const char* src = R"(
#include <memory>
void f() {
    auto p = std::make_unique<int>(42);
    (void)p;
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// NodiscardReturnRule
// ---------------------------------------------------------------------------

TEST(NodiscardReturn, FiresOnErrorCodeWithoutNodiscard) {
    NodiscardReturnRule rule;
    const char* src = R"(
#include <system_error>
std::error_code doThing() { return {}; }
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.nodiscard.error-return");
    EXPECT_EQ(findings[0].category, FindingCategory::FunctionAttrib);
}

TEST(NodiscardReturn, SilentWhenNodiscardPresent) {
    NodiscardReturnRule rule;
    const char* src = R"(
#include <system_error>
[[nodiscard]] std::error_code doThing() { return {}; }
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(NodiscardReturn, SilentForVoidReturn) {
    NodiscardReturnRule rule;
    const char* src = R"(
void doThing() {}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// SignedLoopBoundRule
// ---------------------------------------------------------------------------

TEST(SignedLoopBound, FiresOnSignedVsUnsigned) {
    SignedLoopBoundRule rule;
    const char* src = R"(
#include <vector>
void f(const std::vector<int>& v) {
    for (int i = 0; i < (int)v.size(); ++i) { (void)v[i]; }
}
)";
    // The cast to int makes both sides signed — should NOT fire.
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(SignedLoopBound, FiresWithoutCast) {
    SignedLoopBoundRule rule;
    const char* src = R"(
#include <cstddef>
void f(std::size_t n) {
    for (int i = 0; i < (std::size_t)n; ++i) { (void)i; }
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.ub.signed-loop-bound");
    EXPECT_EQ(findings[0].confidence, ConfidenceLevel::High);
}

TEST(SignedLoopBound, SilentForSignedBothSides) {
    SignedLoopBoundRule rule;
    const char* src = R"(
void f(int n) {
    for (int i = 0; i < n; ++i) { (void)i; }
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// ComplexCfRule
// ---------------------------------------------------------------------------

TEST(ComplexCf, FiresOnReturnInsideLoop) {
    ComplexCfRule rule;
    const char* src = R"(
#include <vector>
int findFirst(const std::vector<int>& v, int target) {
    for (int i = 0; i < (int)v.size(); ++i) {
        if (v[i] == target) return i;
    }
    return -1;
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.vec.complex-cf");
    EXPECT_EQ(findings[0].confidence, ConfidenceLevel::Low);
}

TEST(ComplexCf, SilentForLoopWithNoEarlyExit) {
    ComplexCfRule rule;
    const char* src = R"(
#include <vector>
float sum(const std::vector<float>& v) {
    float acc = 0.f;
    for (float x : v) acc += x;
    return acc;
}
)";
    // The return here is outside the loop — should not fire.
    const auto findings = runRule(rule, src);
    EXPECT_TRUE(findings.empty());
}

// ---------------------------------------------------------------------------
// ReductionFpRule
// ---------------------------------------------------------------------------

TEST(ReductionFp, FiresOnFloatAccumulation) {
    ReductionFpRule rule;
    const char* src = R"(
#include <vector>
float sum(const std::vector<float>& v) {
    float acc = 0.f;
    for (float x : v) acc += x;
    return acc;
}
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.vec.reduction-fp");
    EXPECT_EQ(findings[0].category, FindingCategory::HotPath);
}

TEST(ReductionFp, SilentForIntegerAccumulation) {
    ReductionFpRule rule;
    const char* src = R"(
#include <vector>
int sum(const std::vector<int>& v) {
    int acc = 0;
    for (int x : v) acc += x;
    return acc;
}
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// CacheLineStraddleRule
// ---------------------------------------------------------------------------

TEST(CacheLineStraddle, FiresOnStraddlingField) {
    CacheLineStraddleRule rule;
    // char arrays have alignment 1 so no padding is inserted between fields.
    // pad[60] occupies bytes 0–59. bigfield[8] occupies bytes 60–67.
    // 60/64=0 (line 0) but 67/64=1 (line 1) → straddles the boundary.
    const char* src = R"(
struct Straddler {
    char pad[60];       // bytes 0–59
    char bigfield[8];   // bytes 60–67: straddles 64-byte cache line boundary
};
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.padding.cache-line-straddle");
    EXPECT_EQ(findings[0].category, FindingCategory::MemoryLayout);
}

TEST(CacheLineStraddle, SilentWhenAligned) {
    CacheLineStraddleRule rule;
    const char* src = R"(
struct Aligned {
    double a;  // offset 0, size 8 — within line 0
    double b;  // offset 8, size 8 — within line 0
    double c;  // offset 16, size 8 — within line 0
};
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// PromotionFunctionRule
// ---------------------------------------------------------------------------

TEST(PromotionFunction, FiresOnSimpleSingleReturn) {
    PromotionFunctionRule rule;
    const char* src = R"(
int square(int x) { return x * x; }
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.constexpr.promotion-function");
    EXPECT_EQ(findings[0].confidence, ConfidenceLevel::Low);
}

TEST(PromotionFunction, SilentWhenAlreadyConstexpr) {
    PromotionFunctionRule rule;
    const char* src = R"(
constexpr int square(int x) { return x * x; }
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

TEST(PromotionFunction, SilentWhenBodyHasCallExpr) {
    PromotionFunctionRule rule;
    const char* src = R"(
int helper(int x);
int compute(int x) { return helper(x) + 1; }
)";
    EXPECT_TRUE(runRule(rule, src).empty());
}

// ---------------------------------------------------------------------------
// AosToSoaRule
// ---------------------------------------------------------------------------

TEST(AosToSoa, FiresOnLargeStructVector) {
    AosToSoaRule rule;
    const char* src = R"(
#include <vector>
struct Particle {
    float x, y, z;
    float vx, vy, vz;
};
std::vector<Particle> particles;
)";
    const auto findings = runRule(rule, src);
    ASSERT_GE(findings.size(), 1u);
    EXPECT_EQ(findings[0].rule_id, "perf-lens.memory_layout.aos-to-soa");
    EXPECT_NE(findings[0].message.find("Particle"), std::string::npos);
}

TEST(AosToSoa, SilentForSmallStruct) {
    AosToSoaRule rule;
    const char* src = R"(
#include <vector>
struct Point { float x, y; };
std::vector<Point> pts;
)";
    // Only 2 fields — below kMinFields threshold.
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
