#pragma once
#include "../../finding.hpp"
#include "../../../profile/store.hpp"
#include <string>
#include <vector>

namespace perf_lens::rules::profile_driven {

// Thresholds — all tunable via .perf-lens.yaml in the future
constexpr double CACHE_MISS_HOTSPOT_CYCLE_FRACTION = 0.05;   // ≥5% of cycles
constexpr double CACHE_MISS_EVENT_FRACTION         = 0.10;   // ≥10% of L1 misses
constexpr double BRANCH_MISS_FRACTION              = 0.10;   // ≥10% of branch-misses
constexpr double BRANCH_CYCLE_FRACTION             = 0.03;   // ≥3% of cycles
constexpr double BANDWIDTH_LLCMISS_FRACTION        = 0.15;   // ≥15% of LLC misses at a hotspot
constexpr double LOW_IPC_CYCLE_FRACTION            = 0.05;   // ≥5% of cycles
constexpr double LOW_IPC_THRESHOLD                 = 0.5;    // IPC < 0.5 (rough — no IPC data, heuristic)

// Run all profile-derived rules for the given file.
// Requires an active profile in the store.
std::vector<Finding> analyseFileWithProfile(
    const std::string& profile_id,
    const std::string& file,
    profile::ProfileStore& store);

} // namespace perf_lens::rules::profile_driven
