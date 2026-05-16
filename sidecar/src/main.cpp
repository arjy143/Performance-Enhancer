#include "rpc/server.hpp"
#include "util/logger.hpp"
#include "remarks/parser.hpp"
#include "remarks/gcc_parser.hpp"
#include "remarks/store.hpp"
#include "rules/finding.hpp"
#include "rules/store.hpp"
#include "shadow_compile.hpp"
#include "godbolt/compiler.hpp"
#include "godbolt/diff_engine.hpp"
#include "profile/store.hpp"
#include "rules/packs/profile_driven/profile_rules.hpp"

#ifdef PERF_LENS_HAVE_LLVM
#include "ast/project.hpp"
#include "rules/engine.hpp"
#endif

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string_view>
#include <unistd.h>

namespace {

std::filesystem::path workspace_from_args(int argc, char* argv[]) {
    for (int i = 1; i < argc; ++i) {
        const std::string_view arg{argv[i]};
        constexpr std::string_view prefix{"--workspace="};
        if (arg.starts_with(prefix))
            return std::filesystem::path{arg.substr(prefix.size())};
    }
    return std::filesystem::current_path();
}

perf_lens::json remarkToJson(const perf_lens::remarks::OptRemark& r) {
    return {
        {"type",     static_cast<int>(r.type)},
        {"pass",     r.pass},
        {"name",     r.name},
        {"file",     r.location.file},
        {"line",     r.location.line},
        {"column",   r.location.column},
        {"function", r.function},
        {"message",  r.message},
        {"category", static_cast<int>(r.category)},
        {"isStale",  r.is_stale},
        {"buildId",  r.build_id},
    };
}

perf_lens::json sourceMappingToJson(const perf_lens::godbolt::SourceMapping& m) {
    return {
        {"asmLineStart",  m.asm_line_start},
        {"asmLineEnd",    m.asm_line_end},
        {"sourceLine",    m.source_line},
        {"sourceColumn",  m.source_column},
        {"sourceFile",    m.source_file},
        {"inlineDepth",   m.inline_depth},
    };
}

perf_lens::json assemblyOutputToJson(const perf_lens::godbolt::AssemblyOutput& a) {
    perf_lens::json maps = perf_lens::json::array();
    for (const auto& m : a.source_map) maps.push_back(sourceMappingToJson(m));
    return {
        {"text",           a.text},
        {"sourceMap",      maps},
        {"vectorWidthUsed", a.vector_width_used},
    };
}

perf_lens::json instructionDiffToJson(const perf_lens::godbolt::InstructionDiff& d) {
    std::string kind;
    switch (d.kind) {
        case perf_lens::godbolt::InstructionDiff::Kind::Added:     kind = "added";     break;
        case perf_lens::godbolt::InstructionDiff::Kind::Removed:   kind = "removed";   break;
        case perf_lens::godbolt::InstructionDiff::Kind::Unchanged: kind = "unchanged"; break;
    }
    return {
        {"kind",        kind},
        {"beforeText",  d.before_text},
        {"afterText",   d.after_text},
        {"category",    d.category},
    };
}

perf_lens::json asmDiffToJson(const perf_lens::godbolt::AsmDiff& d) {
    perf_lens::json changes = perf_lens::json::array();
    for (const auto& c : d.changes) changes.push_back(instructionDiffToJson(c));
    return {
        {"changes",               changes},
        {"instructionsBefore",    d.instructions_before},
        {"instructionsAfter",     d.instructions_after},
        {"vectorWidthBefore",     d.vector_width_before},
        {"vectorWidthAfter",      d.vector_width_after},
        {"vectorisationImproved", d.vectorisation_improved},
        {"summary",               d.summary},
    };
}

perf_lens::json profileMetaToJson(const profile::ProfileMetadata& m) {
    return {
        {"id",              m.id},
        {"label",           m.label},
        {"recordedAt",      m.recorded_at},
        {"durationMs",      m.duration_ms},
        {"binaryPath",      m.binary_path},
        {"binaryBuildId",   m.binary_build_id},
        {"cpuModel",        m.cpu_model},
        {"samplingFreqHz",  m.sampling_freq_hz},
        {"sourceProfiler",  m.source_profiler},
        {"totalSamples",    m.total_samples},
    };
}

perf_lens::json lineHotnessToJson(const profile::LineHotness& h) {
    return {
        {"file",       h.file},
        {"line",       h.line},
        {"eventType",  h.event_type},
        {"selfCount",  h.self_count},
        {"totalCount", h.total_count},
        {"fraction",   h.fraction},
    };
}

perf_lens::json functionHotnessToJson(const profile::FunctionHotness& h) {
    return {
        {"function",   h.function},
        {"eventType",  h.event_type},
        {"selfCount",  h.self_count},
        {"totalCount", h.total_count},
        {"fraction",   h.fraction},
    };
}

// Find an importer binary by name alongside the sidecar binary, then in PATH.
std::string findImporter(const std::string& name) {
    // Check beside the sidecar binary (argv[0] dir)
    // For simplicity, search known locations
    const std::vector<std::string> search_dirs = {
        "/usr/local/bin",
        "/usr/bin",
        []() -> std::string { const char* h = std::getenv("HOME"); return h ? h : "/root"; }() + "/.cargo/bin",
    };
    for (const auto& dir : search_dirs) {
        auto candidate = std::filesystem::path{dir} / name;
        if (std::filesystem::exists(candidate)) return candidate.string();
    }
    // Check PATH via `which`
    FILE* fp = ::popen(("which " + name + " 2>/dev/null").c_str(), "r");
    if (fp) {
        char buf[512] = {};
        if (::fgets(buf, sizeof(buf), fp)) {
            std::string result{buf};
            while (!result.empty() && (result.back() == '\n' || result.back() == '\r'))
                result.pop_back();
            ::pclose(fp);
            if (!result.empty()) return result;
        }
        ::pclose(fp);
    }
    return {};
}

perf_lens::json findingToJson(const perf_lens::rules::Finding& f) {
    return {
        {"ruleId",     f.rule_id},
        {"title",      f.title},
        {"message",    f.message},
        {"file",       f.file},
        {"line",       f.line},
        {"column",     f.column},
        {"category",   static_cast<int>(f.category)},
        {"confidence", static_cast<int>(f.confidence)},
        {"buildId",    f.build_id},
    };
}

} // namespace

