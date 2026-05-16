#ifdef PERF_LENS_HAVE_LLVM

#include "reduction_fp.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Expr.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* op = result.Nodes.getNodeAs<BinaryOperator>("red");
        if (!op) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(op->getBeginLoc())) return;

        const QualType lhsTy = op->getLHS()->IgnoreParenImpCasts()->getType();
        if (!lhsTy->isRealFloatingType()) return;

        const auto loc = sm.getPresumedLoc(op->getBeginLoc());
        const std::string typeName = lhsTy.getAsString();
        Finding f;
        f.rule_id    = "perf-lens.vec.reduction-fp";
        f.title      = "FP reduction may benefit from -ffast-math";
        f.message    = "Floating-point '" + typeName + "' accumulation in a loop is not "
                       "auto-vectorised by default because IEEE 754 mandates sequential "
                       "evaluation. Enable '-ffast-math' (or '-fassociative-math') to allow "
                       "the compiler to reorder the additions and emit SIMD reductions "
                       "(e.g. vhaddps / vfmadd). Confirm that small rounding differences "
                       "are acceptable for your use case before enabling.";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::HotPath;
        f.confidence = ConfidenceLevel::Low;
        f.build_id   = _build_id;
        _out.push_back(std::move(f));
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void ReductionFpRule::registerMatchers(MatchFinder& finder, const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    const auto kLoopAncestor = stmt(anyOf(
        forStmt(), whileStmt(), doStmt(), cxxForRangeStmt()));

    // Match `acc += expr` or `acc -= expr` where acc has a floating-point type.
    finder.addMatcher(
        binaryOperator(
            anyOf(hasOperatorName("+="), hasOperatorName("-=")),
            hasLHS(expr(hasType(realFloatingPointType()))),
            hasAncestor(kLoopAncestor)
        ).bind("red"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> ReductionFpRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
