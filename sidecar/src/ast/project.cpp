#ifdef PERF_LENS_HAVE_LLVM

#include "project.hpp"
#include "util/logger.hpp"

#include <clang/Tooling/JSONCompilationDatabase.h>
#include <stdexcept>

namespace perf_lens::ast {

AstProject::~AstProject() = default; // CompilationDatabase complete here

AstProject::AstProject(const std::filesystem::path& workspace) {
    // Search common build output locations for compile_commands.json.
    const std::vector<std::filesystem::path> candidates = {
        workspace / "build" / "compile_commands.json",
        workspace / "compile_commands.json",
        workspace / "out" / "compile_commands.json",
        workspace / "cmake-build-debug" / "compile_commands.json",
        workspace / "cmake-build-release" / "compile_commands.json",
    };

    for (const auto& p : candidates) {
        if (!std::filesystem::exists(p)) continue;
        std::string err;
        _db = clang::tooling::JSONCompilationDatabase::loadFromFile(
            p.string(), err,
            clang::tooling::JSONCommandLineSyntax::AutoDetect);
        if (_db) {
            Logger::instance().info("AstProject: loaded " + p.string());
            return;
        }
        Logger::instance().warn("AstProject: failed to load " + p.string() + ": " + err);
    }
    throw std::runtime_error(
        "compile_commands.json not found under workspace " + workspace.string());
}

std::vector<std::string> AstProject::compileArgsFor(const std::string& file) const {
    const auto cmds = _db->getCompileCommands(file);
    if (cmds.empty()) return {};
    return cmds.front().CommandLine;
}

std::vector<std::string> AstProject::allFiles() const {
    return _db->getAllFiles();
}

} // namespace perf_lens::ast

#endif // PERF_LENS_HAVE_LLVM