int main(int argc, char* argv[]) {
    const auto workspace = workspace_from_args(argc, argv);

    auto& log = perf_lens::Logger::instance();
    log.init(workspace / ".perf-lens" / "logs");
    log.info("perf-lens-sidecar v0.5.0 starting");
    log.info(std::string("workspace: ") + workspace.string());

    // Ensure .perf-lens directory exists
    std::filesystem::create_directories(workspace / ".perf-lens");

    perf_lens::remarks::RemarkStore remarkStore(workspace / ".perf-lens" / "cache.sqlite");
    perf_lens::rules::FindingStore  findingStore(workspace / ".perf-lens" / "findings.sqlite");
    profile::ProfileStore           profileStore((workspace / ".perf-lens" / "profiles.sqlite").string());
    perf_lens::ShadowCompiler shadow(workspace);
    perf_lens::godbolt::GodBoltCompiler godBolt(workspace);
    perf_lens::RpcServer server;

#ifdef PERF_LENS_HAVE_LLVM
    std::unique_ptr<perf_lens::ast::AstProject>  astProject;
    std::unique_ptr<perf_lens::rules::RuleEngine> ruleEngine;

    try {
        astProject  = std::make_unique<perf_lens::ast::AstProject>(workspace);
        ruleEngine  = std::make_unique<perf_lens::rules::RuleEngine>();
        log.info("Static analysis rules enabled (" +
                 std::to_string(ruleEngine->ruleIds().size()) + " rules loaded)");
    } catch (const std::exception& e) {
        log.warn(std::string("Static analysis unavailable: ") + e.what());
    }
#endif

    // -----------------------------------------------------------------------
    // Phase 1 methods
    // -----------------------------------------------------------------------

    server.register_method("ping", [](const perf_lens::json&) -> perf_lens::json {
        return {{"pong", true}};
    });

    server.register_method("echo", [](const perf_lens::json& p) -> perf_lens::json {
        return {{"message", p.value("message", std::string{})}};
    });

    // -----------------------------------------------------------------------
    // Phase 2: compiler remarks
    // -----------------------------------------------------------------------

    server.register_method("ingestRemarksFile",
        [&remarkStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto path     = params.value("path",    std::string{});
        const auto build_id = params.value("buildId", std::string{"manual"});
        if (path.empty()) throw std::invalid_argument("path is required");

        const std::string_view sv{path};
        const bool is_yaml = sv.ends_with(".yaml") || sv.ends_with(".yml");

        std::vector<perf_lens::remarks::OptRemark> remarks;
        if (is_yaml)
            remarks = perf_lens::remarks::parseClangYaml(path, build_id);
        else
            remarks = perf_lens::remarks::parseGccOptInfo(path, build_id);

        const int count = remarkStore.insertBulk(remarks);
        return {{"count", count}, {"buildId", build_id}};
    });

    server.register_method("getRemarks",
        [&remarkStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file = params.value("file", std::string{});
        if (file.empty()) throw std::invalid_argument("file is required");
        const int line = params.value("line", -1);

        const auto remarks = remarkStore.getRemarks(file, line);
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& r : remarks) arr.push_back(remarkToJson(r));
        return arr;
    });

    server.register_method("recompileWithRemarks",
        [&shadow, &remarkStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file = params.value("file", std::string{});
        if (file.empty()) throw std::invalid_argument("file is required");

        const auto result  = shadow.compile(file);
        const auto remarks = perf_lens::remarks::parseClangYaml(result.remarks_file, "shadow");
        const int  count   = remarkStore.insertBulk(remarks);

        return {
            {"remarksFile", result.remarks_file.string()},
            {"count",       count},
        };
    });

    server.register_method("getRemarkedFiles",
        [&remarkStore](const perf_lens::json&) -> perf_lens::json
    {
        const auto files = remarkStore.remarkedFiles();
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& f : files) arr.push_back(f);
        return arr;
    });

    // -----------------------------------------------------------------------
    // Phase 3: static analysis
    // -----------------------------------------------------------------------

    server.register_method("analyseFile",
        [&findingStore, &profileStore
#ifdef PERF_LENS_HAVE_LLVM
        , &astProject, &ruleEngine
#endif
        ](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file       = params.value("file",      std::string{});
        const auto build_id   = params.value("buildId",   std::string{"analysis"});
        const auto profile_id = params.value("profileId", std::string{});
        if (file.empty()) throw std::invalid_argument("file is required");

        int count = 0;

#ifdef PERF_LENS_HAVE_LLVM
        if (astProject && ruleEngine) {
            findingStore.clearFile(file);
            const auto findings = ruleEngine->analyseFile(
                file, astProject->database(), build_id);
            findingStore.insertBulk(findings);
            count = static_cast<int>(findings.size());
        }
#endif

        // Append profile-derived findings when a profile is active
        if (!profile_id.empty()) {
            const auto profFindings =
                perf_lens::rules::profile_driven::analyseFileWithProfile(
                    profile_id, file, profileStore);
            if (!profFindings.empty()) {
                findingStore.insertBulk(profFindings);
                count += static_cast<int>(profFindings.size());
            }
        }

        return {{"count", count}, {"buildId", build_id}};
    });

    server.register_method("getFindings",
        [&findingStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file = params.value("file", std::string{});
        if (file.empty()) throw std::invalid_argument("file is required");
        const int line = params.value("line", -1);

        const auto findings = findingStore.getFindings(file, line);
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& f : findings) arr.push_back(findingToJson(f));
        return arr;
    });

    server.register_method("getAnalysedFiles",
        [&findingStore](const perf_lens::json&) -> perf_lens::json
    {
        const auto files = findingStore.affectedFiles();
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& f : files) arr.push_back(f);
        return arr;
    });

    // -----------------------------------------------------------------------
    // Phase 5: Godbolt-Lite
    // -----------------------------------------------------------------------

    server.register_method("compileSnippet",
        [&godBolt](const perf_lens::json& params) -> perf_lens::json
    {
        const auto source   = params.value("source",  std::string{});
        const bool run_mca  = params.value("runMca",  false);
        if (source.empty()) throw std::invalid_argument("source is required");

        std::vector<std::string> flags;
        if (params.contains("flags") && params["flags"].is_array()) {
            for (const auto& f : params["flags"]) {
                if (f.is_string()) flags.push_back(f.get<std::string>());
            }
        }

        const auto result = godBolt.compile(source, flags, run_mca);

        perf_lens::json diags = perf_lens::json::array();
        for (const auto& d : result.diagnostics) {
            diags.push_back({{"line", d.line}, {"column", d.column},
                             {"level", d.level}, {"message", d.message}});
        }

        perf_lens::json out = {
            {"success",     result.success},
            {"assembly",    assemblyOutputToJson(result.assembly)},
            {"diagnostics", diags},
            {"contentHash", result.content_hash},
            {"fromCache",   result.from_cache},
            {"wallTimeMs",  result.wall_time.count()},
            {"stderr",      result.stderr_output},
        };
        if (result.mca) {
            out["mca"] = {
                {"ipc",                result.mca->ipc},
                {"cyclesPerIteration", result.mca->cycles_per_iteration},
                {"bottleneck",         result.mca->bottleneck},
            };
        }
        return out;
    });

    server.register_method("diffAsm",
        [](const perf_lens::json& params) -> perf_lens::json
    {
        const auto before_text = params.value("beforeText", std::string{});
        const auto after_text  = params.value("afterText",  std::string{});
        const int  vw_before   = params.value("vectorWidthBefore", 1);
        const int  vw_after    = params.value("vectorWidthAfter",  1);

        const auto before_instrs = perf_lens::godbolt::extractInstructions(before_text);
        const auto after_instrs  = perf_lens::godbolt::extractInstructions(after_text);
        const auto diff = perf_lens::godbolt::diffInstructions(
            before_instrs, after_instrs, vw_before, vw_after);
        return asmDiffToJson(diff);
    });

    server.register_method("compilerAvailable",
        [&godBolt](const perf_lens::json&) -> perf_lens::json
    {
        return {
            {"available",     godBolt.available()},
            {"compilerPath",  godBolt.compilerPath()},
        };
    });

    // -----------------------------------------------------------------------
    // Phase 6: Profile Integration
    // -----------------------------------------------------------------------

    server.register_method("importProfile",
        [&profileStore, &log](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file  = params.value("file",  std::string{});
        const auto label = params.value("label", std::string{"profile"});
        if (file.empty()) throw std::invalid_argument("file is required");

        // Choose importer based on file extension
        std::string importer_name;
        const auto ext = std::filesystem::path{file}.extension().string();
        if (ext == ".pb" || ext == ".gz" || ext == ".pprof") {
            importer_name = "pprof-importer";
        } else {
            // Default: perf data (perf.data, no extension, .data)
            importer_name = "perf-importer";
        }

        const std::string importer_bin = findImporter(importer_name);
        std::string profile_id;

        if (!importer_bin.empty()) {
            // Spawn importer, read NDJSON from its stdout
            const std::string cmd = importer_bin + " \"" + file + "\" --label \"" + label + "\"";
            log.info("importProfile: running " + cmd);
            FILE* fp = ::popen(cmd.c_str(), "r");
            if (!fp) throw std::runtime_error("failed to spawn importer");

            struct PipeStream : std::streambuf {
                FILE* fp;
                char buf[4096];
                explicit PipeStream(FILE* f) : fp(f) {}
                int underflow() override {
                    size_t n = ::fread(buf, 1, sizeof(buf), fp);
                    if (n == 0) return traits_type::eof();
                    setg(buf, buf, buf + n);
                    return traits_type::to_int_type(buf[0]);
                }
            } psb(fp);
            std::istream pipe_stream(&psb);
            profile_id = profileStore.ingestFromNdjson(pipe_stream, label);
            ::pclose(fp);
        } else {
            // No importer binary — try parsing perf script text directly from file
            log.warn("importProfile: importer '" + importer_name + "' not found in PATH; trying direct ingest");
            std::ifstream fs(file);
            if (!fs.is_open()) throw std::runtime_error("cannot open profile file: " + file);
            profile_id = profileStore.ingestFromNdjson(fs, label);
        }

        const auto profiles = profileStore.listProfiles();
        int64_t total = 0;
        for (const auto& p : profiles) {
            if (p.id == profile_id) { total = p.total_samples; break; }
        }

        return {{"profileId", profile_id}, {"totalSamples", total}};
    });

    server.register_method("listProfiles",
        [&profileStore](const perf_lens::json&) -> perf_lens::json
    {
        const auto profiles = profileStore.listProfiles();
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& p : profiles) arr.push_back(profileMetaToJson(p));
        return arr;
    });

    server.register_method("deleteProfile",
        [&profileStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto id = params.value("profileId", std::string{});
        if (id.empty()) throw std::invalid_argument("profileId is required");
        profileStore.deleteProfile(id);
        return {{"ok", true}};
    });

    server.register_method("getLineHotness",
        [&profileStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto profile_id  = params.value("profileId", std::string{});
        const auto file        = params.value("file",      std::string{});
        const int  line        = params.value("line",      0);
        const auto event_type  = params.value("event",     std::string{"cycles"});
        if (profile_id.empty()) throw std::invalid_argument("profileId is required");
        if (file.empty())       throw std::invalid_argument("file is required");

        const auto h = profileStore.getLineHotness(profile_id, file, line, event_type);
        if (!h.has_value()) return nullptr;
        return lineHotnessToJson(*h);
    });

    server.register_method("getFileHotness",
        [&profileStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto profile_id = params.value("profileId", std::string{});
        const auto file       = params.value("file",      std::string{});
        const auto event_type = params.value("event",     std::string{"cycles"});
        if (profile_id.empty()) throw std::invalid_argument("profileId is required");
        if (file.empty())       throw std::invalid_argument("file is required");

        const auto rows = profileStore.getFileHotness(profile_id, file, event_type);
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& h : rows) arr.push_back(lineHotnessToJson(h));
        return arr;
    });

    server.register_method("getTopFunctions",
        [&profileStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto profile_id = params.value("profileId", std::string{});
        const int  n          = params.value("n",         10);
        const auto event_type = params.value("event",     std::string{"cycles"});
        if (profile_id.empty()) throw std::invalid_argument("profileId is required");

        const auto fns = profileStore.getTopFunctions(profile_id, n, event_type);
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& h : fns) arr.push_back(functionHotnessToJson(h));
        return arr;
    });

    server.register_method("getSourceHashes",
        [&profileStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto profile_id = params.value("profileId", std::string{});
        if (profile_id.empty()) throw std::invalid_argument("profileId is required");
        const auto hashes = profileStore.getSourceHashes(profile_id);
        perf_lens::json obj = perf_lens::json::object();
        for (const auto& [file, hash] : hashes) obj[file] = hash;
        return obj;
    });

    server.register_method("storeSourceHashes",
        [&profileStore](const perf_lens::json& params) -> perf_lens::json
    {
        const auto profile_id = params.value("profileId", std::string{});
        if (profile_id.empty()) throw std::invalid_argument("profileId is required");
        const auto& hashes_obj = params.value("hashes", perf_lens::json::object());
        std::vector<profile::SourceFileHash> hashes;
        for (auto it = hashes_obj.begin(); it != hashes_obj.end(); ++it) {
            if (it.value().is_string())
                hashes.push_back({it.key(), it.value().get<std::string>()});
        }
        profileStore.storeSourceHashes(profile_id, hashes);
        return {{"ok", true}};
    });

    // -----------------------------------------------------------------------

    perf_lens::json capabilities = perf_lens::json::array({"remarks", "godBoltLite", "profileIntegration"});
#ifdef PERF_LENS_HAVE_LLVM
    if (ruleEngine) capabilities.push_back("staticAnalysis");
#endif

    server.notify("ready", {
        {"version",      "0.5.0"},
        {"pid",          static_cast<int>(::getpid())},
        {"capabilities", capabilities},
    });

    log.info("Entering RPC loop");
    server.run();

    log.info("Sidecar shutting down");
    return EXIT_SUCCESS;
}
