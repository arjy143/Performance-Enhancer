#include "profile_rules.hpp"
#include <algorithm>
#include <cmath>
#include <sstream>
#include <unordered_map>

namespace perf_lens::rules::profile_driven {

namespace {

Finding makeFinding(const std::string& rule_id,
                    const std::string& title,
                    const std::string& message,
                    const std::string& file,
                    int line,
                    FindingCategory cat = FindingCategory::HotPath,
                    ConfidenceLevel conf = ConfidenceLevel::High) {
    Finding f;
    f.rule_id    = rule_id;
    f.title      = title;
    f.message    = message;
    f.file       = file;
    f.line       = line;
    f.category   = cat;
    f.confidence = conf;
    f.build_id   = "profile";
    return f;
}

std::string pctStr(double fraction) {
    std::ostringstream ss;
    ss.precision(1);
    ss << std::fixed << (fraction * 100.0) << "%";
    return ss.str();
}

// ── Rule: cache-miss-hotspot ──────────────────────────────────────────────
// Fires when a line has ≥5% of cycles AND ≥10% of L1 miss events.
// The high L1 miss fraction combined with being a hot line strongly suggests
// a memory-bound bottleneck addressable by layout or prefetch changes.
void checkCacheMissHotspot(const std::string& profile_id,
                            const std::string& file,
                            profile::ProfileStore& store,
                            std::vector<Finding>& out) {
    const auto cycles = store.getFileHotness(profile_id, file, "cycles");
    const auto misses = store.getFileHotness(profile_id, file, "L1-dcache-load-misses");

    if (cycles.empty() || misses.empty()) return;

    // Build miss fraction map
    std::unordered_map<int, double> miss_map;
    for (const auto& h : misses)
        miss_map[h.line] = h.fraction;

    for (const auto& h : cycles) {
        if (h.fraction < CACHE_MISS_HOTSPOT_CYCLE_FRACTION) continue;
        auto it = miss_map.find(h.line);
        if (it == miss_map.end()) continue;
        if (it->second < CACHE_MISS_EVENT_FRACTION) continue;

        out.push_back(makeFinding(
            "perf-lens.profile.cache-miss-hotspot",
            "Cache-miss hotspot",
            "Line is " + pctStr(h.fraction) + " of cycles with " +
            pctStr(it->second) + " of L1 cache misses. "
            "Consider struct layout reorganisation, prefetching, or AoS-to-SoA conversion.",
            file, h.line,
            FindingCategory::MemoryLayout,
            ConfidenceLevel::High));
    }
}

// ── Rule: branch-mispredict-hotspot ──────────────────────────────────────
// Fires when a line has ≥10% of branch-miss events AND ≥3% of cycles.
void checkBranchMispredict(const std::string& profile_id,
                            const std::string& file,
                            profile::ProfileStore& store,
                            std::vector<Finding>& out) {
    const auto cycles  = store.getFileHotness(profile_id, file, "cycles");
    const auto bmisses = store.getFileHotness(profile_id, file, "branch-misses");

    if (cycles.empty() || bmisses.empty()) return;

    std::unordered_map<int, double> cyc_map;
    for (const auto& h : cycles) cyc_map[h.line] = h.fraction;

    for (const auto& h : bmisses) {
        if (h.fraction < BRANCH_MISS_FRACTION) continue;
        const auto it = cyc_map.find(h.line);
        if (it == cyc_map.end() || it->second < BRANCH_CYCLE_FRACTION) continue;

        out.push_back(makeFinding(
            "perf-lens.profile.branch-mispredict",
            "Branch mispredict hotspot",
            "Line accounts for " + pctStr(h.fraction) + " of branch mispredictions "
            "and " + pctStr(it->second) + " of cycles. "
            "Consider branch elimination, sorted data, or branchless alternatives.",
            file, h.line,
            FindingCategory::HotPath,
            ConfidenceLevel::High));
    }
}

// ── Rule: memory-bandwidth-bound ──────────────────────────────────────────
// Fires when a line has both high cycles fraction and high LLC miss fraction.
// High LLC misses indicate main-memory bandwidth pressure.
void checkMemoryBandwidthBound(const std::string& profile_id,
                                const std::string& file,
                                profile::ProfileStore& store,
                                std::vector<Finding>& out) {
    const auto cycles   = store.getFileHotness(profile_id, file, "cycles");
    const auto llcmiss  = store.getFileHotness(profile_id, file, "LLC-load-misses");

    if (cycles.empty() || llcmiss.empty()) return;

    std::unordered_map<int, double> llc_map;
    for (const auto& h : llcmiss) llc_map[h.line] = h.fraction;

    for (const auto& h : cycles) {
        if (h.fraction < CACHE_MISS_HOTSPOT_CYCLE_FRACTION) continue;
        const auto it = llc_map.find(h.line);
        if (it == llc_map.end() || it->second < BANDWIDTH_LLCMISS_FRACTION) continue;

        out.push_back(makeFinding(
            "perf-lens.profile.memory-bandwidth-bound",
            "Memory-bandwidth bound",
            "Line is " + pctStr(h.fraction) + " of cycles with " +
            pctStr(it->second) + " of LLC misses; main-memory bandwidth pressure. "
            "Reduce working-set size, improve locality, or compress data.",
            file, h.line,
            FindingCategory::MemoryLayout,
            ConfidenceLevel::Medium));
    }
}

// ── Rule: low-IPC hotspot ─────────────────────────────────────────────────
// A line with many cycles but no corresponding L1/LLC miss → likely a
// dependency chain or throughput bottleneck (compute-bound but not memory).
// We detect this by: high cycles fraction + no L1 miss elevation.
void checkLowIpc(const std::string& profile_id,
                 const std::string& file,
                 profile::ProfileStore& store,
                 std::vector<Finding>& out) {
    const auto cycles = store.getFileHotness(profile_id, file, "cycles");
    const auto misses = store.getFileHotness(profile_id, file, "L1-dcache-load-misses");

    if (cycles.empty()) return;

    std::unordered_map<int, double> miss_map;
    for (const auto& h : misses) miss_map[h.line] = h.fraction;

    for (const auto& h : cycles) {
        if (h.fraction < LOW_IPC_CYCLE_FRACTION * 2) continue;  // must be quite hot
        const auto it = miss_map.find(h.line);
        // Only fire if L1 miss fraction is low (not cache-bound)
        if (it != miss_map.end() && it->second >= CACHE_MISS_EVENT_FRACTION * 0.5) continue;

        out.push_back(makeFinding(
            "perf-lens.profile.low-ipc",
            "Compute-bound hotspot (low IPC)",
            "Line is " + pctStr(h.fraction) + " of cycles with no elevated cache miss rate. "
            "Likely a dependency-chain bottleneck. Consider instruction-level parallelism, "
            "loop unrolling, or FP reassociation (with -ffast-math).",
            file, h.line,
            FindingCategory::HotPath,
            ConfidenceLevel::Medium));
    }
}

} // namespace

// ── Public entry point ────────────────────────────────────────────────────

std::vector<Finding> analyseFileWithProfile(
    const std::string& profile_id,
    const std::string& file,
    profile::ProfileStore& store)
{
    std::vector<Finding> out;
    checkCacheMissHotspot(profile_id, file, store, out);
    checkBranchMispredict(profile_id, file, store, out);
    checkMemoryBandwidthBound(profile_id, file, store, out);
    checkLowIpc(profile_id, file, store, out);
    return out;
}

} // namespace perf_lens::rules::profile_driven
