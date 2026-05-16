#pragma once

#include "model.hpp"
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

// Forward-declare sqlite3 to avoid leaking the header
struct sqlite3;
struct sqlite3_stmt;

namespace perf_lens::remarks {

/**
 * SQLite-backed remark store.
 *
 * Single-threaded: all calls must be serialised by the caller.
 * The sidecar routes writes through a dedicated DB thread.
 *
 * Performance targets (from 04-analysis-sidecar.md):
 *   - Ingest 100k remarks/min via bulk transactions
 *   - Query (file, line) in <1ms via index
 */
class RemarkStore {
public:
    explicit RemarkStore(const std::filesystem::path& db_path);
    ~RemarkStore();

    RemarkStore(const RemarkStore&)            = delete;
    RemarkStore& operator=(const RemarkStore&) = delete;

    /** Insert remarks in a single transaction. Returns number inserted. */
    int insertBulk(const std::vector<OptRemark>& remarks);

    /** Delete all remarks for a build_id (call before re-ingesting). */
    void clearBuild(const std::string& build_id);

    /** Get remarks for a file. Pass line > 0 to restrict to one line. */
    std::vector<OptRemark> getRemarks(const std::string& file, int line = -1);

    /** Count missed remarks per category for a file (for panel summary). */
    std::vector<std::pair<Category, int>> countByCategory(const std::string& file);

    /** All distinct files that have at least one remark. */
    std::vector<std::string> remarkedFiles();

private:
    void initSchema();
    void checkStale(OptRemark& r) const;

    sqlite3* _db{nullptr};
};

} // namespace perf_lens::remarks
