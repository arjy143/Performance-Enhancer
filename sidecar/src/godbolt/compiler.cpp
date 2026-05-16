#include "compiler.hpp"
#include "asm_parser.hpp"
#include "compile_cache.hpp"
#include "diff_engine.hpp"

#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <sstream>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace perf_lens::godbolt {

namespace {

// Global cache shared across all GodBoltCompiler instances.
CompileCache g_cache;

// Run a command, capture stdout+stderr combined, return exit code.
int runCommand(const std::string& cmd, std::string& output) {
    output.clear();
    std::array<char, 4096> buf{};
    FILE* pipe = ::popen((cmd + " 2>&1").c_str(), "r");
    if (!pipe) return -1;
    while (::fgets(buf.data(), static_cast<int>(buf.size()), pipe)) {
        output += buf.data();
    }
    return ::pclose(pipe);
}

// Sanitise flags: strip dangerous or conflicting options.
std::vector<std::string> sanitiseFlags(const std::vector<std::string>& flags) {
    std::vector<std::string> out;
    out.reserve(flags.size());
    for (const auto& f : flags) {
        if (f.starts_with("-fsanitize")) continue;
        if (f == "-Werror")             continue;
        if (f == "-c")                  continue;
        // Skip source file args (.cpp/.c/.o)
        if (f.ends_with(".cpp") || f.ends_with(".cxx") || f.ends_with(".cc") ||
            f.ends_with(".c")   || f.ends_with(".o")   || f.ends_with(".a"))  continue;
        // Skip output flags
        if (f == "-o") continue;
        out.push_back(f);
    }
    return out;
}

// SHA-256 via openssl command (present on all CI targets).
// Fallback: use a simple FNV hash represented as hex.
std::string sha256hex(const std::string& data) {
    // Write to temp file and hash
    char tmp[] = "/tmp/pl-hash-XXXXXX";
    int fd = ::mkstemp(tmp);
    if (fd < 0) goto fallback;
    {
        if (::write(fd, data.data(), data.size()) < 0) { ::close(fd); goto fallback; }
        ::close(fd);
        std::string out;
        const std::string cmd = std::string("sha256sum ") + tmp + " 2>/dev/null";
        runCommand(cmd, out);
        ::unlink(tmp);
        if (out.size() >= 64) return out.substr(0, 64);
    }
fallback:
    // FNV-1a 64-bit
    uint64_t h = 14695981039346656037ULL;
    for (unsigned char c : data) { h ^= c; h *= 1099511628211ULL; }
    std::ostringstream ss;
    ss << std::hex << std::setfill('0') << std::setw(16) << h;
    return ss.str();
}

// Find the compiler from compile_commands.json in the workspace.
std::string detectCompilerFromCCDB(const fs::path& workspace) {
    for (const auto& candidate : {
        workspace / "compile_commands.json",
        workspace / "build" / "compile_commands.json",
    }) {
        if (!fs::exists(candidate)) continue;
        try {
            std::ifstream f(candidate);
            json db = json::parse(f);
            if (!db.is_array() || db.empty()) continue;
            const auto& first = db[0];
            const std::string cmd = first.value("command", "");
            if (cmd.empty()) continue;
            // First token of the command is the compiler
            const auto space = cmd.find(' ');
            return cmd.substr(0, space);
        } catch (...) {}
    }
    return {};
}

} // namespace

// ---------------------------------------------------------------------------
// GodBoltCompiler
// ---------------------------------------------------------------------------

GodBoltCompiler::GodBoltCompiler(fs::path workspace)
    : _workspace(std::move(workspace))
{
    _detectCompiler();
    _detectMca();
}

void GodBoltCompiler::_detectCompiler() {
    _compiler_path = detectCompilerFromCCDB(_workspace);
    if (_compiler_path.empty()) {
        // Fall back to clang++ or c++ from PATH
        for (const auto& cand : {"clang++", "g++", "c++"}) {
            std::string out;
            if (runCommand(std::string("which ") + cand + " 2>/dev/null", out) == 0 && !out.empty()) {
                // Trim newline
                while (!out.empty() && (out.back() == '\n' || out.back() == ' ')) out.pop_back();
                _compiler_path = out;
                break;
            }
        }
    }
    if (_compiler_path.empty()) return;
    // Cache version string for content hashing
    std::string ver_out;
    runCommand(_compiler_path + " --version 2>&1 | head -1", _compiler_version);
    while (!_compiler_version.empty() &&
           (_compiler_version.back() == '\n' || _compiler_version.back() == '\r'))
        _compiler_version.pop_back();
}

