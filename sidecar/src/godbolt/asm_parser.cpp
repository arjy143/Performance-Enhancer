#include "asm_parser.hpp"
#include <algorithm>
#include <regex>
#include <sstream>
#include <string_view>

namespace perf_lens::godbolt {

namespace {

// Directives we drop entirely from the cleaned output.
constexpr std::string_view NOISE_PREFIXES[] = {
    ".cfi_", ".file", ".ident", ".section", ".align",
    ".p2align", ".size", ".type", ".globl", ".weak",
    ".hidden", ".protected", ".internal", ".comm",
    ".bss", ".data", ".rodata", ".pushsection", ".popsection",
};

bool isNoise(std::string_view line) {
    const auto t = line.find_first_not_of(" \t");
    if (t == std::string_view::npos) return true;
    const auto rest = line.substr(t);
    for (const auto& p : NOISE_PREFIXES) {
        if (rest.starts_with(p)) return true;
    }
    return false;
}

// Parse a .loc directive: `.loc <file_idx> <line> <col>`
// Returns {line, col} or {0,0} on failure.
std::pair<int,int> parseLoc(std::string_view line) {
    const auto t = line.find_first_not_of(" \t");
    if (t == std::string_view::npos) return {0,0};
    const auto rest = line.substr(t);
    if (!rest.starts_with(".loc")) return {0,0};

    std::istringstream ss{std::string(rest)};
    std::string dot_loc;
    int file_idx{0}, src_line{0}, src_col{0};
    ss >> dot_loc >> file_idx >> src_line >> src_col;
    if (ss.fail() || src_line <= 0) return {0,0};
    return {src_line, src_col};
}

// Strip inline verbose-asm comments (# ...) that follow instructions
// but keep the instruction text itself.
std::string stripInlineComment(std::string_view line) {
    // Comments start with '#' — but only strip trailing ones, not mid-instruction
    const auto hash = line.rfind('#');
    if (hash == std::string_view::npos) return std::string(line);
    // Only strip if preceded by whitespace
    if (hash > 0 && (line[hash-1] == ' ' || line[hash-1] == '\t'))
        return std::string(line.substr(0, hash));
    return std::string(line);
}

// Trim trailing whitespace
std::string rtrim(std::string s) {
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r'))
        s.pop_back();
    return s;
}

} // namespace

AssemblyOutput parseAssembly(const std::string& raw_asm) {
    AssemblyOutput out;
    std::istringstream stream{raw_asm};
    std::string line;

    std::vector<std::string> clean_lines;
    int current_src_col{0};
    int asm_line_idx{0};  // index in clean_lines

    // Track the asm range for the current source line
    int range_start{0};
    int range_src_line{0};

    auto flush_mapping = [&]() {
        if (range_src_line > 0 && asm_line_idx > range_start) {
            SourceMapping m;
            m.asm_line_start = range_start;
            m.asm_line_end   = asm_line_idx - 1;
            m.source_line    = range_src_line;
            m.source_column  = current_src_col;
            out.source_map.push_back(m);
        }
    };

    while (std::getline(stream, line)) {
        std::string_view sv{line};

        // Handle .loc directives — extract mapping, don't emit
        {
            const auto t = sv.find_first_not_of(" \t");
            if (t != std::string_view::npos && sv.substr(t).starts_with(".loc")) {
                auto [sl, sc] = parseLoc(sv);
                if (sl > 0) {
                    flush_mapping();
                    current_src_col  = sc;
                    range_start      = asm_line_idx;
                    range_src_line   = sl;
                }
                continue;
            }
        }

        if (isNoise(sv)) continue;

        // Keep labels and instructions
        const std::string cleaned = rtrim(stripInlineComment(sv));
        if (cleaned.empty()) continue;
        clean_lines.push_back(cleaned);
        ++asm_line_idx;
    }

    flush_mapping();

    // Build text
    std::ostringstream text;
    for (const auto& cl : clean_lines) text << cl << '\n';
    out.text = text.str();

    out.vector_width_used = detectVectorWidth(out.text);
    return out;
}

int detectVectorWidth(const std::string& asm_text) {
    // Check for AVX-512 first (zmm registers, 512-bit = 16×float)
    if (asm_text.find(" zmm") != std::string::npos ||
        asm_text.find(",zmm") != std::string::npos)
        return 16;
    // AVX/AVX2 (ymm, 256-bit = 8×float)
    if (asm_text.find(" ymm") != std::string::npos ||
        asm_text.find(",ymm") != std::string::npos)
        return 8;
    // SSE (xmm, 128-bit = 4×float)
    if (asm_text.find(" xmm") != std::string::npos ||
        asm_text.find(",xmm") != std::string::npos)
        return 4;
    return 1;
}

} // namespace perf_lens::godbolt
