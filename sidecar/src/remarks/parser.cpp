#include "parser.hpp"
#include "classifier.hpp"
#include "source_hash.hpp"
#include "util/logger.hpp"

#include <yaml-cpp/yaml.h>
#include <fstream>

namespace perf_lens::remarks {
namespace {

RemarkType typeFromTag(const std::string& tag) noexcept {
    if (tag == "!Passed")   return RemarkType::Passed;
    if (tag == "!Missed")   return RemarkType::Missed;
    if (tag == "!Analysis") return RemarkType::Analysis;
    return RemarkType::Analysis;
}

// Compose the Args sequence into a single human-readable string.
// Each arg is a map; we concatenate values, skipping DebugLoc sub-objects.
std::string composeMessage(const YAML::Node& args) {
    if (!args || !args.IsSequence()) return {};
    std::string result;
    for (const auto& arg : args) {
        if (!arg.IsMap()) continue;
        for (const auto& kv : arg) {
            const auto key = kv.first.as<std::string>(std::string{});
            if (key == "DebugLoc") continue;
            if (kv.second.IsScalar()) {
                try { result += kv.second.as<std::string>(); } catch (...) {}
            }
        }
    }
    return result;
}

std::vector<RemarkArg> parseArgs(const YAML::Node& args) {
    std::vector<RemarkArg> result;
    if (!args || !args.IsSequence()) return result;
    for (const auto& arg : args) {
        if (!arg.IsMap()) continue;
        for (const auto& kv : arg) {
            const auto key = kv.first.as<std::string>(std::string{});
            if (key == "DebugLoc") continue;
            if (kv.second.IsScalar()) {
                try {
                    result.push_back({key, kv.second.as<std::string>()});
                } catch (...) {
                    result.push_back({key, {}});
                }
            }
        }
    }
    return result;
}

OptRemark parseDocument(const YAML::Node& doc, std::string_view build_id) {
    OptRemark r;
    r.type     = typeFromTag(doc.Tag());
    r.pass     = doc["Pass"].as<std::string>(std::string{});
    r.name     = doc["Name"].as<std::string>(std::string{});
    r.function = doc["Function"].as<std::string>(std::string{});
    r.build_id = std::string(build_id);

    if (const auto& loc = doc["DebugLoc"]; loc && loc.IsMap()) {
        r.location.file   = loc["File"].as<std::string>(std::string{});
        r.location.line   = loc["Line"].as<int>(0);
        r.location.column = loc["Column"].as<int>(0);
    }

    if (const auto& args = doc["Args"]; args) {
        r.message = composeMessage(args);
        r.args    = parseArgs(args);
    }

    r.category    = classify(r.pass, r.name);
    r.source_hash = hashSourceLine(r.location.file, r.location.line);
    return r;
}

} // namespace

std::vector<OptRemark> parseClangYamlStream(std::istream& input,
                                             std::string_view build_id) {
    std::vector<OptRemark> remarks;
    try {
        // yaml-cpp LoadAll reads all YAML documents from the stream
        const auto docs = YAML::LoadAll(input);
        remarks.reserve(docs.size());
        for (const auto& doc : docs) {
            if (!doc || !doc.IsMap()) continue;
            try {
                remarks.push_back(parseDocument(doc, build_id));
            } catch (const std::exception& e) {
                perf_lens::Logger::instance().warn(
                    std::string("Skipping malformed remark document: ") + e.what());
            }
        }
    } catch (const YAML::Exception& e) {
        perf_lens::Logger::instance().error(
            std::string("YAML parse error: ") + e.what());
    }
    return remarks;
}

std::vector<OptRemark> parseClangYaml(const std::filesystem::path& path,
                                       std::string_view build_id) {
    std::ifstream f(path);
    if (!f.is_open()) {
        perf_lens::Logger::instance().warn(
            "Cannot open opt-records file: " + path.string());
        return {};
    }
    return parseClangYamlStream(f, build_id);
}

} // namespace perf_lens::remarks
