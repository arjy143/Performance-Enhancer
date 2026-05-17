#ifdef PERF_LENS_HAVE_LLVM

#include "container_copy.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/Type.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Container types that are expensive to copy.
static const auto kContainerNames = namedDecl(anyOf(
    hasName("vector"),
    hasName("deque"),
    hasName("list"),
    hasName("map"),
    hasName("unordered_map"),
    hasName("set"),
    hasName("unordered_set"),
    hasName("basic_string")));

// Explicit QualType matcher to avoid hasType() overload ambiguity.
static const auto kContainerQualType =
    qualType(hasDeclaration(kContainerNames));

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* decl = result.Nodes.getNodeAs<VarDecl>("copy_decl");
        if (!decl) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(decl->getBeginLoc())) return;

        // Skip: already a reference or pointer
        const auto type = decl->getType();
        if (type->isReferenceType() || type->isPointerType()) return;

        const auto loc = sm.getPresumedLoc(decl->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.stl.container-copy";
        f.title      = "unnecessary container copy";
        f.message    = "Variable '" + decl->getNameAsString() + "' copies a container returned "
                       "by value. If the container is not modified, declare it as "
                       "'const auto&' to bind to the return value without copying. "
                       "If modification is needed, this warning is a false positive.";
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

void ContainerCopyRule::registerMatchers(MatchFinder& finder,
                                          const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match: auto var = callExpr() where return type is a container and var is non-const non-ref.
    finder.addMatcher(
        varDecl(
            hasType(autoType()),
            hasInitializer(callExpr(
                hasType(kContainerQualType))),
            unless(hasType(referenceType())),
            unless(hasParent(declStmt(hasParent(cxxForRangeStmt()))))
        ).bind("copy_decl"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> ContainerCopyRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
