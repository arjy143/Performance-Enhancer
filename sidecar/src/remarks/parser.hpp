#pragma once

#include "model.hpp"
#include <filesystem>
#include <iosfwd>
#include <vector>

namespace perf_lens::remarks {

/** Parse a Clang YAML opt-record file (produced by -fsave-optimization-record=yaml). */
std::vector<OptRemark> parseClangYaml(const std::filesystem::path& path,
                                       std::string_view build_id = "");

/** Parse from an already-open stream (for testing). */
std::vector<OptRemark> parseClangYamlStream(std::istream& input,
                                             std::string_view build_id = "");

} // namespace perf_lens::remarks
