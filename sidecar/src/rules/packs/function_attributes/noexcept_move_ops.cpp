#ifdef PERF_LENS_HAVE_LLVM

#include "noexcept_move_ops.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/DeclCXX.h>
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
        const auto* method = result.Nodes.getNodeAs<CXXMethodDecl>("method");
        if (!method || !method->getLocation().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(method->getLocation())) return;

        const auto loc = sm.getPresumedLoc(method->getLocation());
        // The matcher guarantees it's a move ctor or move assignment;
        // distinguish them via dynamic type (isMoveConstructor lives on CXXConstructorDecl in LLVM 19).
        const bool isMoveCtor = isa<CXXConstructorDecl>(method);
        if (!isMoveCtor && !method->isMoveAssignmentOperator()) return;

        std::string cls;
        if (const auto* rd = method->getParent())
            cls = rd->getNameAsString();

        Finding f;
        f.rule_id    = _rule_id;
        f.title      = _title;
        f.message    = "Move " +
                       std::string(isMoveCtor ? "constructor" : "assignment") +
                       " of '" + cls + "' is not noexcept — std::vector reallocation will copy instead of move";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::FunctionAttrib;
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

void NoexceptMoveOpsRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // isMoveConstructor() is Matcher<CXXConstructorDecl> in LLVM 19 — match separately.
    auto* cb = new Callback(_findings, _build_id, id(), title());
    finder.addMatcher(
        cxxConstructorDecl(
            isMoveConstructor(),
            unless(isNoThrow()),
            isDefinition(),
            unless(isDeleted()),
            unless(isImplicit())
        ).bind("method"), cb);
    finder.addMatcher(
        cxxMethodDecl(
            isMoveAssignmentOperator(),
            unless(isNoThrow()),
            isDefinition(),
            unless(isDeleted()),
            unless(isImplicit())
        ).bind("method"), cb);
}

std::vector<Finding> NoexceptMoveOpsRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
