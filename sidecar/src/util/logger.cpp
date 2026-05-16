#include "logger.hpp"

#include <array>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>

namespace perf_lens {

Logger& Logger::instance() {
    static Logger inst;
    return inst;
}

void Logger::init(const std::filesystem::path& log_dir) {
    std::filesystem::create_directories(log_dir);

    auto now = std::chrono::system_clock::now();
    auto t   = std::chrono::system_clock::to_time_t(now);

    std::ostringstream fname;
    fname << "sidecar-" << std::put_time(std::gmtime(&t), "%Y-%m-%d") << ".log";

    _file.open(log_dir / fname.str(), std::ios::app);
}

void Logger::set_level(LogLevel level) { _min_level = level; }

void Logger::log(LogLevel level, std::string_view message) {
    if (level < _min_level) return;

    static constexpr std::array names{"TRACE", "DEBUG", "INFO", "WARN", "ERROR"};
    const auto idx = static_cast<std::size_t>(level);

    auto now = std::chrono::system_clock::now();
    auto t   = std::chrono::system_clock::to_time_t(now);

    std::ostringstream line;
    line << std::put_time(std::gmtime(&t), "%Y-%m-%dT%H:%M:%SZ")
         << " [" << names.at(idx) << "] " << message << '\n';

    const auto& s = line.str();
    if (_file.is_open()) { _file << s; _file.flush(); }
    // stderr is captured by the extension's output channel
    std::cerr << s << std::flush;
}

} // namespace perf_lens
