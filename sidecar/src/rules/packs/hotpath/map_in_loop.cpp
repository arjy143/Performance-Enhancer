#ifdef PERF_LENS_HAVE_LLVM

#include "map_in_loop.hpp"

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
        const auto* call = result.Nodes.getNodeAs<CXXMemberCallExpr>("map_call");
        if (!call) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(call->getBeginLoc())) return;

        const auto* method = call->getMethodDecl();
        const std::string method_name = method ? method->getNameAsString() : "";

        // Determine the container type name for a more specific message.
        const auto* rec = call->getRecordDecl();
        std::string container = "std::map";
        if (rec) {
            const auto n = rec->getNameAsString();
            if (n == "set")       container = "std::set";
            else if (n == "multimap") container = "std::multimap";
            else if (n == "multiset") container = "std::multiset";
        }

        const auto loc = sm.getPresumedLoc(call->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.hotpath.map-in-loop";
        f.title      = "std::map/set lookup inside loop";
        f.message    = "'" + container + "::" + method_name + "' inside a loop performs "
                       "an O(log N) tree traversal with pointer chasing on every iteration. "
                       "Consider std::unordered_map/set for O(1) average lookups, "
                       "or a sorted std::vector with binary search for cache-friendly access.";
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
};

} // namespace

void MapInLoopRule::registerMatchers(MatchFinder& finder,
                                      const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match find/count/operator[] on std::map or std::set inside any loop.
    finder.addMatcher(
        cxxMemberCallExpr(
            callee(cxxMethodDecl(
                anyOf(hasName("find"), hasName("count"),
                      hasName("contains"), hasName("lower_bound"),
                      hasName("upper_bound")),
                ofClass(anyOf(
                    hasName("map"), hasName("set"),
                    hasName("multimap"), hasName("multiset"))))),
            hasAncestor(stmt(anyOf(
                forStmt(), whileStmt(), doStmt(), cxxForRangeStmt())))
        ).bind("map_call"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> MapInLoopRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
