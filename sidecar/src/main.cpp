#include "rpc/server.hpp"
#include "util/logger.hpp"
#include "remarks/parser.hpp"
#include "remarks/gcc_parser.hpp"
#include "remarks/store.hpp"
#include "shadow_compile.hpp"

#include <cstdlib>
#include <filesystem>
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

} // namespace

int main(int argc, char* argv[]) {
    const auto workspace = workspace_from_args(argc, argv);

    auto& log = perf_lens::Logger::instance();
    log.init(workspace / ".perf-lens" / "logs");
    log.info("perf-lens-sidecar v0.2.0 starting");
    log.info(std::string("workspace: ") + workspace.string());

    perf_lens::remarks::RemarkStore store(workspace / ".perf-lens" / "cache.sqlite");
    perf_lens::ShadowCompiler shadow(workspace);
    perf_lens::RpcServer server;

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
        [&store](const perf_lens::json& params) -> perf_lens::json
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

        const int count = store.insertBulk(remarks);
        return {{"count", count}, {"buildId", build_id}};
    });

    server.register_method("getRemarks",
        [&store](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file = params.value("file", std::string{});
        if (file.empty()) throw std::invalid_argument("file is required");
        const int line = params.value("line", -1);

        const auto remarks = store.getRemarks(file, line);
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& r : remarks) arr.push_back(remarkToJson(r));
        return arr;
    });

    server.register_method("recompileWithRemarks",
        [&shadow, &store](const perf_lens::json& params) -> perf_lens::json
    {
        const auto file = params.value("file", std::string{});
        if (file.empty()) throw std::invalid_argument("file is required");

        const auto result  = shadow.compile(file); // throws on failure
        const auto remarks = perf_lens::remarks::parseClangYaml(result.remarks_file, "shadow");
        const int  count   = store.insertBulk(remarks);

        return {
            {"remarksFile", result.remarks_file.string()},
            {"count",       count},
        };
    });

    server.register_method("getRemarkedFiles",
        [&store](const perf_lens::json&) -> perf_lens::json
    {
        const auto files = store.remarkedFiles();
        perf_lens::json arr = perf_lens::json::array();
        for (const auto& f : files) arr.push_back(f);
        return arr;
    });

    // -----------------------------------------------------------------------

    server.notify("ready", {
        {"version",      "0.2.0"},
        {"pid",          static_cast<int>(::getpid())},
        {"capabilities", perf_lens::json::array({"remarks"})},
    });

    log.info("Entering RPC loop");
    server.run();

    log.info("Sidecar shutting down");
    return EXIT_SUCCESS;
}
