#pragma once
#include "compiler.hpp"
#include <string>
#include <vector>

namespace perf_lens::godbolt {

// Extract instruction lines (non-label, non-directive) from asm text.
std::vector<std::string> extractInstructions(const std::string& asm_text);

// Normalise an instruction for comparison: lowercase, collapse whitespace,
// strip register numbering (xmm0→xmm, ymm3→ymm) so structural changes
// (scalar→vector) show up without noise from register allocation differences.
std::string normaliseInstruction(const std::string& instr);

// Compute LCS-based diff of two instruction sequences.
// Categories each changed line as vectorised/eliminated/other.
AsmDiff diffInstructions(const std::vector<std::string>& before,
                          const std::vector<std::string>& after,
                          int vector_width_before,
                          int vector_width_after);

} // namespace perf_lens::godbolt
