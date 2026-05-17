#include "perf_script_parser.hpp"
#include "model.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace profile {

// ── Internal frame/aggregation types ─────────────────────────────────────

struct PerfFrame {
    uint64_t    address  = 0;
    std::string function;
    std::string file;
    int         line     = 0;
    std::string module;
};

struct LineKey {
    std::string event;
    std::string file;
    int         line = 0;
    bool operator==(const LineKey& o) const noexcept {
        return event == o.event && file == o.file && line == o.line;
    }
};

struct FuncKey {
    std::string event;
    std::string function;
    bool operator==(const FuncKey& o) const noexcept {
        return event == o.event && function == o.function;
    }
};

} // namespace profile

namespace std {
template<> struct hash<profile::LineKey> {
    size_t operator()(const profile::LineKey& k) const noexcept {
        size_t h = std::hash<std::string>{}(k.event);
        h ^= std::hash<std::string>{}(k.file)  + 0x9e3779b9 + (h << 6) + (h >> 2);
        h ^= std::hash<int>{}(k.line)           + 0x9e3779b9 + (h << 6) + (h >> 2);
        return h;
    }
};
template<> struct hash<profile::FuncKey> {
    size_t operator()(const profile::FuncKey& k) const noexcept {
        size_t h = std::hash<std::string>{}(k.event);
        h ^= std::hash<std::string>{}(k.function) + 0x9e3779b9 + (h << 6) + (h >> 2);
        return h;
    }
};
} // namespace std

namespace profile {

// ── Parsing helpers ───────────────────────────────────────────────────────

static std::vector<std::string_view> splitWs(std::string_view s) {
    std::vector<std::string_view> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
        size_t j = i;
        while (j < s.size() && s[j] != ' ' && s[j] != '\t') ++j;
        if (j > i) out.push_back(s.substr(i, j - i));
        i = j;
    }
    return out;
}

// Parse a sample header line:
//   comm  pid  [cpu]  timestamp:  count  event:
// Returns false if the line doesn't look like a header.
static bool parseHeader(std::string_view line,
                        std::string& event_out,
                        uint64_t&    count_out,
                        double&      ts_out)
{
    auto toks = splitWs(line);
    if (toks.size() < 4) return false;

    // The event token ends with ':' and the previous token is a count number.
    // Search backwards.
    for (int i = static_cast<int>(toks.size()) - 1; i > 0; --i) {
        auto tok = toks[i];
        if (tok.empty() || tok.back() != ':') continue;
        auto prev = toks[i - 1];
        uint64_t count = 0;
        auto [p, ec] = std::from_chars(prev.data(), prev.data() + prev.size(), count);
        if (ec != std::errc{} || p != prev.data() + prev.size()) continue;

        event_out = std::string(tok.substr(0, tok.size() - 1));
        count_out = count;

        // Extract timestamp: a token containing '.' that's > 1000.0
        for (auto& t : toks) {
            auto ts_sv = t;
            if (ts_sv.back() == ':') ts_sv = ts_sv.substr(0, ts_sv.size() - 1);
            if (ts_sv.find('.') == std::string_view::npos) continue;
            double f = 0.0;
            try { f = std::stod(std::string(ts_sv)); } catch (...) { continue; }
            if (f > 1000.0) { ts_out = f; break; }
        }
        return true;
    }
    return false;
}

// Parse a frame line (leading whitespace):
//   \t addr  symbol+0x10  (module)  [file.cpp:42]
static bool parseFrame(std::string_view line, PerfFrame& frame_out)
{
    // Must start with whitespace
    if (line.empty() || (line[0] != '\t' && line[0] != ' ')) return false;

    std::string_view trimmed = line;
    while (!trimmed.empty() && (trimmed[0] == ' ' || trimmed[0] == '\t'))
        trimmed.remove_prefix(1);
    if (trimmed.empty()) return false;

    // Split into max 3 parts: addr, symbol, rest
    auto sp1 = trimmed.find(' ');
    if (sp1 == std::string_view::npos) return false;

    auto addr_sv = trimmed.substr(0, sp1);
    auto remainder = trimmed.substr(sp1 + 1);

    // addr
    uint64_t addr = 0;
    std::from_chars(addr_sv.data(), addr_sv.data() + addr_sv.size(), addr, 16);
    frame_out.address = addr;

    // symbol (up to next space or end)
    auto sp2 = remainder.find(' ');
    auto sym_sv = (sp2 == std::string_view::npos) ? remainder : remainder.substr(0, sp2);

    // Strip "+0xNNN" offset
    auto plus = sym_sv.find('+');
    if (plus != std::string_view::npos) sym_sv = sym_sv.substr(0, plus);
    // Strip leading '[' (can appear in some perf versions)
    while (!sym_sv.empty() && sym_sv[0] == '[') sym_sv.remove_prefix(1);
    frame_out.function = std::string(sym_sv);

    if (sp2 == std::string_view::npos) return true;
    auto rest = remainder.substr(sp2 + 1);

    // Module: inside first (...)
    if (auto lp = rest.find('('); lp != std::string_view::npos) {
        if (auto rp = rest.find(')', lp); rp != std::string_view::npos)
            frame_out.module = std::string(rest.substr(lp + 1, rp - lp - 1));
    }

    // Source location: inside last [...]
    if (auto lb = rest.rfind('['); lb != std::string_view::npos) {
        auto inner = rest.substr(lb + 1);
        if (auto rb = inner.find(']'); rb != std::string_view::npos)
            inner = inner.substr(0, rb);
        // Split on last ':'
        if (auto col = inner.rfind(':'); col != std::string_view::npos) {
            frame_out.file = std::string(inner.substr(0, col));
            int ln = 0;
            std::from_chars(inner.data() + col + 1,
                            inner.data() + inner.size(), ln);
            frame_out.line = ln;
        }
    }
    return true;
}

