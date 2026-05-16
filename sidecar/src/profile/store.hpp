#pragma once
#include "model.hpp"
#include <sqlite3.h>
#include <memory>
#include <string>
#include <vector>
#include <map>
#include <functional>

namespace profile {

// Callback type used by ingestFromNdjson to report progress.
using IngestProgressCb = std::function<void(int lines_processed)>;

class ProfileStore {
public:
  // Opens (or creates) the SQLite database at db_path.
  // Pass ":memory:" for an in-memory database (tests).
  explicit ProfileStore(const std::string& db_path);
  ~ProfileStore();

  ProfileStore(const ProfileStore&)            = delete;
  ProfileStore& operator=(const ProfileStore&) = delete;

  // ── Profile lifecycle ──────────────────────────────────────────────────

  // Create a profile row; returns the assigned profile_id.
  std::string createProfile(const ProfileMetadata& meta);

  // Delete a profile and all its associated rows (CASCADE).
  void deleteProfile(const std::string& profile_id);

  // List all profiles ordered by recorded_at DESC.
  std::vector<ProfileMetadata> listProfiles();

  // ── Ingestion ──────────────────────────────────────────────────────────

  // Read NDJSON from `input` (already opened stream / pipe).
  // Line format produced by importers:
  //   {"type":"metadata",...}
  //   {"type":"line",   "event":"cycles","file":"...","line":42,"self":123}
  //   {"type":"function","event":"cycles","function":"f","file":"...","self":456}
  // Returns the profile_id that was created.
  std::string ingestFromNdjson(std::istream& input,
                               const std::string& label,
                               IngestProgressCb cb = {});

  // Lower-level: bulk-insert pre-aggregated rows for an existing profile.
  void insertLineRows(const std::string& profile_id,
                      const std::vector<ImportedLineRow>& rows);
  void insertFunctionRows(const std::string& profile_id,
                          const std::vector<ImportedFunctionRow>& rows);

  // Store source file hashes for staleness detection.
  void storeSourceHashes(const std::string& profile_id,
                          const std::vector<SourceFileHash>& hashes);

  // ── Hotness queries ────────────────────────────────────────────────────

  std::optional<LineHotness> getLineHotness(const std::string& profile_id,
                                             const std::string& file,
                                             int line,
                                             const std::string& event_type = "cycles");

  // All lines in a file, sorted by self_count DESC.
  std::vector<LineHotness> getFileHotness(const std::string& profile_id,
                                           const std::string& file,
                                           const std::string& event_type = "cycles");

  std::vector<FunctionHotness> getTopFunctions(const std::string& profile_id,
                                                int n,
                                                const std::string& event_type = "cycles");

  // Staleness: returns map of file → stored_hash.
  std::map<std::string, std::string> getSourceHashes(const std::string& profile_id);

private:
  sqlite3* _db = nullptr;

  void _exec(const char* sql);
  void _createSchema();
  uint64_t _totalEventCount(const std::string& profile_id,
                             const std::string& event_type);
};

} // namespace profile
