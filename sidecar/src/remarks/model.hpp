#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace perf_lens::remarks {

enum class RemarkType : uint8_t {
    Passed   = 0,
    Missed   = 1,
    Analysis = 2,
};

enum class Category : uint8_t {
    Vectorisation = 0,
    Inlining      = 1,
    Unrolling     = 2,
    LoopTransform = 3,
    Memory        = 4,
    CodeLayout    = 5,
    DeadCode      = 6,
    Other         = 7,
};

inline const char* categoryName(Category c) noexcept {
    switch (c) {
        case Category::Vectorisation: return "Vectorisation";
        case Category::Inlining:      return "Inlining";
        case Category::Unrolling:     return "Unrolling";
        case Category::LoopTransform: return "Loop transforms";
        case Category::Memory:        return "Memory";
        case Category::CodeLayout:    return "Code layout";
        case Category::DeadCode:      return "Dead code";
        default:                      return "Other";
    }
}

struct SourceLocation {
    std::string file;
    int         line   = 0;
    int         column = 0;
};

struct RemarkArg {
    std::string key;
    std::string value;
};

struct OptRemark {
    RemarkType             type{RemarkType::Analysis};
    std::string            pass;
    std::string            name;
    SourceLocation         location;
    std::string            function;
    std::string            message;       // composed human-readable string from Args
    std::vector<RemarkArg> args;
    Category               category{Category::Other};
    std::string            source_hash;   // hash of source line at ingest time
    std::string            build_id;
    bool                   is_stale{false};
};

} // namespace perf_lens::remarks
