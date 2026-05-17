#ifdef PERF_LENS_HAVE_LLVM

#include "shared_ptr_in_loop.hpp"

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
        const auto* expr = result.Nodes.getNodeAs<Expr>("shared_ptr_copy");
        if (!expr) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(expr->getBeginLoc())) return;

        const auto loc = sm.getPresumedLoc(expr->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.hotpath.shared-ptr-in-loop";
        f.title      = "std::shared_ptr copy inside loop";
        f.message    = "Copying a std::shared_ptr inside a loop performs an atomic "
                       "reference-count increment and decrement on every iteration, "
                       "causing cache-line contention on the control block. "
                       "Pass by const reference or use a raw pointer/reference for the "
                       "loop body if ownership is not transferred.";
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

void SharedPtrInLoopRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match a variable declaration whose initialiser copies a shared_ptr
    // (i.e. calls the shared_ptr copy constructor), inside any loop.
    finder.addMatcher(
        varDecl(
            hasType(recordType(hasDeclaration(classTemplateSpecializationDecl(
                hasName("shared_ptr"))))),
            hasInitializer(expr().bind("shared_ptr_copy")),
            hasAncestor(stmt(anyOf(
                forStmt(), whileStmt(), doStmt(), cxxForRangeStmt())))
        ).bind("decl"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> SharedPtrInLoopRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
