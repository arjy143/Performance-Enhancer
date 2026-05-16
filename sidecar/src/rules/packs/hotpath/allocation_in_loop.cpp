#ifdef PERF_LENS_HAVE_LLVM

#include "allocation_in_loop.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Expr.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

static const auto kLoopAncestor = stmt(anyOf(
    forStmt(), whileStmt(), doStmt(), cxxForRangeStmt()));

class NewExprCallback : public MatchFinder::MatchCallback {
public:
    NewExprCallback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const Stmt* node = nullptr;
        std::string what;

        if (const auto* e = result.Nodes.getNodeAs<CXXNewExpr>("new_expr")) {
            node = e;
            what = "operator new";
        } else if (const auto* c = result.Nodes.getNodeAs<CallExpr>("alloc_call")) {
            node = c;
            const auto* fd = c->getDirectCallee();
            what = fd ? fd->getNameAsString() : "allocating call";
        }
        if (!node) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(node->getBeginLoc())) return;

        const auto loc = sm.getPresumedLoc(node->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.hotpath.allocation-in-loop";
        f.title      = "heap allocation inside loop";
        f.message    = "'" + what + "' inside a loop triggers heap allocation on every iteration. "
                       "Hoist the allocation before the loop and reuse the buffer, "
                       "or use a stack-local arena / small-buffer optimisation.";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::HotPath;
        f.confidence = ConfidenceLevel::Medium;
        f.build_id   = _build_id;
        _out.push_back(std::move(f));
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void AllocationInLoopRule::registerMatchers(MatchFinder& finder,
                                             const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // `new T` / `new T[]`
    finder.addMatcher(
        cxxNewExpr(hasAncestor(kLoopAncestor)).bind("new_expr"),
        new NewExprCallback(_findings, _build_id));

    // make_unique / make_shared / malloc / calloc
    finder.addMatcher(
        callExpr(
            callee(functionDecl(anyOf(
                hasName("make_unique"), hasName("make_shared"),
                hasName("malloc"),     hasName("calloc"),
                hasName("realloc"),    hasName("operator new")))),
            hasAncestor(kLoopAncestor)
        ).bind("alloc_call"),
        new NewExprCallback(_findings, _build_id));
}

std::vector<Finding> AllocationInLoopRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
