#include "store.hpp"
#include <nlohmann/json.hpp>
#include <sstream>
#include <stdexcept>
#include <istream>
#include <ctime>
#include <chrono>
#include <random>
#include <iomanip>

namespace profile {

using json = nlohmann::json;

// ── helpers ───────────────────────────────────────────────────────────────

static std::string generateId() {
  // Simple UUID-ish: timestamp hex + random hex
  auto now = std::chrono::system_clock::now().time_since_epoch().count();
  std::mt19937_64 rng(static_cast<uint64_t>(now));
  std::ostringstream ss;
  ss << std::hex << std::setfill('0')
     << std::setw(16) << static_cast<uint64_t>(now)
     << std::setw(16) << rng();
  return ss.str();
}

static ProfileMetadata metaFromJson(const json& j) {
  ProfileMetadata m;
  m.id               = j.value("id",              "");
  m.label            = j.value("label",           "");
  m.recorded_at      = j.value("recorded_at",     int64_t(0));
  m.duration_ms      = j.value("duration_ms",     int64_t(0));
  m.binary_path      = j.value("binary_path",     "");
  m.binary_build_id  = j.value("binary_build_id", "");
  m.cpu_model        = j.value("cpu_model",       "");
  m.sampling_freq_hz = j.value("sampling_freq_hz",0);
  m.source_profiler  = j.value("source_profiler", "");
  m.total_samples    = j.value("total_samples",   int64_t(0));
  return m;
}

// ── ProfileStore ──────────────────────────────────────────────────────────

ProfileStore::ProfileStore(const std::string& db_path) {
  int rc = sqlite3_open(db_path.c_str(), &_db);
  if (rc != SQLITE_OK) {
    std::string err = sqlite3_errmsg(_db);
    sqlite3_close(_db);
    _db = nullptr;
    throw std::runtime_error("ProfileStore: cannot open db: " + err);
  }
  _exec("PRAGMA journal_mode=WAL;");
  _exec("PRAGMA foreign_keys=ON;");
  _createSchema();
}

ProfileStore::~ProfileStore() {
  if (_db) sqlite3_close(_db);
}

void ProfileStore::_exec(const char* sql) {
  char* errmsg = nullptr;
  int rc = sqlite3_exec(_db, sql, nullptr, nullptr, &errmsg);
  if (rc != SQLITE_OK) {
    std::string msg(errmsg ? errmsg : "unknown");
    sqlite3_free(errmsg);
    throw std::runtime_error(std::string("ProfileStore SQL error: ") + msg);
  }
}

void ProfileStore::_createSchema() {
  _exec(R"(
    CREATE TABLE IF NOT EXISTS profiles (
      id               TEXT PRIMARY KEY,
      label            TEXT NOT NULL DEFAULT '',
      recorded_at      INTEGER NOT NULL DEFAULT 0,
      duration_ms      INTEGER NOT NULL DEFAULT 0,
      binary_path      TEXT NOT NULL DEFAULT '',
      binary_build_id  TEXT NOT NULL DEFAULT '',
      cpu_model        TEXT NOT NULL DEFAULT '',
      sampling_freq_hz INTEGER NOT NULL DEFAULT 0,
      source_profiler  TEXT NOT NULL DEFAULT '',
      total_samples    INTEGER NOT NULL DEFAULT 0,
      metadata_json    TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS line_hotness (
      profile_id  TEXT    NOT NULL,
      event_type  TEXT    NOT NULL,
      file        TEXT    NOT NULL,
      line        INTEGER NOT NULL,
      self_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, event_type, file, line),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS function_hotness (
      profile_id  TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      function    TEXT NOT NULL,
      file        TEXT NOT NULL DEFAULT '',
      self_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (profile_id, event_type, function),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS source_hashes (
      profile_id TEXT NOT NULL,
      file       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      PRIMARY KEY (profile_id, file),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_line_hotness_profile_event
      ON line_hotness(profile_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_function_hotness_profile_event
      ON function_hotness(profile_id, event_type, self_count DESC);
  )");
}

// ── Profile lifecycle ──────────────────────────────────────────────────────

std::string ProfileStore::createProfile(const ProfileMetadata& meta) {
  std::string id = meta.id.empty() ? generateId() : meta.id;
  int64_t now = static_cast<int64_t>(
      std::chrono::duration_cast<std::chrono::seconds>(
          std::chrono::system_clock::now().time_since_epoch()).count());

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "INSERT OR REPLACE INTO profiles "
    "(id,label,recorded_at,duration_ms,binary_path,binary_build_id,"
    " cpu_model,sampling_freq_hz,source_profiler,total_samples,metadata_json) "
    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    -1, &stmt, nullptr);

  sqlite3_bind_text (stmt, 1,  id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text (stmt, 2,  meta.label.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 3,  meta.recorded_at ? meta.recorded_at : now);
  sqlite3_bind_int64(stmt, 4,  meta.duration_ms);
  sqlite3_bind_text (stmt, 5,  meta.binary_path.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text (stmt, 6,  meta.binary_build_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text (stmt, 7,  meta.cpu_model.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int  (stmt, 8,  meta.sampling_freq_hz);
  sqlite3_bind_text (stmt, 9,  meta.source_profiler.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 10, meta.total_samples);
  sqlite3_bind_text (stmt, 11, meta.metadata_json.c_str(), -1, SQLITE_TRANSIENT);

  sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  return id;
}

void ProfileStore::deleteProfile(const std::string& profile_id) {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db, "DELETE FROM profiles WHERE id=?", -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);
}

std::vector<ProfileMetadata> ProfileStore::listProfiles() {
  std::vector<ProfileMetadata> out;
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT id,label,recorded_at,duration_ms,binary_path,binary_build_id,"
    "       cpu_model,sampling_freq_hz,source_profiler,total_samples,metadata_json "
    "FROM profiles ORDER BY recorded_at DESC",
    -1, &stmt, nullptr);
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    ProfileMetadata m;
    m.id               = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    m.label            = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    m.recorded_at      = sqlite3_column_int64(stmt, 2);
    m.duration_ms      = sqlite3_column_int64(stmt, 3);
    m.binary_path      = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 4));
    m.binary_build_id  = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 5));
    m.cpu_model        = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
    m.sampling_freq_hz = sqlite3_column_int(stmt, 7);
    m.source_profiler  = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 8));
    m.total_samples    = sqlite3_column_int64(stmt, 9);
    m.metadata_json    = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 10));
    out.push_back(m);
  }
  sqlite3_finalize(stmt);
  return out;
}

