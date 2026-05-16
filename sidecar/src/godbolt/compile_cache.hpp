#pragma once
#include "compiler.hpp"
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>

namespace perf_lens::godbolt {

// Thread-safe in-memory LRU compile cache (max 256 entries).
class CompileCache {
public:
    static constexpr int MAX_ENTRIES = 256;

    std::optional<CompileResult> get(const std::string& key);
    void set(const std::string& key, CompileResult result);
    void clear();

private:
    mutable std::mutex _mu;
    // Insertion-ordered via a parallel vector of keys for LRU eviction.
    std::unordered_map<std::string, CompileResult> _map;
    std::vector<std::string> _order;

    void _evict();
};

} // namespace perf_lens::godbolt
