#include "shadow_compile.hpp"
#include "util/logger.hpp"

#include <nlohmann/json.hpp>
#include <cstdlib>
#include <fstream>
#include <stdexcept>

namespace perf_lens {

ShadowCompiler::ShadowCompiler(const std::filesystem::path& workspace_root)
    : _workspace(workspace_root)
{
    for (const auto* rel : {
        "compile_commands.json",
        "build/compile_commands.json",
        "build/Release/compile_commands.json",
        "build/Debug/compile_commands.json",
    }) {
        if (const auto p = workspace_root / rel; std::filesystem::exists(p)) {
            _compile_commands = p;
            break;
        }
    }
}

std::string ShadowCompiler::findCompileCommand(const std::filesystem::path& source_file) {
    if (_compile_commands.empty())
        throw std::runtime_error("compile_commands.json not found in workspace");

    std::ifstream f(_compile_commands);
    if (!f.is_open())
        throw std::runtime_error("Cannot open compile_commands.json");

    nlohmann::json db;
    try { f >> db; }
    catch (const nlohmann::json::exception& e) {
        throw std::runtime_error(
            std::string("compile_commands.json parse error: ") + e.what());
    }

    const auto target = std::filesystem::weakly_canonical(source_file);
    for (const auto& entry : db) {
        const auto file = std::filesystem::weakly_canonical(
            std::filesystem::path(entry.value("file", std::string{})));
        if (file == target)
            return entry.value("command", std::string{});
    }

    throw std::runtime_error(
        "File not found in compile_commands.json: " + source_file.string());
}

ShadowCompileResult ShadowCompiler::compile(const std::filesystem::path& source_file,
                                             bool with_time_trace) {
    const auto cmd_base = findCompileCommand(source_file);

    // Output directory for generated opt-record files
    const auto out_dir = _workspace / ".perf-lens" / "opt-records";
    std::filesystem::create_directories(out_dir);

    // Use source filename stem to avoid collisions
    const auto stem     = source_file.filename().string();
    const auto out_yaml = out_dir / (stem + ".opt.yaml");
    const auto out_trace= out_dir / (stem + ".ftime-trace.json");
    const auto err_file = out_dir / (stem + ".stderr.txt");

    // Append remark flags; discard object output
    std::string cmd = cmd_base;
    cmd += " -fsave-optimization-record=yaml";
    cmd += " -foptimization-record-file=" + out_yaml.string();
    if (with_time_trace)
        cmd += " -ftime-trace=" + out_trace.string();
    cmd += " -o /dev/null";
    cmd += " >" + err_file.string() + " 2>&1";

    Logger::instance().info("Shadow compile: " + source_file.string() +
                            (with_time_trace ? " (with -ftime-trace)" : ""));
    Logger::instance().debug("Command: " + cmd);

    // std::system is standard C++ (cstdlib); we redirect both streams to file
    const int exit_code = std::system(cmd.c_str()); // NOLINT(cert-env33-c)

    ShadowCompileResult result;
    result.remarks_file = out_yaml;
    if (with_time_trace && std::filesystem::exists(out_trace))
        result.trace_file = out_trace;

    // Read captured stderr for diagnostics
    if (std::ifstream ef(err_file); ef.is_open()) {
        result.compiler_stderr.assign(
            std::istreambuf_iterator<char>(ef), {});
    }

    if (exit_code != 0) {
        Logger::instance().warn(
            "Shadow compile exited " + std::to_string(exit_code) +
            "; opt-records may still be present");
    }

    if (!std::filesystem::exists(out_yaml)) {
        throw std::runtime_error(
            "Compiler did not produce opt-record file. "
            "Ensure the compiler in compile_commands.json is Clang 11+ and "
            "supports -fsave-optimization-record=yaml.\n"
            "Compiler output: " + result.compiler_stderr);
    }

    return result;
}

} // namespace perf_lens
