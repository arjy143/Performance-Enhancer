#ifdef PERF_LENS_HAVE_LLVM

#include "padding_detected.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/DeclCXX.h>
#include <clang/AST/RecordLayout.h>
#include <clang/Basic/SourceManager.h>

#include <numeric>
#include <string>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

uint64_t packedSize(const RecordDecl* rd, ASTContext& ctx) {
    uint64_t total = 0;
    for (const FieldDecl* fd : rd->fields()) {
        if (fd->isBitField()) {
            total += fd->getBitWidthValue(ctx);
        } else {
            total += ctx.getTypeSize(fd->getType());
        }
    }
    return (total + 7) / 8; // bits → bytes
}

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id,
             const char* rule_id, const char* title)
        : _out(out), _build_id(build_id), _rule_id(rule_id), _title(title) {}

    void run(const MatchFinder::MatchResult& result) override {
        const auto* rd = result.Nodes.getNodeAs<RecordDecl>("record");
        if (!rd || !rd->isCompleteDefinition()) return;
        if (!rd->getLocation().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(rd->getLocation())) return;

        // Skip empty structs and unions (unions use max-field size intentionally).
        if (rd->isUnion() || rd->field_empty()) return;

        auto& ctx           = *result.Context;
        const auto& layout  = ctx.getASTRecordLayout(rd);
        const uint64_t actual = layout.getSize().getQuantity();
        const uint64_t packed = packedSize(rd, ctx);

        if (actual <= packed) return; // no padding
        const uint64_t wasted = actual - packed;

        // Only report if at least 4 bytes wasted.
        if (wasted < 4) return;

        const auto loc = sm.getPresumedLoc(rd->getLocation());
        const std::string name = rd->getNameAsString();

        Finding f;
        f.rule_id    = _rule_id;
        f.title      = _title;
        f.message    = "'" + name + "' has " + std::to_string(wasted) +
                       " padding byte(s) (sizeof=" + std::to_string(actual) +
                       ", packed=" + std::to_string(packed) + "); "
                       "reorder fields largest-first to eliminate waste";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::MemoryLayout;
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

void PaddingDetectedRule::registerMatchers(MatchFinder& finder,
                                            const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    finder.addMatcher(
        recordDecl(isStruct(), isDefinition()).bind("record"),
        new Callback(_findings, _build_id, id(), title()));
}

std::vector<Finding> PaddingDetectedRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
