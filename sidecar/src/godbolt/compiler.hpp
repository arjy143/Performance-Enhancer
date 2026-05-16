#pragma once
#include <chrono>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace perf_lens::godbolt {

// ---------------------------------------------------------------------------
// Core structures
// ---------------------------------------------------------------------------

struct SourceMapping {
    int asm_line_start{0};
    int asm_line_end{0};
    int source_line{0};
    int source_column{0};
    std::string source_file;
    int inline_depth{0};
};

struct AssemblyOutput {
    std::string text;
    std::vector<SourceMapping> source_map;
    int vector_width_used{1};  // 1=scalar 4=SSE(xmm) 8=AVX(ymm) 16=AVX-512(zmm)
};

struct CompileDiagnostic {
    int line{0};
    int column{0};
    std::string level;   // "error" | "warning" | "note"
    std::string message;
};

struct MCAReport {
    double ipc{0.0};
    double cycles_per_iteration{0.0};
    std::string bottleneck;
};

struct CompileResult {
    bool success{false};
    AssemblyOutput assembly;
    std::vector<CompileDiagnostic> diagnostics;
    std::optional<MCAReport> mca;
    std::string content_hash;
    bool from_cache{false};
    std::chrono::milliseconds wall_time{0};
    std::string stderr_output;
};

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

struct InstructionDiff {
    enum class Kind { Added, Removed, Unchanged };
    Kind kind{Kind::Unchanged};
    std::string before_text;
    std::string after_text;
    std::string category;  // "vectorised" | "inlined" | "eliminated" | ""
};

struct AsmDiff {
    std::vector<InstructionDiff> changes;
    int instructions_before{0};
    int instructions_after{0};
    int vector_width_before{1};
    int vector_width_after{1};
    bool vectorisation_improved{false};
    std::string summary;
};

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

class GodBoltCompiler {
public:
    explicit GodBoltCompiler(std::filesystem::path workspace);

    CompileResult compile(const std::string& source,
                          const std::vector<std::string>& extra_flags,
                          bool run_mca = false);

    static AsmDiff diff(const AssemblyOutput& before, const AssemblyOutput& after);

    bool available() const noexcept { return !_compiler_path.empty(); }
    const std::string& compilerPath() const noexcept { return _compiler_path; }

private:
    std::filesystem::path _workspace;
    std::string _compiler_path;
    std::string _compiler_version;
    std::string _mca_path;

    void _detectCompiler();
    void _detectMca();
    static std::string _contentHash(const std::string& source,
                                    const std::vector<std::string>& flags,
                                    const std::string& ver);
};

} // namespace perf_lens::godbolt
