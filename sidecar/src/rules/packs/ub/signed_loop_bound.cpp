#ifdef PERF_LENS_HAVE_LLVM

#include "signed_loop_bound.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Stmt.h>
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
        const auto* loop = result.Nodes.getNodeAs<ForStmt>("loop");
        if (!loop) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(loop->getBeginLoc())) return;

        const Expr* cond = loop->getCond();
        if (!cond) return;

        const auto* binop = dyn_cast<BinaryOperator>(cond->IgnoreParenImpCasts());
        if (!binop || !binop->isComparisonOp()) return;

        // Look through implicit casts to the original declared types.
        const QualType lhs = binop->getLHS()->IgnoreParenImpCasts()->getType();
        const QualType rhs = binop->getRHS()->IgnoreParenImpCasts()->getType();

        const bool lhsSigned   = lhs->isSignedIntegerType();
        const bool rhsSigned   = rhs->isSignedIntegerType();
        const bool lhsUnsigned = lhs->isUnsignedIntegerType();
        const bool rhsUnsigned = rhs->isUnsignedIntegerType();

        if (!((lhsSigned && rhsUnsigned) || (lhsUnsigned && rhsSigned))) return;

        const std::string signedSide   = lhsSigned   ? lhs.getAsString() : rhs.getAsString();
        const std::string unsignedSide = lhsUnsigned ? lhs.getAsString() : rhs.getAsString();

        const auto loc = sm.getPresumedLoc(loop->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.ub.signed-loop-bound";
        f.title      = "signed/unsigned mismatch in loop condition";
        f.message    = "Loop condition compares '" + signedSide + "' (signed) with '"
                       + unsignedSide + "' (unsigned). When the signed value is negative "
                       "the comparison is implementation-defined and may loop forever or "
                       "behave unexpectedly. Use 'std::ptrdiff_t' for the loop variable or "
                       "cast the bound to the signed type: "
                       "e.g. `for (int i = 0; i < static_cast<int>(v.size()); ++i)`.";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::HotPath;
        f.confidence = ConfidenceLevel::High;
        f.build_id   = _build_id;
        _out.push_back(std::move(f));
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void SignedLoopBoundRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    finder.addMatcher(forStmt().bind("loop"), new Callback(_findings, _build_id));
}

std::vector<Finding> SignedLoopBoundRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
