#ifdef PERF_LENS_HAVE_LLVM

#include "promotion_variable.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/Expr.h>
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
        const auto* var = result.Nodes.getNodeAs<VarDecl>("var");
        if (!var || !var->getLocation().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(var->getLocation())) return;

        // Verify the initialiser really is a constant expression.
        const Expr* init = var->getInit();
        if (!init) return;
        if (!init->isConstantInitializer(*result.Context, /*ForRef=*/false)) return;

        const auto loc = sm.getPresumedLoc(var->getLocation());

        Finding f;
        f.rule_id    = _rule_id;
        f.title      = _title;
        f.message    = "Variable '" + var->getNameAsString() +
                       "' is const and initialised from a constant expression; "
                       "mark it constexpr to guarantee compile-time evaluation "
                       "and allow use in constant expressions";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::Constexpr;
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

void PromotionVariableRule::registerMatchers(MatchFinder& finder,
                                              const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match: const variable (not constexpr, not reference) with literal/integral
    // type. The callback verifies the initialiser is a constant expression.
    finder.addMatcher(
        varDecl(
            isDefinition(),
            hasType(isConstQualified()),
            unless(isConstexpr()),
            unless(hasType(referenceType())),
            hasType(qualType(anyOf(
                isInteger(),
                realFloatingPointType(),
                hasDeclaration(enumDecl())
            ))),
            hasInitializer(expr())
        ).bind("var"),
        new Callback(_findings, _build_id, id(), title()));
}

std::vector<Finding> PromotionVariableRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
