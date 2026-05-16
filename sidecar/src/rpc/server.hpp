#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <nlohmann/json.hpp>

namespace perf_lens {

using json = nlohmann::json;

struct RpcErrorCodes {
    static constexpr int ParseError     = -32700;
    static constexpr int InvalidRequest = -32600;
    static constexpr int MethodNotFound = -32601;
    static constexpr int InvalidParams  = -32602;
    static constexpr int InternalError  = -32603;
};

using MethodHandler = std::function<json(const json& params)>;

/**
 * Minimal JSON-RPC 2.0 server over stdio.
 *
 * Reads newline-delimited JSON from stdin. Writes responses to stdout.
 * Stderr is used exclusively for logging so it does not corrupt the RPC stream.
 */
class RpcServer {
public:
    void register_method(std::string_view name, MethodHandler handler);

    /** Send a notification to the client (no id, no response expected). */
    void notify(std::string_view method, const json& params = json::object());

    /** Block until stdin is closed. */
    void run();

private:
    void handle_message(const json& msg);
    void send_response(const json& id, const json& result);
    void send_error(const json& id, int code, std::string_view message);
    void write_line(const json& obj);

    std::unordered_map<std::string, MethodHandler> _handlers;
};

} // namespace perf_lens