// ── Ingestion ──────────────────────────────────────────────────────────────

std::string ProfileStore::ingestFromNdjson(std::istream& input,
                                            const std::string& label,
                                            IngestProgressCb cb) {
  std::string profile_id;
  std::vector<ImportedLineRow>     lineRows;
  std::vector<ImportedFunctionRow> funcRows;
  int64_t total_samples = 0;

  std::string line;
  int line_num = 0;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    ++line_num;
    if (cb && (line_num % 10000 == 0)) cb(line_num);

    json j;
    try { j = json::parse(line); }
    catch (...) { continue; }

    std::string type = j.value("type", "");

    if (type == "metadata") {
      ProfileMetadata meta = metaFromJson(j);
      if (meta.id.empty())    meta.id    = generateId();
      if (meta.label.empty()) meta.label = label;
      profile_id = createProfile(meta);
      total_samples = meta.total_samples;

    } else if (type == "line") {
      ImportedLineRow r;
      r.event_type  = j.value("event",      "cycles");
      r.file        = j.value("file",        "");
      r.line        = j.value("line",        0);
      r.self_count  = j.value("self",        uint64_t(0));
      if (!r.file.empty() && r.line > 0 && r.self_count > 0)
        lineRows.push_back(r);

    } else if (type == "function") {
      ImportedFunctionRow r;
      r.event_type  = j.value("event",      "cycles");
      r.function    = j.value("function",    "");
      r.file        = j.value("file",        "");
      r.self_count  = j.value("self",        uint64_t(0));
      if (!r.function.empty() && r.self_count > 0)
        funcRows.push_back(r);
    }
  }

  if (profile_id.empty()) {
    // No metadata line — create a stub profile
    ProfileMetadata meta;
    meta.label = label;
    profile_id = createProfile(meta);
  }

  if (!lineRows.empty())     insertLineRows(profile_id, lineRows);
  if (!funcRows.empty())     insertFunctionRows(profile_id, funcRows);

  // Update total_samples if importers didn't include it in metadata
  if (total_samples == 0 && !lineRows.empty()) {
    // Estimate from line rows for "cycles" event
    for (auto& r : lineRows)
      if (r.event_type == "cycles") total_samples += static_cast<int64_t>(r.self_count);
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(_db,
      "UPDATE profiles SET total_samples=? WHERE id=?", -1, &stmt, nullptr);
    sqlite3_bind_int64(stmt, 1, total_samples);
    sqlite3_bind_text (stmt, 2, profile_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
  }

  return profile_id;
}

