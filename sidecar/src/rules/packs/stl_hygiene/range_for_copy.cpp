#ifdef PERF_LENS_HAVE_LLVM

#include "range_for_copy.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Stmt.h>
#include <clang/AST/Decl.h>
#include <clang/AST/Type.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id,
             const char* rule_id, const char* title)
        : _out(out), _build_id(build_id), _rule_id(rule_id), _title(title) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* var = result.Nodes.getNodeAs<VarDecl>("loopVar");
        if (!var || !var->getLocation().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(var->getLocation())) return;

        // Only fire for non-trivially-copyable types (skip int, float, etc.)
        const QualType qt = var->getType();
        const Type* t = qt.getTypePtr();
        if (!t) return;
        if (const auto* rd = t->getAsCXXRecordDecl()) {
            if (rd->isTriviallyCopyable()) return;
        } else {
            // Scalar type — copying is fine.
            return;
        }

        const auto loc = sm.getPresumedLoc(var->getLocation());
        const std::string typeName = qt.getAsString();

        Finding f;
        f.rule_id    = _rule_id;
        f.title      = _title;
        f.message    = "Loop variable '" + var->getNameAsString() +
                       "' (type '" + typeName + "') is copied on each iteration; "
                       "use 'const auto&' to avoid the copy";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::StlHygiene;
        f.confidence = ConfidenceLevel::High;
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

void RangeForCopyRule::registerMatchers(MatchFinder& finder,
                                         const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match range-for loop variable that is NOT a reference and NOT a pointer.
    finder.addMatcher(
        cxxForRangeStmt(
            hasLoopVariable(
                varDecl(
                    unless(hasType(referenceType())),
                    unless(hasType(pointerType()))
                ).bind("loopVar")
            )
        ),
        new Callback(_findings, _build_id, id(), title()));
}

std::vector<Finding> RangeForCopyRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
