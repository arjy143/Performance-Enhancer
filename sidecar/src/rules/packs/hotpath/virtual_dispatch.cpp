#ifdef PERF_LENS_HAVE_LLVM

#include "virtual_dispatch.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Expr.h>
#include <clang/AST/Decl.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Match virtual member calls inside any kind of loop.
// We require the method to be declared virtual (not just overriding) to reduce
// false positives on final classes where devirtualisation is likely.

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* call = result.Nodes.getNodeAs<CXXMemberCallExpr>("vCall");
        if (!call || !call->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(call->getBeginLoc())) return;

        const auto loc = sm.getPresumedLoc(call->getBeginLoc());
        const auto* method = call->getMethodDecl();
        if (!method || !method->isVirtual()) return;

        // Skip calls on final classes — the compiler will likely devirtualise them.
        if (const auto* rec = method->getParent()) {
            if (rec->isEffectivelyFinal()) return;
        }

        Finding f;
        f.rule_id    = "perf-lens.hotpath.virtual-dispatch";
        f.title      = "Virtual dispatch inside loop";
        f.message    = "Virtual call to '" + method->getNameAsString() + "' inside a loop. "
                       "Each call goes through the vtable, preventing inlining and wasting "
                       "branch-predictor capacity. Consider: (1) devirtualise with CRTP or "
                       "a template parameter, (2) batch objects by type before the loop, "
                       "or (3) use final classes so the compiler can devirtualise.";
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
    std::string _build_id;
};

} // namespace

void VirtualDispatchInLoopRule::registerMatchers(MatchFinder& finder,
                                                  const std::string& build_id) {
    _build_id = build_id;
    // Virtual member call inside any loop statement
    finder.addMatcher(
        cxxMemberCallExpr(
            callee(cxxMethodDecl(isVirtual())),
            hasAncestor(stmt(anyOf(forStmt(), whileStmt(), doStmt(), cxxForRangeStmt())))
        ).bind("vCall"),
        new Callback(_findings, build_id)
    );
}

std::vector<Finding> VirtualDispatchInLoopRule::takeFindings() {
    return std::move(_findings);
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
