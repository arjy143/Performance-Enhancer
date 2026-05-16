#include "store.hpp"
#include "util/logger.hpp"

#include <sqlite3.h>
#include <stdexcept>

namespace perf_lens::rules {
namespace {

void exec(sqlite3* db, const char* sql) {
    char* err = nullptr;
    if (sqlite3_exec(db, sql, nullptr, nullptr, &err) != SQLITE_OK) {
        std::string msg = err ? err : "unknown";
        sqlite3_free(err);
        throw std::runtime_error("FindingStore SQL error: " + msg);
    }
}

} // namespace

FindingStore::FindingStore(const std::filesystem::path& db_path) {
    std::filesystem::create_directories(db_path.parent_path());
    if (sqlite3_open(db_path.c_str(), &_db) != SQLITE_OK) {
        throw std::runtime_error("FindingStore: cannot open " + db_path.string());
    }
    exec(_db, "PRAGMA journal_mode=WAL;");
    exec(_db, "PRAGMA synchronous=NORMAL;");
    _initSchema();
}

FindingStore::~FindingStore() {
    if (_db) sqlite3_close(_db);
}

void FindingStore::_initSchema() {
    exec(_db, R"(
        CREATE TABLE IF NOT EXISTS findings (
            id         INTEGER PRIMARY KEY,
            file       TEXT    NOT NULL,
            line       INTEGER NOT NULL,
            col        INTEGER NOT NULL DEFAULT 0,
            rule_id    TEXT    NOT NULL,
            title      TEXT    NOT NULL DEFAULT '',
            message    TEXT    NOT NULL DEFAULT '',
            category   INTEGER NOT NULL DEFAULT 9,
            confidence INTEGER NOT NULL DEFAULT 1,
            build_id   TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_findings_file_line
            ON findings(file, line);
        CREATE INDEX IF NOT EXISTS idx_findings_build
            ON findings(build_id);
    )");
}

int FindingStore::insertBulk(const std::vector<Finding>& findings) {
    if (findings.empty()) return 0;

    exec(_db, "BEGIN;");
    sqlite3_stmt* stmt = nullptr;
    const char* sql =
        "INSERT INTO findings(file,line,col,rule_id,title,message,category,confidence,build_id)"
        " VALUES(?,?,?,?,?,?,?,?,?);";
    sqlite3_prepare_v2(_db, sql, -1, &stmt, nullptr);

    int count = 0;
    for (const auto& f : findings) {
        sqlite3_bind_text(stmt,  1, f.file.c_str(),    -1, SQLITE_TRANSIENT);
        sqlite3_bind_int (stmt,  2, f.line);
        sqlite3_bind_int (stmt,  3, f.column);
        sqlite3_bind_text(stmt,  4, f.rule_id.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt,  5, f.title.c_str(),   -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(stmt,  6, f.message.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int (stmt,  7, static_cast<int>(f.category));
        sqlite3_bind_int (stmt,  8, static_cast<int>(f.confidence));
        sqlite3_bind_text(stmt,  9, f.build_id.c_str(),-1, SQLITE_TRANSIENT);
        if (sqlite3_step(stmt) == SQLITE_DONE) ++count;
        sqlite3_reset(stmt);
    }

    sqlite3_finalize(stmt);
    exec(_db, "COMMIT;");
    return count;
}

std::vector<Finding> FindingStore::getFindings(const std::string& file, int line) const {
    const char* sql = (line >= 0)
        ? "SELECT file,line,col,rule_id,title,message,category,confidence,build_id"
          " FROM findings WHERE file=? AND line=? ORDER BY line,col;"
        : "SELECT file,line,col,rule_id,title,message,category,confidence,build_id"
          " FROM findings WHERE file=? ORDER BY line,col;";

    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(_db, sql, -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, file.c_str(), -1, SQLITE_TRANSIENT);
    if (line >= 0) sqlite3_bind_int(stmt, 2, line);

    std::vector<Finding> out;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        Finding f;
        f.file       = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        f.line       = sqlite3_column_int(stmt, 1);
        f.column     = sqlite3_column_int(stmt, 2);
        f.rule_id    = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
        f.title      = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 4));
        f.message    = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 5));
        f.category   = static_cast<FindingCategory>(sqlite3_column_int(stmt, 6));
        f.confidence = static_cast<ConfidenceLevel>(sqlite3_column_int(stmt, 7));
        f.build_id   = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 8));
        out.push_back(std::move(f));
    }
    sqlite3_finalize(stmt);
    return out;
}

std::vector<std::string> FindingStore::affectedFiles() const {
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(_db,
        "SELECT DISTINCT file FROM findings ORDER BY file;", -1, &stmt, nullptr);
    std::vector<std::string> out;
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.emplace_back(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0)));
    sqlite3_finalize(stmt);
    return out;
}

void FindingStore::clearFile(const std::string& file) {
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(_db, "DELETE FROM findings WHERE file=?;", -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, file.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

void FindingStore::clearBuild(const std::string& build_id) {
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(_db, "DELETE FROM findings WHERE build_id=?;", -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, build_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

} // namespace perf_lens::rules
