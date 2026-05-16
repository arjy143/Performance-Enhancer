#ifdef PERF_LENS_HAVE_LLVM

#include "std_function.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Match declarations of type std::function<...>
// This catches: local variables, function parameters, and data members.
// We intentionally keep confidence at Medium because std::function is sometimes
// used intentionally in non-hot code paths.

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* decl = result.Nodes.getNodeAs<DeclaratorDecl>("sfDecl");
        if (!decl || !decl->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(decl->getBeginLoc())) return;

        const auto loc = sm.getPresumedLoc(decl->getBeginLoc());

        Finding f;
        f.rule_id    = "perf-lens.hotpath.std-function";
        f.title      = "std::function in hot path";
        f.message    = "std::function uses heap allocation and virtual dispatch for type erasure, "
                       "adding ~50–200ns per call compared to a direct function call or template. "
                       "Replace with a template parameter, function pointer, or std::function<>-free "
                       "callback pattern (e.g. a small_function with SBO, or Abseil's AnyInvocable).";
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

void StdFunctionRule::registerMatchers(MatchFinder& finder, const std::string& build_id) {
    _build_id = build_id;
    // Match any variable or parameter whose type is std::function<...>
    finder.addMatcher(
        declaratorDecl(
            hasType(
                qualType(hasDeclaration(
                    namedDecl(hasName("function"), hasAncestor(namespaceDecl(hasName("std"))))
                ))
            )
        ).bind("sfDecl"),
        new Callback(_findings, build_id)
    );
}

std::vector<Finding> StdFunctionRule::takeFindings() {
    return std::move(_findings);
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
