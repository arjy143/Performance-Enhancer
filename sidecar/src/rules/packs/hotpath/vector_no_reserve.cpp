#ifdef PERF_LENS_HAVE_LLVM

#include "vector_no_reserve.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Expr.h>
#include <clang/AST/Stmt.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Returns true if 'stmt' or any ancestor stmt is a loop.
bool hasLoopAncestor(const Stmt* stmt, ASTContext& ctx) {
    auto parents = ctx.getParents(*stmt);
    while (!parents.empty()) {
        const Stmt* parent = parents[0].get<Stmt>();
        if (!parent) break;
        if (isa<ForStmt>(parent) || isa<WhileStmt>(parent) ||
            isa<DoStmt>(parent)  || isa<CXXForRangeStmt>(parent))
            return true;
        parents = ctx.getParents(*parent);
    }
    return false;
}

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id,
             const char* rule_id, const char* title)
        : _out(out), _build_id(build_id), _rule_id(rule_id), _title(title) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* call = result.Nodes.getNodeAs<CXXMemberCallExpr>("pushback");
        if (!call || !call->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(call->getBeginLoc())) return;

        // Confirm it really is inside a loop (belt-and-suspenders over the matcher).
        if (!hasLoopAncestor(call, *result.Context)) return;

        const auto loc = sm.getPresumedLoc(call->getBeginLoc());

        Finding f;
        f.rule_id    = _rule_id;
        f.title      = _title;
        f.message    = "push_back inside a loop without a preceding reserve(); "
                       "the vector will reallocate (and copy/move all elements) "
                       "O(log N) times; call reserve(N) before the loop";
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
    const std::string&    _build_id;
    const char*           _rule_id;
    const char*           _title;
};

} // namespace

void VectorNoReserveRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match push_back/emplace_back on std::vector inside any loop body.
    finder.addMatcher(
        cxxMemberCallExpr(
            callee(cxxMethodDecl(
                anyOf(hasName("push_back"), hasName("emplace_back")),
                ofClass(hasName("vector")))),
            hasAncestor(stmt(anyOf(
                forStmt(), whileStmt(), doStmt(), cxxForRangeStmt())))
        ).bind("pushback"),
        new Callback(_findings, _build_id, id(), title()));
}

std::vector<Finding> VectorNoReserveRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
