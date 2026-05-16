#ifdef PERF_LENS_HAVE_LLVM

#include "aliasing.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/Type.h>
#include <clang/Basic/SourceManager.h>

#include <map>
#include <string>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Detect functions that take two or more pointer-to-T parameters of the same
// pointee type without __restrict__ qualification.  When such a function
// contains a loop the compiler must assume the pointers alias and cannot
// auto-vectorise.  We match at the *function* level rather than the loop level
// so we flag the declaration that must be annotated, not the call site.
//
// We only fire when there are ≥2 non-const, non-restrict pointer params of
// identical pointee type — that's the minimal condition for aliasing to
// actually block vectorisation.

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* fn = result.Nodes.getNodeAs<FunctionDecl>("fn");
        if (!fn || !fn->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(fn->getBeginLoc())) return;

        // Collect non-restrict pointer params grouped by canonical pointee type
        std::map<std::string, int> ptrCounts;
        for (const auto* param : fn->parameters()) {
            const QualType qt = param->getType();
            if (!qt->isPointerType()) continue;

            // Skip restrict-qualified pointers
            if (qt.isRestrictQualified()) continue;

            const QualType pointee = qt->getPointeeType().getUnqualifiedType();
            // Skip void* — aliasing is always assumed and restrict doesn't help
            if (pointee->isVoidType()) continue;
            // Skip const pointee — read-only pointers can't cause write aliasing
            if (qt->getPointeeType().isConstQualified()) continue;

            ptrCounts[pointee.getAsString()]++;
        }

        bool hasDuplicate = false;
        for (const auto& [type, count] : ptrCounts) {
            if (count >= 2) { hasDuplicate = true; break; }
        }
        if (!hasDuplicate) return;

        const auto loc = sm.getPresumedLoc(fn->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.vec.aliasing";
        f.title      = "Pointer aliasing prevents vectorisation";
        f.message    = "Function '" + fn->getNameAsString() + "' has multiple writable pointer "
                       "parameters of the same type without __restrict__. The compiler must assume "
                       "they alias, preventing auto-vectorisation of any inner loop. "
                       "Add __restrict__ (or C99 restrict) to each pointer parameter that is "
                       "guaranteed not to overlap, or restructure the API to accept spans.";
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

void VecAliasingRule::registerMatchers(MatchFinder& finder, const std::string& build_id) {
    _build_id = build_id;
    // Match any function (free or member) that has at least two pointer parameters.
    // The per-param type analysis happens inside the callback.
    finder.addMatcher(
        functionDecl(
            isDefinition(),
            hasAnyParameter(hasType(pointerType()))
        ).bind("fn"),
        new Callback(_findings, build_id)
    );
}

std::vector<Finding> VecAliasingRule::takeFindings() {
    return std::move(_findings);
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
