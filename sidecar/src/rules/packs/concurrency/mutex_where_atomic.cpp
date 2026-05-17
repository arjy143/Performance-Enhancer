#ifdef PERF_LENS_HAVE_LLVM

#include "mutex_where_atomic.hpp"

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

// Heuristic: if a record has exactly one std::mutex field and exactly one
// (or zero) non-mutex, non-static, integral/pointer data field, the mutex
// is very likely guarding only that one value.  std::atomic<T> removes the
// lock entirely and is ~5–20× faster for uncontended access.
//
// Confidence is Low because we can't prove the mutex guards only that field
// without a full escape/alias analysis.

static bool isIntegralOrPointer(const QualType& qt) {
    return qt->isIntegralOrEnumerationType() || qt->isPointerType();
}

static bool isMutexType(const QualType& qt) {
    if (const auto* rec = qt->getAsCXXRecordDecl()) {
        const std::string name = rec->getQualifiedNameAsString();
        return name == "std::mutex" || name == "std::recursive_mutex"
            || name == "std::timed_mutex";
    }
    return false;
}

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* rec = result.Nodes.getNodeAs<CXXRecordDecl>("rec");
        if (!rec || !rec->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(rec->getBeginLoc())) return;
        if (!rec->isCompleteDefinition()) return;

        int mutexCount   = 0;
        int dataCount    = 0;   // all non-mutex data members
        int integralCount = 0;  // subset that are integral/pointer

        for (const auto* field : rec->fields()) {
            if (field->isImplicit() || field->isUnnamedBitField()) continue;
            const QualType qt = field->getType().getCanonicalType();
            if (isMutexType(qt)) {
                ++mutexCount;
            } else {
                ++dataCount;
                if (isIntegralOrPointer(qt)) ++integralCount;
            }
        }

        // Fire only when: exactly one mutex, 1–2 total data fields, and every
        // data field is integral/pointer (no complex types like std::string).
        if (mutexCount != 1 || dataCount == 0 || dataCount > 2
                || integralCount != dataCount) return;

        const auto loc = sm.getPresumedLoc(rec->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.concurrency.mutex-where-atomic";
        f.title      = "std::mutex protecting a single integer; use std::atomic";
        f.message    = "'" + rec->getNameAsString() + "' contains a std::mutex that appears to "
                       "guard only " + std::to_string(dataCount) + " integral/pointer field(s). "
                       "Replace the mutex + guarded field pair with std::atomic<T> "
                       "(e.g. std::atomic<int>). Lock-free atomics are ~5–20× faster on uncontended "
                       "paths and avoid priority inversion. Use seq_cst for simplicity or "
                       "relaxed/acquire-release ordering for maximum throughput.";
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
    std::string _build_id;
};

} // namespace

void MutexWhereAtomicRule::registerMatchers(MatchFinder& finder, const std::string& build_id) {
    _build_id = build_id;
    finder.addMatcher(
        cxxRecordDecl(isDefinition()).bind("rec"),
        new Callback(_findings, build_id)
    );
}

std::vector<Finding> MutexWhereAtomicRule::takeFindings() {
    return std::move(_findings);
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