void ProfileStore::insertLineRows(const std::string& profile_id,
                                   const std::vector<ImportedLineRow>& rows) {
  _exec("BEGIN;");
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "INSERT OR REPLACE INTO line_hotness(profile_id,event_type,file,line,self_count) "
    "VALUES(?,?,?,?,?)",
    -1, &stmt, nullptr);
  for (auto& r : rows) {
    sqlite3_reset(stmt);
    sqlite3_bind_text (stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 2, r.event_type.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 3, r.file.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int  (stmt, 4, r.line);
    sqlite3_bind_int64(stmt, 5, static_cast<int64_t>(r.self_count));
    sqlite3_step(stmt);
  }
  sqlite3_finalize(stmt);
  _exec("COMMIT;");
}

void ProfileStore::insertFunctionRows(const std::string& profile_id,
                                       const std::vector<ImportedFunctionRow>& rows) {
  _exec("BEGIN;");
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "INSERT OR REPLACE INTO function_hotness(profile_id,event_type,function,file,self_count) "
    "VALUES(?,?,?,?,?)",
    -1, &stmt, nullptr);
  for (auto& r : rows) {
    sqlite3_reset(stmt);
    sqlite3_bind_text (stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 2, r.event_type.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 3, r.function.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text (stmt, 4, r.file.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 5, static_cast<int64_t>(r.self_count));
    sqlite3_step(stmt);
  }
  sqlite3_finalize(stmt);
  _exec("COMMIT;");
}

void ProfileStore::storeSourceHashes(const std::string& profile_id,
                                      const std::vector<SourceFileHash>& hashes) {
  _exec("BEGIN;");
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "INSERT OR REPLACE INTO source_hashes(profile_id,file,hash) VALUES(?,?,?)",
    -1, &stmt, nullptr);
  for (auto& h : hashes) {
    sqlite3_reset(stmt);
    sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, h.file.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, h.hash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
  }
  sqlite3_finalize(stmt);
  _exec("COMMIT;");
}

// ── Hotness queries ────────────────────────────────────────────────────────

uint64_t ProfileStore::_totalEventCount(const std::string& profile_id,
                                         const std::string& event_type) {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT COALESCE(SUM(self_count),0) FROM line_hotness "
    "WHERE profile_id=? AND event_type=?",
    -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, event_type.c_str(), -1, SQLITE_TRANSIENT);
  uint64_t total = 0;
  if (sqlite3_step(stmt) == SQLITE_ROW)
    total = static_cast<uint64_t>(sqlite3_column_int64(stmt, 0));
  sqlite3_finalize(stmt);
  return total;
}

