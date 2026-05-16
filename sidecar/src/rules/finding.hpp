#pragma once
#include <cstdint>
#include <string>

namespace perf_lens::rules {

enum class ConfidenceLevel : uint8_t { High = 0, Medium = 1, Low = 2 };
enum class FindingCategory : uint8_t {
    MemoryLayout   = 0,
    Vectorisation  = 1,
    Constexpr      = 2,
    HotPath        = 3,
    FunctionAttrib = 4,
    StlHygiene     = 5,
    Concurrency    = 6,
    UndefinedBeh   = 7,
    Build          = 8,
    Other          = 9,
};

const char* categoryName(FindingCategory c) noexcept;
const char* confidenceName(ConfidenceLevel c) noexcept;

struct Finding {
    std::string  rule_id;
    std::string  title;
    std::string  message;
    std::string  file;
    int          line     = 0;
    int          column   = 0;
    FindingCategory  category   = FindingCategory::Other;
    ConfidenceLevel  confidence = ConfidenceLevel::Medium;
    std::string  build_id;
};

} // namespace perf_lens::rules
