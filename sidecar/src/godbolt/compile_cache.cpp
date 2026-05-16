#include "compile_cache.hpp"
#include <algorithm>

namespace perf_lens::godbolt {

std::optional<CompileResult> CompileCache::get(const std::string& key) {
    std::lock_guard lock(_mu);
    auto it = _map.find(key);
    if (it == _map.end()) return std::nullopt;
    // Move to end of order (most recently used)
    auto oit = std::find(_order.begin(), _order.end(), key);
    if (oit != _order.end()) {
        _order.erase(oit);
        _order.push_back(key);
    }
    CompileResult r = it->second;
    r.from_cache = true;
    return r;
}

void CompileCache::set(const std::string& key, CompileResult result) {
    std::lock_guard lock(_mu);
    if (_map.count(key) == 0) {
        _order.push_back(key);
        _evict();
    }
    result.from_cache = false;
    _map[key] = std::move(result);
}

void CompileCache::clear() {
    std::lock_guard lock(_mu);
    _map.clear();
    _order.clear();
}

void CompileCache::_evict() {
    while (static_cast<int>(_map.size()) >= MAX_ENTRIES && !_order.empty()) {
        _map.erase(_order.front());
        _order.erase(_order.begin());
    }
}

} // namespace perf_lens::godbolt
