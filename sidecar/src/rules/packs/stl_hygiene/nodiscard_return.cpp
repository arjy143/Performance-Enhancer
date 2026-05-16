#ifdef PERF_LENS_HAVE_LLVM

#include "nodiscard_return.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/DeclCXX.h>
#include <clang/Basic/SourceManager.h>

#include <string>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Types whose return value is almost always meaningful and should not be ignored.
static bool isErrorLikeType(const QualType& qt) {
    const auto* rec = qt->getAsCXXRecordDecl();
    if (!rec) {
        // Plain bool return
        return qt->isBooleanType();
    }
    const std::string name = rec->getQualifiedNameAsString();
    return name == "std::error_code"
        || name == "std::error_condition"
        || name == "std::errc"
        || name.rfind("std::expected",  0) == 0
        || name.rfind("std::optional",  0) == 0
        || name.rfind("absl::Status",   0) == 0
        || name.rfind("absl::StatusOr", 0) == 0;
}

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* fn = result.Nodes.getNodeAs<FunctionDecl>("fn");
        if (!fn || !fn->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(fn->getBeginLoc())) return;

        // Skip if already has [[nodiscard]] or [[gnu::warn_unused_result]]
        if (fn->hasAttr<WarnUnusedResultAttr>()) return;

        const QualType ret = fn->getReturnType().getCanonicalType();
        if (!isErrorLikeType(ret)) return;

        const auto loc = sm.getPresumedLoc(fn->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.nodiscard.error-return";
        f.title      = "missing [[nodiscard]] on error-returning function";
        f.message    = "'" + fn->getNameAsString() + "' returns '" + ret.getAsString() + "' "
                       "but is not marked [[nodiscard]]. Callers can silently discard error values, "
                       "hiding failures. Add [[nodiscard]] to force call-site handling.";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::FunctionAttrib;
        f.confidence = ConfidenceLevel::Medium;
        f.build_id   = _build_id;
        _out.push_back(std::move(f));
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void NodiscardReturnRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    finder.addMatcher(
        functionDecl(
            isDefinition(),
            unless(isImplicit()),
            unless(cxxMethodDecl(isOverride()))  // override inherits nodiscard from base
        ).bind("fn"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> NodiscardReturnRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
