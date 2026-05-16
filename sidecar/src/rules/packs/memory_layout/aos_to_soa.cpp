#ifdef PERF_LENS_HAVE_LLVM

#include "aos_to_soa.hpp"

#include <clang/ASTMatchers/ASTMatchers.h>
#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/AST/Decl.h>
#include <clang/AST/DeclCXX.h>
#include <clang/AST/Type.h>
#include <clang/Basic/SourceManager.h>

#include <string>

using namespace clang;
using namespace clang::ast_matchers;

namespace perf_lens::rules {

namespace {

// Minimum number of non-static data fields in the element type to fire.
static constexpr int kMinFields = 4;

// Count non-static, non-implicit data members in a record.
static int countDataFields(const CXXRecordDecl* rec) {
    int n = 0;
    for (const FieldDecl* f : rec->fields()) {
        if (!f->isImplicit()) ++n;
    }
    return n;
}

// Extract the element type T from std::vector<T>.
static const CXXRecordDecl* vectorElementRecord(const QualType& qt) {
    const auto* spec = dyn_cast_or_null<ClassTemplateSpecializationDecl>(
        qt->getAsCXXRecordDecl());
    if (!spec) return nullptr;

    const std::string name = spec->getQualifiedNameAsString();
    if (name != "std::vector") return nullptr;

    const auto& args = spec->getTemplateArgs();
    if (args.size() == 0) return nullptr;
    if (args[0].getKind() != TemplateArgument::Type) return nullptr;

    return args[0].getAsType()->getAsCXXRecordDecl();
}

class Callback : public MatchFinder::MatchCallback {
public:
    Callback(std::vector<Finding>& out, const std::string& build_id)
        : _out(out), _build_id(build_id) {}

    void run(const MatchFinder::MatchResult& result) override {
        const ValueDecl* decl = nullptr;
        if (const auto* v = result.Nodes.getNodeAs<VarDecl>("var"))
            decl = v;
        else if (const auto* f = result.Nodes.getNodeAs<FieldDecl>("field"))
            decl = f;
        if (!decl || !decl->getBeginLoc().isValid()) return;

        const auto& sm = *result.SourceManager;
        if (!sm.isInMainFile(decl->getBeginLoc())) return;

        const CXXRecordDecl* elemRec =
            vectorElementRecord(decl->getType().getCanonicalType());
        if (!elemRec || !elemRec->isCompleteDefinition()) return;

        const int nFields = countDataFields(elemRec);
        if (nFields < kMinFields) return;

        const auto loc = sm.getPresumedLoc(decl->getBeginLoc());
        Finding f;
        f.rule_id    = "perf-lens.memory_layout.aos-to-soa";
        f.title      = "vector-of-structs may benefit from struct-of-vectors";
        f.message    = "'" + decl->getNameAsString() + "' is a std::vector<" +
                       elemRec->getNameAsString() + "> whose element type has " +
                       std::to_string(nFields) + " fields. If workloads typically "
                       "access only one or two fields at a time, converting to a "
                       "struct-of-vectors (SoA) layout improves spatial locality and "
                       "enables wider SIMD loads. Example: replace "
                       "`std::vector<Particle>` with individual `std::vector<float> x, y, z`.";
        f.file       = loc.getFilename();
        f.line       = static_cast<int>(loc.getLine());
        f.column     = static_cast<int>(loc.getColumn());
        f.category   = FindingCategory::MemoryLayout;
        f.confidence = ConfidenceLevel::Low;
        f.build_id   = _build_id;
        _out.push_back(std::move(f));
    }

private:
    std::vector<Finding>& _out;
    const std::string& _build_id;
};

} // namespace

void AosToSoaRule::registerMatchers(MatchFinder& finder, const std::string& build_id) {
    _build_id = build_id;
    _findings.clear();

    // Local variable declarations
    finder.addMatcher(
        varDecl(hasType(qualType(hasDeclaration(namedDecl(hasName("vector")))))).bind("var"),
        new Callback(_findings, _build_id));

    // Struct/class field declarations
    finder.addMatcher(
        fieldDecl(hasType(qualType(hasDeclaration(namedDecl(hasName("vector")))))).bind("field"),
        new Callback(_findings, _build_id));
}

std::vector<Finding> AosToSoaRule::takeFindings() {
    return std::exchange(_findings, {});
}

} // namespace perf_lens::rules

#endif // PERF_LENS_HAVE_LLVM
