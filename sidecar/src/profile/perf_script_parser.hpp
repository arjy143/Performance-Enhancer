#pragma once
#include <istream>
#include <string>
#include "store.hpp"

namespace profile {

// Parse `perf script` text output from `is` and ingest it into `store`.
// Returns the new profile ID on success.
// Throws std::runtime_error on fatal failure.
std::string ingestPerfScript(std::istream& is,
                             ProfileStore&  store,
                             const std::string& label);

// Returns true if the stream looks like `perf script` text output.
// Always rewinds is back to position 0 before returning.
bool looksLikePerfScript(std::istream& is);

} // namespace profile
