#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include <map>
#include <optional>

namespace profile {

struct ProfileMetadata {
  std::string id;
  std::string label;
  int64_t     recorded_at     = 0;   // Unix seconds
  int64_t     duration_ms     = 0;
  std::string binary_path;
  std::string binary_build_id;
  std::string cpu_model;
  int         sampling_freq_hz = 0;
  std::string source_profiler;       // "perf", "pprof", etc.
  int64_t     total_samples   = 0;
  std::string metadata_json   = "{}";
};

struct Frame {
  std::string function;
  std::string file;
  int         line         = 0;
  int         column       = 0;
  int         inline_depth = 0;
  std::string module;
  uint64_t    address      = 0;
};

struct Sample {
  std::string          event_type;
  uint64_t             event_count = 1;
  std::vector<Frame>   stack;        // leaf-to-root
};

// ── Pre-aggregated hotness rows (what importers emit and store contains) ──

struct LineHotness {
  std::string file;
  int         line        = 0;
  std::string event_type;
  uint64_t    self_count  = 0;   // samples where this line is the leaf
  uint64_t    total_count = 0;   // total self_count for this event across all lines
  double      fraction    = 0.0; // self_count / total_count
};

struct FunctionHotness {
  std::string function;
  std::string event_type;
  uint64_t    self_count  = 0;
  uint64_t    total_count = 0;
  double      fraction    = 0.0;
};

// What importers write to stdout (NDJSON lines)
struct ImportedLineRow {
  std::string event_type;
  std::string file;
  int         line        = 0;
  uint64_t    self_count  = 0;
};

struct ImportedFunctionRow {
  std::string event_type;
  std::string function;
  std::string file;         // primary definition file if known
  uint64_t    self_count  = 0;
};

// Source file hash for staleness detection
struct SourceFileHash {
  std::string file;
  std::string hash;         // SHA-256 hex or FNV64 hex
};

} // namespace profile
