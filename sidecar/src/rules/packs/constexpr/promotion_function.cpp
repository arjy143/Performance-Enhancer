#ifdef PERF_LENS_HAVE_LLVM

#include "promotion_function.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/Stmt.h>
#include <clang/AST/Expr.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Walk an expression tree to check that it contains no CallExpr nodes
// (conservative: if there's any call we can't guarantee constexpr-ability).
static bool hasNoCallExpr(const Stmt* s) {
    if (!s) return true;
    if (isa<CallExpr>(s)) return false;
    for (const Stmt* child : s->children()) {
        if (!hasNoCallExpr(child)) return false;
    }
    return true;
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

        // Must have a body.
        const Stmt* body = fn->getBody();
        if (!body) return;

        // Body must be a compound statement with exactly one statement.
        const auto* compound = dyn_cast<CompoundStmt>(body);
        if (!compound || compound->size() != 1) return;

        // That one statement must be a return.
        const auto* ret = dyn_cast<ReturnStmt>(*compound->body_begin());
        if (!ret || !ret->getRetValue()) return;

        // Return expression must not contain any function calls.
        if (!hasNoCallExpr(ret->getRetValue())) return;

        // Return type must be a scalar (integral, float, pointer, enum).
        const QualType retTy = fn->getReturnType();
        if (!retTy->isScalarType() && !retTy->isVoidType()) return;

        // All parameters must also be scalar.
        for (const ParmVarDecl* p : fn->parameters()) {
            if (!p->getType()->isScalarType()) return;
        }

        const auto loc = sm.getPresumedLoc(fn->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.constexpr.promotion-function";
        f.title      = "simple function could be constexpr";
        f.message    = "'" + fn->getNameAsString() + "' has a single return expression with "
                       "no function calls and only scalar types. Marking it 'constexpr' "
                       "enables compile-time evaluation when called with constant arguments, "
                       "eliminating the call overhead entirely in those cases.";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::FunctionAttrib;
        f.confidence = ConfidenceLevel::Low;
        f.build_id   = _build_id;
        _out.push_back(std::move(f));
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void PromotionFunctionRule::registerMatchers(MatchFinder& finder,
                                              const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    finder.addMatcher(
        functionDecl(
            isDefinition(),
            unless(isConstexpr()),
            unless(isImplicit()),
            unless(cxxMethodDecl(isVirtual()))
        ).bind("fn"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> PromotionFunctionRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
