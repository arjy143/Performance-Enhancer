#pragma once
#include "compiler.hpp"
#include <string>

namespace perf_lens::godbolt {

// Parse raw output from `clang++ -S -fverbose-asm -masm=intel -g`.
// Returns cleaned asm text and source mappings extracted from .loc directives.
AssemblyOutput parseAssembly(const std::string& raw_asm);

// Detect widest SIMD register width used in an asm text.
// Returns 1=scalar, 4=xmm(128-bit 4×float), 8=ymm(256-bit), 16=zmm(512-bit).
int detectVectorWidth(const std::string& asm_text);

} // namespace perf_lens::godbolt
