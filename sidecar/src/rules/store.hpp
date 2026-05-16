#pragma once
#include "finding.hpp"
#include <filesystem>
#include <vector>

struct sqlite3;

namespace perf_lens::rules {

class FindingStore {
public:
    explicit FindingStore(const std::filesystem::path& db_path);
    ~FindingStore();

    FindingStore(const FindingStore&)            = delete;
    FindingStore& operator=(const FindingStore&) = delete;

    int  insertBulk(const std::vector<Finding>& findings);
    std::vector<Finding> getFindings(const std::string& file, int line = -1) const;
    std::vector<std::string> affectedFiles() const;
    void clearFile(const std::string& file);
    void clearBuild(const std::string& build_id);

private:
    sqlite3* _db = nullptr;
    void _initSchema();
};

} // namespace perf_lens::rules
