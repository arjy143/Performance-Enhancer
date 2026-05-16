#include "rpc/server.hpp"
#include "util/logger.hpp"

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

} // namespace

int main(int argc, char* argv[]) {
    const auto workspace = workspace_from_args(argc, argv);

    auto& log = perf_lens::Logger::instance();
    log.init(workspace / ".perf-lens" / "logs");
    log.info("perf-lens-sidecar v0.1.0 starting");
    log.info(std::string("workspace: ") + workspace.string());

    perf_lens::RpcServer server;

    server.register_method("ping", [](const perf_lens::json&) -> perf_lens::json {
        return {{"pong", true}};
    });

    server.register_method("echo", [](const perf_lens::json& params) -> perf_lens::json {
        return {{"message", params.value("message", std::string{})}};
    });

    // Announce readiness before entering the RPC loop
    server.notify("ready", {
        {"version",      "0.1.0"},
        {"pid",          static_cast<int>(::getpid())},
        {"capabilities", perf_lens::json::array()},
    });

    log.info("Entering RPC loop");
    server.run();

    log.info("Sidecar shutting down cleanly");
    return EXIT_SUCCESS;
}
