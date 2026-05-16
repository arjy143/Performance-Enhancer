#pragma once

#include <filesystem>
#include <string>

namespace perf_lens {

struct ShadowCompileResult {
    std::filesystem::path remarks_file;
    std::string           compiler_stderr;
};

/**
 * Shadow-compile a source file to capture Clang optimisation remarks.
 *
 * Looks up the file's entry in compile_commands.json, appends
 * -fsave-optimization-record flags, invokes the compiler, and returns the
 * path to the generated .opt.yaml file.
 *
 * Requires Clang in the compile command (GCC does not support
 * -fsave-optimization-record=yaml).
 *
 * Throws std::runtime_error on unrecoverable failure.
 */
class ShadowCompiler {
public:
    explicit ShadowCompiler(const std::filesystem::path& workspace_root);

    ShadowCompileResult compile(const std::filesystem::path& source_file);

private:
    std::string findCompileCommand(const std::filesystem::path& source_file);

    std::filesystem::path _workspace;
    std::filesystem::path _compile_commands;
};

} // namespace perf_lens
