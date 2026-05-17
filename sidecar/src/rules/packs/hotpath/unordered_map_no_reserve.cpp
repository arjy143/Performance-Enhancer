#ifdef PERF_LENS_HAVE_LLVM

#include "unordered_map_no_reserve.hpp"

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
        const auto* call = result.Nodes.getNodeAs<CXXMemberCallExpr>("insert_call");
        if (!call) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(call->getBeginLoc())) return;

        // Determine the container type name.
        const auto* rec = call->getRecordDecl();
        std::string container = "std::unordered_map";
        if (rec) {
            const auto n = rec->getNameAsString();
            if (n == "unordered_set")       container = "std::unordered_set";
            else if (n == "unordered_multimap") container = "std::unordered_multimap";
            else if (n == "unordered_multiset") container = "std::unordered_multiset";
        }

        const auto loc = sm.getPresumedLoc(call->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.hotpath.unordered-map-no-reserve";
        f.title      = "unordered_map/set insertions without reserve";
        f.message    = "Inserting into a '" + container + "' inside a loop without "
                       "a prior reserve() call risks repeated rehashing as the load factor "
                       "grows. If the final size is known or estimable, call reserve(n) "
                       "before the loop to avoid O(N) rehash copies.";
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

void UnorderedMapNoReserveRule::registerMatchers(MatchFinder& finder,
                                                  const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match insert/emplace/operator[] on unordered containers inside any loop.
    finder.addMatcher(
        cxxMemberCallExpr(
            callee(cxxMethodDecl(
                anyOf(hasName("insert"), hasName("emplace"),
                      hasName("emplace_hint"), hasName("try_emplace")),
                ofClass(anyOf(
                    hasName("unordered_map"), hasName("unordered_set"),
                    hasName("unordered_multimap"), hasName("unordered_multiset"))))),
            hasAncestor(stmt(anyOf(
                forStmt(), whileStmt(), doStmt(), cxxForRangeStmt())))
        ).bind("insert_call"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> UnorderedMapNoReserveRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
