#ifdef PERF_LENS_HAVE_LLVM

#include "complex_cf.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Stmt.h>
#include <clang/Basic/SourceManager.h>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Matches a loop that directly contains an early-exit statement (return/break/
// continue-to-outer) that is NOT inside a nested loop or lambda.
// We detect: returnStmt or breakStmt whose nearest enclosing loop is our loop.

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const Stmt* exit_stmt = nullptr;
        std::string kind;

        if (const auto* r = result.Nodes.getNodeAs<ReturnStmt>("ret")) {
            exit_stmt = r; kind = "return";
        } else if (const auto* b = result.Nodes.getNodeAs<BreakStmt>("brk")) {
            exit_stmt = b; kind = "break";
        }
        if (!exit_stmt) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(exit_stmt->getBeginLoc())) return;

        const auto loc = sm.getPresumedLoc(exit_stmt->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.vec.complex-cf";
        f.title      = "early exit inside loop prevents vectorisation";
        f.message    = "A '" + kind + "' statement inside a loop body creates non-uniform control "
                       "flow that prevents auto-vectorisation. Consider restructuring: use a "
                       "predicated expression (e.g. conditional assignment) or a separate "
                       "scalar search pass followed by a vectorised compute pass.";
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
    const std::string& _build_id;
};

} // namespace

void ComplexCfRule::registerMatchers(MatchFinder& finder, const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // returnStmt inside a loop, but NOT inside a nested lambda.
    // (Standard C++ doesn't allow nested functions; lambdas are the real concern.)
    const auto kLoopAncestor = stmt(anyOf(
        forStmt(), whileStmt(), doStmt(), cxxForRangeStmt()));

    finder.addMatcher(
        returnStmt(
            hasAncestor(kLoopAncestor),
            unless(hasAncestor(lambdaExpr()))
        ).bind("ret"),
        new Callback(_findings, _build_id));

    // breakStmt inside a loop — but NOT inside a switch (a break in a switch is fine).
    finder.addMatcher(
        breakStmt(
            hasAncestor(kLoopAncestor),
            unless(hasAncestor(switchStmt()))
        ).bind("brk"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> ComplexCfRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
