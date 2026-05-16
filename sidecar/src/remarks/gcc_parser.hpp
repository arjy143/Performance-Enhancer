#pragma once

#include "model.hpp"
#include <filesystem>
#include <iosfwd>
#include <vector>

namespace perf_lens::remarks {

/** Parse GCC -fopt-info[-all] text output. */
std::vector<OptRemark> parseGccOptInfo(const std::filesystem::path& path,
                                        std::string_view build_id = "");

std::vector<OptRemark> parseGccOptInfoStream(std::istream& input,
                                              std::string_view build_id = "");

} // namespace perf_lens::remarks
