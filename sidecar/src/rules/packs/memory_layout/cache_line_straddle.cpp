#ifdef PERF_LENS_HAVE_LLVM

#include "cache_line_straddle.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/DeclCXX.h>
#include <clang/AST/RecordLayout.h>
#include <clang/Basic/SourceManager.h>

#include <string>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

static constexpr uint64_t kCacheLineBytes = 64;

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
        if (rec->field_empty()) return;

        ASTContext& ctx = *result.Context;
        const ASTRecordLayout& layout = ctx.getASTRecordLayout(rec);

        for (const FieldDecl* field : rec->fields()) {
            if (field->isImplicit() || field->isUnnamedBitField()) continue;

            // getFieldOffset returns offset in bits
            const uint64_t offsetBits = layout.getFieldOffset(field->getFieldIndex());
            const uint64_t offsetBytes = offsetBits / 8;

            const uint64_t sizeBytes =
                ctx.getTypeSizeInChars(field->getType()).getQuantity();
            if (sizeBytes == 0) continue;

            const uint64_t startLine = offsetBytes / kCacheLineBytes;
            const uint64_t endLine   = (offsetBytes + sizeBytes - 1) / kCacheLineBytes;

            if (startLine == endLine) continue; // fits within one cache line

            const auto loc = sm.getPresumedLoc(field->getBeginLoc());
            Finding f;
            f.rule_id    = "perf-lens.padding.cache-line-straddle";
            f.title      = "struct field straddles a 64-byte cache line";
            f.message    = "Field '" + field->getNameAsString() + "' in '" +
                           rec->getNameAsString() + "' starts at byte " +
                           std::to_string(offsetBytes) + " and ends at byte " +
                           std::to_string(offsetBytes + sizeBytes - 1) +
                           ", crossing a 64-byte cache line boundary. "
                           "Access to this field requires loading two cache lines. "
                           "Reorder fields or add alignas(64) to align the field to the boundary.";
            f.file       = loc.getFilename();
            f.line       = static_cast<int>(loc.getLine());
            f.column     = static_cast<int>(loc.getColumn());
            f.category   = FindingCategory::MemoryLayout;
            f.confidence = ConfidenceLevel::Medium;
            f.build_id   = _build_id;
            _out.push_back(std::move(f));
        }
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void CacheLineStraddleRule::registerMatchers(MatchFinder& finder,
                                              const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    finder.addMatcher(
        cxxRecordDecl(isDefinition()).bind("rec"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> CacheLineStraddleRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
