#include "gcc_parser.hpp"
#include "classifier.hpp"
#include "source_hash.hpp"
#include "util/logger.hpp"

#include <fstream>
#include <regex>

namespace perf_lens::remarks {
namespace {

// /path/to/file.cpp:47:5: optimized: loop vectorized using 32 byte vectors
// /path/to/file.cpp:81:5: missed: not vectorized: complicated access pattern.
// /path/to/file.cpp:23:1: note: basic block part vectorized
const std::regex LINE_RE{R"(^(.+?):(\d+):(\d+): (optimized|missed|note): (.+)$)"};

RemarkType typeFromGccWord(std::string_view word) noexcept {
    if (word == "optimized") return RemarkType::Passed;
    if (word == "missed")    return RemarkType::Missed;
    return RemarkType::Analysis;
}

std::string guessPass(std::string_view message) {
    if (message.find("vectorize") != std::string_view::npos ||
        message.find("vectorized") != std::string_view::npos)
        return "loop-vectorize";
    if (message.find("unrolled") != std::string_view::npos)
        return "loop-unroll";
    if (message.find("inline") != std::string_view::npos ||
        message.find("inlined") != std::string_view::npos)
        return "inline";
    if (message.find("hoisted") != std::string_view::npos)
        return "licm";
    return "gcc";
}

} // namespace

std::vector<OptRemark> parseGccOptInfoStream(std::istream& input,
                                              std::string_view build_id) {
    std::vector<OptRemark> remarks;
    std::string line;
    std::smatch m;

    while (std::getline(input, line)) {
        if (!std::regex_match(line, m, LINE_RE)) continue;

        OptRemark r;
        r.location.file   = m[1].str();
        r.location.line   = std::stoi(m[2].str());
        r.location.column = std::stoi(m[3].str());
        r.type            = typeFromGccWord(m[4].str());
        r.message         = m[5].str();
        r.pass            = guessPass(r.message);
        r.name            = "gcc";
        r.build_id        = std::string(build_id);
        r.category        = classify(r.pass, r.name);
        r.source_hash     = hashSourceLine(r.location.file, r.location.line);
        remarks.push_back(std::move(r));
    }
    return remarks;
}

std::vector<OptRemark> parseGccOptInfo(const std::filesystem::path& path,
                                        std::string_view build_id) {
    std::ifstream f(path);
    if (!f.is_open()) {
        perf_lens::Logger::instance().warn(
            "Cannot open GCC opt-info file: " + path.string());
        return {};
    }
    return parseGccOptInfoStream(f, build_id);
}

} // namespace perf_lens::remarks
