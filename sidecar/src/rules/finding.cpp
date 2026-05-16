#include "finding.hpp"

namespace perf_lens::rules {

const char* categoryName(FindingCategory c) noexcept {
    switch (c) {
        case FindingCategory::MemoryLayout:   return "Memory Layout";
        case FindingCategory::Vectorisation:  return "Vectorisation";
        case FindingCategory::Constexpr:      return "Constexpr";
        case FindingCategory::HotPath:        return "Hot Path";
        case FindingCategory::FunctionAttrib: return "Function Attributes";
        case FindingCategory::StlHygiene:     return "STL Hygiene";
        case FindingCategory::Concurrency:    return "Concurrency";
        case FindingCategory::UndefinedBeh:   return "Undefined Behaviour";
        case FindingCategory::Build:          return "Build";
        default:                              return "Other";
    }
}

const char* confidenceName(ConfidenceLevel c) noexcept {
    switch (c) {
        case ConfidenceLevel::High:   return "high";
        case ConfidenceLevel::Medium: return "medium";
        case ConfidenceLevel::Low:    return "low";
        default:                      return "unknown";
    }
}

} // namespace perf_lens::rules
