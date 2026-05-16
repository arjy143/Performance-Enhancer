#pragma once
#ifdef PERF_LENS_HAVE_LLVM

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <vector>

// Forward declarations — callers get an opaque handle.
namespace clang { class ASTUnit; }
namespace clang::tooling { class CompilationDatabase; }
namespace clang::ast_matchers { class MatchFinder; }

namespace perf_lens::ast {

// Parses a single translation unit on demand, caches the result, and
// re-parses when the source file's modification time changes.
class TranslationUnit {
public:
    TranslationUnit(const std::string& file,
                    clang::tooling::CompilationDatabase& db);

    // Run the matcher finder against this TU, re-parsing if stale.
    // Returns false if parsing failed.
    bool runMatchers(clang::ast_matchers::MatchFinder& finder);

    const std::string& file() const { return _file; }

private:
    std::string _file;
    clang::tooling::CompilationDatabase& _db;
    std::unique_ptr<clang::ASTUnit>      _unit;
    std::filesystem::file_time_type      _mtime{};

    bool _parse();
    bool _isStale() const;
};

} // namespace perf_lens::ast

#endif // PERF_LENS_HAVE_LLVM