// ── Aggregator ────────────────────────────────────────────────────────────

struct Aggregator {
    std::unordered_map<LineKey, uint64_t>               line_counts;
    std::unordered_map<FuncKey, std::pair<uint64_t, std::string>> func_counts;
    uint64_t total_samples = 0;
    double   first_ts      = 0.0;
    double   last_ts       = 0.0;

    void record(const std::string& event, uint64_t count, double ts,
                const std::vector<PerfFrame>& frames) {
        ++total_samples;
        if (first_ts == 0.0) first_ts = ts;
        last_ts = ts;

        if (frames.empty()) return;
        const auto& leaf = frames.front();

        if (!leaf.file.empty() && leaf.line > 0) {
            line_counts[{event, leaf.file, leaf.line}] += count;
        }
        if (!leaf.function.empty()) {
            auto& entry = func_counts[{event, leaf.function}];
            entry.first  += count;
            if (entry.second.empty()) entry.second = leaf.file;
        }
    }
};

// ── Public API ────────────────────────────────────────────────────────────

bool looksLikePerfScript(std::istream& is)
{
    std::string line;
    while (std::getline(is, line)) {
        if (line.empty()) continue;
        std::string ev;
        uint64_t count = 0;
        double ts      = 0.0;
        if (parseHeader(line, ev, count, ts)) {
            is.clear();
            is.seekg(0);
            return true;
        }
        // Give up after 20 non-empty lines — it's not perf script
        break;
    }
    is.clear();
    is.seekg(0);
    return false;
}

std::string ingestPerfScript(std::istream& is,
                             ProfileStore&  store,
                             const std::string& label)
{
    Aggregator agg;

    // Parser state
    std::string       cur_event;
    uint64_t          cur_count = 1;
    double            cur_ts    = 0.0;
    std::vector<PerfFrame> cur_frames;
    bool              in_sample = false;

    auto flush = [&]() {
        if (in_sample && !cur_frames.empty())
            agg.record(cur_event, cur_count, cur_ts, cur_frames);
    };

    std::string raw;
    while (std::getline(is, raw)) {
        // Normalise CRLF
        if (!raw.empty() && raw.back() == '\r') raw.pop_back();

        std::string_view sv(raw);
        bool is_frame = !sv.empty() && (sv[0] == '\t' || sv[0] == ' ');

        if (is_frame && in_sample) {
            PerfFrame f;
            if (parseFrame(sv, f)) cur_frames.push_back(std::move(f));
            continue;
        }

        // Flush pending sample
        flush();
        cur_frames.clear();
        in_sample = false;

        if (!sv.empty() && !is_frame) {
            if (parseHeader(sv, cur_event, cur_count, cur_ts)) {
                in_sample = true;
            }
        }
    }
    flush(); // last sample

    // Build profile metadata
    ProfileMetadata meta;
    meta.label          = label;
    meta.source_profiler = "perf";
    meta.total_samples  = static_cast<int64_t>(agg.total_samples);
    meta.duration_ms    = (agg.last_ts > agg.first_ts)
                          ? static_cast<int64_t>((agg.last_ts - agg.first_ts) * 1000.0)
                          : 0;
    meta.recorded_at    = static_cast<int64_t>(
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());

    const std::string profile_id = store.createProfile(meta);

    // Convert aggregated maps to row vectors
    std::vector<ImportedLineRow> line_rows;
    line_rows.reserve(agg.line_counts.size());
    for (auto& [key, count] : agg.line_counts) {
        line_rows.push_back({key.event, key.file, key.line, count});
    }

    std::vector<ImportedFunctionRow> func_rows;
    func_rows.reserve(agg.func_counts.size());
    for (auto& [key, val] : agg.func_counts) {
        func_rows.push_back({key.event, key.function, val.second, val.first});
    }

    store.insertLineRows(profile_id, line_rows);
    store.insertFunctionRows(profile_id, func_rows);

    return profile_id;
}

} // namespace profile
