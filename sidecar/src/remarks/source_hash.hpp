#pragma once

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>

namespace perf_lens::remarks {

/** FNV-1a 64-bit hash of line `line_num` (1-based) in `file`. Returns "" on error. */
inline std::string hashSourceLine(const std::filesystem::path& file, int line_num) {
    if (line_num <= 0) return {};

    std::ifstream f(file);
    if (!f.is_open()) return {};

    std::string line;
    for (int i = 1; i <= line_num; ++i) {
        if (!std::getline(f, line)) return {};
    }

    uint64_t h = 14695981039346656037ULL;
    for (const unsigned char c : line) {
        h ^= c;
        h *= 1099511628211ULL;
    }

    // Format as 16-char hex string
    constexpr const char* hex = "0123456789abcdef";
    std::string result(16, '0');
    for (int i = 15; i >= 0; --i) {
        result[static_cast<std::size_t>(i)] = hex[h & 0xFU];
        h >>= 4U;
    }
    return result;
}

} // namespace perf_lens::remarks
