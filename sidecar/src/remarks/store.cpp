#include "store.hpp"
#include "source_hash.hpp"
#include "util/logger.hpp"

#include <sqlite3.h>
#include <stdexcept>

namespace perf_lens::remarks {
namespace {

void check(int rc, sqlite3* db, const char* op) {
    if (rc != SQLITE_OK && rc != SQLITE_DONE && rc != SQLITE_ROW) {
        const char* msg = sqlite3_errmsg(db);
        throw std::runtime_error(std::string(op) + ": " + (msg ? msg : "unknown"));
    }
}

} // namespace

RemarkStore::RemarkStore(const std::filesystem::path& db_path) {
    std::filesystem::create_directories(db_path.parent_path());

    const int rc = sqlite3_open(db_path.c_str(), &_db);
    if (rc != SQLITE_OK)
        throw std::runtime_error(
            std::string("Cannot open remarks DB: ") + sqlite3_errmsg(_db));

    // WAL mode for better write throughput alongside reads
    sqlite3_exec(_db, "PRAGMA journal_mode=WAL;",      nullptr, nullptr, nullptr);
    sqlite3_exec(_db, "PRAGMA synchronous=NORMAL;",    nullptr, nullptr, nullptr);
    sqlite3_exec(_db, "PRAGMA cache_size=-8000;",      nullptr, nullptr, nullptr); // 8 MB cache

    initSchema();
    perf_lens::Logger::instance().info("Remarks store: " + db_path.string());
}

RemarkStore::~RemarkStore() {
    if (_db) sqlite3_close(_db);
}

void RemarkStore::initSchema() {
    const char* sql = R"SQL(
        CREATE TABLE IF NOT EXISTS remarks (
            id          INTEGER PRIMARY KEY,
            file        TEXT    NOT NULL,
            line        INTEGER NOT NULL,
            col         INTEGER,
            function    TEXT,
            pass        TEXT,
            name        TEXT,
            type        INTEGER NOT NULL,
            category    INTEGER NOT NULL,
            message     TEXT,
            source_hash TEXT,
            build_id    TEXT,
            ingested_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_remarks_file_line ON remarks (file, line);
        CREATE INDEX IF NOT EXISTS idx_remarks_category  ON remarks (category, type);
        CREATE INDEX IF NOT EXISTS idx_remarks_build     ON remarks (build_id);
    )SQL";

    char* err = nullptr;
    const int rc = sqlite3_exec(_db, sql, nullptr, nullptr, &err);
    if (rc != SQLITE_OK) {
        const std::string msg = err ? err : "unknown";
        sqlite3_free(err);
        throw std::runtime_error("Schema init failed: " + msg);
    }
}

int RemarkStore::insertBulk(const std::vector<OptRemark>& remarks) {
    if (remarks.empty()) return 0;

    static const char* sql = R"SQL(
        INSERT INTO remarks
            (file, line, col, function, pass, name, type, category,
             message, source_hash, build_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
    )SQL";

    sqlite3_exec(_db, "BEGIN", nullptr, nullptr, nullptr);

    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(_db, sql, -1, &stmt, nullptr), _db, "prepare insert");

