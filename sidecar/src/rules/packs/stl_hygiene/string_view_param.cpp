#ifdef PERF_LENS_HAVE_LLVM

#include "string_view_param.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/Type.h>
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
        const auto* param = result.Nodes.getNodeAs<ParmVarDecl>("sv_param");
        if (!param) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(param->getBeginLoc())) return;

        // Skip: used to construct a std::string (would invalidate string_view).
        // This is a conservative approximation; low confidence is set in the rule.

        const auto loc = sm.getPresumedLoc(param->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.stl.string-view-param";
        f.title      = "const std::string& param should be std::string_view";
        f.message    = "Parameter '" + param->getNameAsString() + "' is 'const std::string&'. "
                       "Callers passing a string literal or std::string_view will incur an "
                       "implicit std::string construction. Prefer 'std::string_view' unless "
                       "the function stores or converts the string, or uses c_str().";
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
    const std::string&    _build_id;
};

} // namespace

void StringViewParamRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match function parameters of type 'const std::string&'.
    finder.addMatcher(
        parmVarDecl(
            hasType(referenceType(pointee(
                qualType(isConstQualified(),
                    hasDeclaration(cxxRecordDecl(hasName("basic_string"))))
            )))
        ).bind("sv_param"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> StringViewParamRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