std::optional<LineHotness> ProfileStore::getLineHotness(
    const std::string& profile_id,
    const std::string& file,
    int line,
    const std::string& event_type) {

  uint64_t total = _totalEventCount(profile_id, event_type);
  if (total == 0) return std::nullopt;

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT self_count FROM line_hotness "
    "WHERE profile_id=? AND event_type=? AND file=? AND line=?",
    -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, event_type.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, file.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int (stmt, 4, line);

  std::optional<LineHotness> result;
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    LineHotness h;
    h.file        = file;
    h.line        = line;
    h.event_type  = event_type;
    h.self_count  = static_cast<uint64_t>(sqlite3_column_int64(stmt, 0));
    h.total_count = total;
    h.fraction    = total > 0 ? static_cast<double>(h.self_count) / static_cast<double>(total) : 0.0;
    result = h;
  }
  sqlite3_finalize(stmt);
  return result;
}

std::vector<LineHotness> ProfileStore::getFileHotness(
    const std::string& profile_id,
    const std::string& file,
    const std::string& event_type) {

  uint64_t total = _totalEventCount(profile_id, event_type);
  std::vector<LineHotness> out;
  if (total == 0) return out;

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT line, self_count FROM line_hotness "
    "WHERE profile_id=? AND event_type=? AND file=? "
    "ORDER BY self_count DESC",
    -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, event_type.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, file.c_str(), -1, SQLITE_TRANSIENT);

  while (sqlite3_step(stmt) == SQLITE_ROW) {
    LineHotness h;
    h.file        = file;
    h.line        = sqlite3_column_int(stmt, 0);
    h.event_type  = event_type;
    h.self_count  = static_cast<uint64_t>(sqlite3_column_int64(stmt, 1));
    h.total_count = total;
    h.fraction    = static_cast<double>(h.self_count) / static_cast<double>(total);
    out.push_back(h);
  }
  sqlite3_finalize(stmt);
  return out;
}

std::vector<FunctionHotness> ProfileStore::getTopFunctions(
    const std::string& profile_id,
    int n,
    const std::string& event_type) {

  // Compute total from function_hotness (same event)
  sqlite3_stmt* ts = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT COALESCE(SUM(self_count),0) FROM function_hotness "
    "WHERE profile_id=? AND event_type=?",
    -1, &ts, nullptr);
  sqlite3_bind_text(ts, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(ts, 2, event_type.c_str(), -1, SQLITE_TRANSIENT);
  uint64_t total = 0;
  if (sqlite3_step(ts) == SQLITE_ROW)
    total = static_cast<uint64_t>(sqlite3_column_int64(ts, 0));
  sqlite3_finalize(ts);

  std::vector<FunctionHotness> out;
  if (total == 0) return out;

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT function, self_count FROM function_hotness "
    "WHERE profile_id=? AND event_type=? "
    "ORDER BY self_count DESC LIMIT ?",
    -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, event_type.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int (stmt, 3, n);

  while (sqlite3_step(stmt) == SQLITE_ROW) {
    FunctionHotness h;
    h.function    = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    h.event_type  = event_type;
    h.self_count  = static_cast<uint64_t>(sqlite3_column_int64(stmt, 1));
    h.total_count = total;
    h.fraction    = static_cast<double>(h.self_count) / static_cast<double>(total);
    out.push_back(h);
  }
  sqlite3_finalize(stmt);
  return out;
}

std::map<std::string, std::string> ProfileStore::getSourceHashes(
    const std::string& profile_id) {

  std::map<std::string, std::string> out;
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(_db,
    "SELECT file, hash FROM source_hashes WHERE profile_id=?",
    -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, profile_id.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    std::string file = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    std::string hash = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    out[file] = hash;
  }
  sqlite3_finalize(stmt);
  return out;
}

} // namespace profile