    int count = 0;
    for (const auto& r : remarks) {
        sqlite3_bind_text(stmt,  1, r.location.file.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int (stmt,  2, r.location.line);
        sqlite3_bind_int (stmt,  3, r.location.column);
        sqlite3_bind_text(stmt,  4, r.function.c_str(),      -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt,  5, r.pass.c_str(),          -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt,  6, r.name.c_str(),          -1, SQLITE_TRANSIENT);
        sqlite3_bind_int (stmt,  7, static_cast<int>(r.type));
        sqlite3_bind_int (stmt,  8, static_cast<int>(r.category));
        sqlite3_bind_text(stmt,  9, r.message.c_str(),       -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 10, r.source_hash.c_str(),   -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt, 11, r.build_id.c_str(),      -1, SQLITE_TRANSIENT);

        if (sqlite3_step(stmt) == SQLITE_DONE) ++count;
        sqlite3_reset(stmt);
        sqlite3_clear_bindings(stmt);
    }

    sqlite3_finalize(stmt);
    sqlite3_exec(_db, "COMMIT", nullptr, nullptr, nullptr);

    perf_lens::Logger::instance().debug(
        "Inserted " + std::to_string(count) + '/' + std::to_string(remarks.size()) + " remarks");
    return count;
}

void RemarkStore::clearBuild(const std::string& build_id) {
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(_db,
        "DELETE FROM remarks WHERE build_id = ?", -1, &stmt, nullptr), _db, "prepare clear");
    sqlite3_bind_text(stmt, 1, build_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

void RemarkStore::checkStale(OptRemark& r) const {
    if (r.source_hash.empty() || r.location.file.empty() || r.location.line <= 0) return;
    const auto current = hashSourceLine(r.location.file, r.location.line);
    r.is_stale = !current.empty() && (current != r.source_hash);
}

std::vector<OptRemark> RemarkStore::getRemarks(const std::string& file, int line) {
    const char* sql = (line > 0)
        ? "SELECT file,line,col,function,pass,name,type,category,message,source_hash,build_id "
          "FROM remarks WHERE file=? AND line=? ORDER BY type ASC"
        : "SELECT file,line,col,function,pass,name,type,category,message,source_hash,build_id "
          "FROM remarks WHERE file=? ORDER BY line ASC, type ASC";

    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(_db, sql, -1, &stmt, nullptr), _db, "prepare getRemarks");
    sqlite3_bind_text(stmt, 1, file.c_str(), -1, SQLITE_TRANSIENT);
    if (line > 0) sqlite3_bind_int(stmt, 2, line);

    auto text = [&](int c) -> std::string {
        const auto* p = reinterpret_cast<const char*>(sqlite3_column_text(stmt, c));
        return p ? p : "";
    };

    std::vector<OptRemark> result;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        OptRemark r;
        r.location.file   = text(0);
        r.location.line   = sqlite3_column_int(stmt, 1);
        r.location.column = sqlite3_column_int(stmt, 2);
        r.function        = text(3);
        r.pass            = text(4);
        r.name            = text(5);
        r.type            = static_cast<RemarkType>(sqlite3_column_int(stmt, 6));
        r.category        = static_cast<Category>  (sqlite3_column_int(stmt, 7));
        r.message         = text(8);
        r.source_hash     = text(9);
        r.build_id        = text(10);
        checkStale(r);
        result.push_back(std::move(r));
    }
    sqlite3_finalize(stmt);
    return result;
}

std::vector<std::pair<Category, int>> RemarkStore::countByCategory(const std::string& file) {
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(_db,
        "SELECT category, COUNT(*) FROM remarks WHERE file=? AND type=1 GROUP BY category",
        -1, &stmt, nullptr), _db, "prepare countByCategory");
    sqlite3_bind_text(stmt, 1, file.c_str(), -1, SQLITE_TRANSIENT);

    std::vector<std::pair<Category, int>> result;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        result.emplace_back(
            static_cast<Category>(sqlite3_column_int(stmt, 0)),
            sqlite3_column_int(stmt, 1));
    }
    sqlite3_finalize(stmt);
    return result;
}

std::vector<std::string> RemarkStore::remarkedFiles() {
    sqlite3_stmt* stmt = nullptr;
    check(sqlite3_prepare_v2(_db,
        "SELECT DISTINCT file FROM remarks ORDER BY file",
        -1, &stmt, nullptr), _db, "prepare remarkedFiles");

    std::vector<std::string> result;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const auto* p = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        if (p) result.emplace_back(p);
    }
    sqlite3_finalize(stmt);
    return result;
}

} // namespace perf_lens::remarks