void GodBoltCompiler::_detectMca() {
    // Try llvm-mca, llvm-mca-19, llvm-mca-18
    for (const auto& cand : {"llvm-mca", "llvm-mca-19", "llvm-mca-18"}) {
        std::string out;
        if (runCommand(std::string("which ") + cand + " 2>/dev/null", out) == 0 && !out.empty()) {
            while (!out.empty() && (out.back() == '\n' || out.back() == ' ')) out.pop_back();
            _mca_path = out;
            return;
        }
    }
}

std::string GodBoltCompiler::_contentHash(const std::string& source,
                                           const std::vector<std::string>& flags,
                                           const std::string& ver) {
    std::ostringstream ss;
    ss << ver << '\0';
    for (const auto& f : flags) ss << f << '\0';
    ss << source;
    return sha256hex(ss.str());
}

CompileResult GodBoltCompiler::compile(const std::string& source,
                                        const std::vector<std::string>& extra_flags,
                                        bool run_mca)
{
    CompileResult result;
    if (_compiler_path.empty()) {
        result.stderr_output = "No compiler found";
        return result;
    }

    const auto clean_flags = sanitiseFlags(extra_flags);
    const std::string hash = _contentHash(source, clean_flags, _compiler_version);

    // Cache lookup
    if (auto cached = g_cache.get(hash)) {
        return *cached;
    }

    const auto start = std::chrono::steady_clock::now();

    // Write source to temp file
    char src_tmp[] = "/tmp/pl-src-XXXXXX.cpp";
    {
        int fd = ::mkstemps(src_tmp, 4);
        if (fd < 0) { result.stderr_output = "mkstemp failed"; return result; }
        ::write(fd, source.data(), source.size());
        ::close(fd);
    }

    char asm_tmp[]     = "/tmp/pl-asm-XXXXXX.s";
    char remarks_tmp[] = "/tmp/pl-rmk-XXXXXX.yaml";
    {
        int fa = ::mkstemps(asm_tmp,     2);
        int fr = ::mkstemps(remarks_tmp, 5);
        if (fa >= 0) ::close(fa);
        if (fr >= 0) ::close(fr);
    }

    // Build command
    std::ostringstream cmd;
    cmd << _compiler_path;
    cmd << " -S -fverbose-asm -masm=intel";
    cmd << " -g -fno-asynchronous-unwind-tables";
    cmd << " -fsave-optimization-record=yaml";
    cmd << " -foptimization-record-file=" << remarks_tmp;
    for (const auto& f : clean_flags) cmd << " " << f;
    cmd << " " << src_tmp << " -o " << asm_tmp;

    std::string cmd_output;
    const int exit_code = runCommand(cmd.str(), cmd_output);
    result.stderr_output = cmd_output;
    result.success = (exit_code == 0);

    if (result.success) {
        // Read asm
        std::ifstream asm_f(asm_tmp);
        if (asm_f) {
            std::ostringstream raw;
            raw << asm_f.rdbuf();
            result.assembly = parseAssembly(raw.str());
        }

        // Run llvm-mca if requested and available
        if (run_mca && !_mca_path.empty() && fs::exists(asm_tmp)) {
            std::string mca_out;
            const std::string mca_cmd = _mca_path + " -mcpu=native --iterations=100 " + asm_tmp;
            runCommand(mca_cmd, mca_out);
            // Parse IPC from plain-text mca output: look for "IPC:" line
            MCAReport mca;
            std::istringstream mca_ss{mca_out};
            std::string mca_line;
            while (std::getline(mca_ss, mca_line)) {
                if (mca_line.find("IPC") != std::string::npos) {
                    const auto colon = mca_line.rfind(':');
                    if (colon != std::string::npos) {
                        try { mca.ipc = std::stod(mca_line.substr(colon+1)); } catch (...) {}
                    }
                }
            }
            result.mca = mca;
        }
    }

    // Cleanup temp files
    ::unlink(src_tmp);
    ::unlink(asm_tmp);
    ::unlink(remarks_tmp);

    const auto end = std::chrono::steady_clock::now();
    result.wall_time = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
    result.content_hash = hash;

    g_cache.set(hash, result);
    return result;
}

// static
AsmDiff GodBoltCompiler::diff(const AssemblyOutput& before, const AssemblyOutput& after) {
    const auto before_instrs = extractInstructions(before.text);
    const auto after_instrs  = extractInstructions(after.text);
    return diffInstructions(before_instrs, after_instrs,
                             before.vector_width_used,
                             after.vector_width_used);
}

} // namespace perf_lens::godbolt
