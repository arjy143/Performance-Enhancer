#pragma once

#include "model.hpp"
#include <string_view>

namespace perf_lens::remarks {

/** Maps (pass, name) → Category using a priority-ordered table. */
Category classify(std::string_view pass, std::string_view name) noexcept;

} // namespace perf_lens::remarks
