#include "server.hpp"
#include "util/logger.hpp"

#include <iostream>
#include <string>

namespace perf_lens {

void RpcServer::register_method(std::string_view name, MethodHandler handler) {
    _handlers.emplace(std::string(name), std::move(handler));
}

void RpcServer::notify(std::string_view method, const json& params) {
    write_line({
        {"jsonrpc", "2.0"},
        {"method",  std::string(method)},
        {"params",  params},
    });
}

void RpcServer::run() {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        try {
            handle_message(json::parse(line));
        } catch (const json::parse_error& e) {
            Logger::instance().warn(std::string("JSON parse error: ") + e.what());
            send_error(json(nullptr), RpcErrorCodes::ParseError, "Parse error");
        }
    }
}

void RpcServer::handle_message(const json& msg) {
    if (!msg.is_object() || msg.value("jsonrpc", std::string{}) != "2.0") {
        send_error(json(nullptr), RpcErrorCodes::InvalidRequest, "Invalid Request");
        return;
    }

    const bool has_id = msg.contains("id");
    const json id     = has_id ? msg["id"] : json(nullptr);

    if (!msg.contains("method") || !msg["method"].is_string()) {
        send_error(id, RpcErrorCodes::InvalidRequest, "Missing or invalid method");
        return;
    }

    const auto method = msg["method"].get<std::string>();
    const auto params = msg.value("params", json::object());

    auto it = _handlers.find(method);
    if (it == _handlers.end()) {
        if (has_id) send_error(id, RpcErrorCodes::MethodNotFound, "Method not found: " + method);
        return;
    }

    try {
        const json result = it->second(params);
        if (has_id) send_response(id, result);
    } catch (const std::exception& e) {
        Logger::instance().error(std::string("Handler threw: ") + e.what());
        if (has_id) send_error(id, RpcErrorCodes::InternalError, e.what());
    }
}

void RpcServer::send_response(const json& id, const json& result) {
    write_line({ {"jsonrpc", "2.0"}, {"id", id}, {"result", result} });
}

void RpcServer::send_error(const json& id, int code, std::string_view message) {
    write_line({
        {"jsonrpc", "2.0"},
        {"id",      id},
        {"error",   {{"code", code}, {"message", std::string(message)}}},
    });
}

void RpcServer::write_line(const json& obj) {
    // stdout is the RPC channel — no logging here, only structured JSON
    std::cout << obj.dump() << '\n' << std::flush;
}

} // namespace perf_lens
