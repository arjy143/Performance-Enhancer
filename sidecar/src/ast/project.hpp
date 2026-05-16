#pragma once
#ifdef PERF_LENS_HAVE_LLVM

#include <filesystem>
#include <memory>
#include <string>
#include <vector>

// Forward-declare to avoid pulling LLVM headers into translation units that
// don't need them.
namespace clang::tooling { class CompilationDatabase; }

namespace perf_lens::ast {

// Owns the CompilationDatabase derived from compile_commands.json.
class AstProject {
public:
    // Throws std::runtime_error if compile_commands.json cannot be found.
    explicit AstProject(const std::filesystem::path& workspace);

    // Compiler args for a specific source file.
    // Returns empty vector if the file isn't in the database.
    std::vector<std::string> compileArgsFor(const std::string& file) const;

    // All source files tracked by the database.
    std::vector<std::string> allFiles() const;

    clang::tooling::CompilationDatabase& database() const { return *_db; }

private:
    std::unique_ptr<clang::tooling::CompilationDatabase> _db;
};

} // namespace perf_lens::ast

#endif // PERF_LENS_HAVE_LLVM
