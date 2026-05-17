#ifdef PERF_LENS_HAVE_LLVM

#include "endl_flush.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
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
        const auto* call = result.Nodes.getNodeAs<CallExpr>("endl");
        if (!call || !call->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(call->getBeginLoc())) return;

        const auto loc = sm.getPresumedLoc(call->getBeginLoc());

        Finding f;
        f.rule_id    = _rule_id;
        f.title      = _title;
        f.message    = "std::endl flushes the stream buffer on every call; "
                       "use '\\n' for output without flushing; "
                       "flush explicitly only when required";
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

void EndlFlushRule::registerMatchers(MatchFinder& finder,
                                      const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Match calls to std::endl (it's a function template instantiation).
    finder.addMatcher(
        callExpr(
            callee(functionDecl(hasName("endl"),
                                isInStdNamespace()))
        ).bind("endl"),
        new Callback(_findings, _build_id, id(), title()));
}

std::vector<Finding> EndlFlushRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
