#pragma once

#include <filesystem>
#include <fstream>
#include <string_view>

namespace perf_lens {

enum class LogLevel { Trace, Debug, Info, Warn, Error };

/**
 * Simple single-instance logger.
 * Writes to a rotating daily log file under the workspace's .perf-lens/logs/ directory
 * AND to stderr (so VS Code captures output via the output channel).
 */
class Logger {
public:
    static Logger& instance();

    void init(const std::filesystem::path& log_dir);
    void set_level(LogLevel level);

    void log(LogLevel level, std::string_view message);

    void trace(std::string_view msg) { log(LogLevel::Trace, msg); }
    void debug(std::string_view msg) { log(LogLevel::Debug, msg); }
    void info (std::string_view msg) { log(LogLevel::Info,  msg); }
    void warn (std::string_view msg) { log(LogLevel::Warn,  msg); }
    void error(std::string_view msg) { log(LogLevel::Error, msg); }

private:
    Logger() = default;
    LogLevel   _min_level{LogLevel::Info};
    std::ofstream _file;
};

} // namespace perf_lens
