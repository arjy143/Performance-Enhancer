#include <gtest/gtest.h>
#include "godbolt/asm_parser.hpp"
#include "godbolt/diff_engine.hpp"
#include "godbolt/compile_cache.hpp"
#include "godbolt/compiler.hpp"

using namespace perf_lens::godbolt;

// ---------------------------------------------------------------------------
// Asm parser tests — use hand-crafted fixture strings (no real compiler needed)
// ---------------------------------------------------------------------------

static const char* SCALAR_ASM = R"(
    .file   "test.cpp"
    .intel_syntax noprefix
    .text
    .globl  _Z3fooi
_Z3fooi:
.LFB0:
    .cfi_startproc
    .loc 1 3 0
    push    rbp
    mov     rbp, rsp
    mov     DWORD PTR [rbp-4], edi
    .loc 1 4 0
    mov     eax, DWORD PTR [rbp-4]
    imul    eax, eax
    .loc 1 5 0
    pop     rbp
    ret
    .cfi_endproc
    .size   _Z3fooi, .-_Z3fooi
)";

static const char* VECTOR_ASM = R"(
    .text
    .globl  _Z3barPfi
_Z3barPfi:
    .loc 1 10 0
    vmovaps ymm0, YMMWORD PTR [rdi]
    vmulps  ymm0, ymm0, ymm1
    vaddps  ymm0, ymm0, ymm2
    vmovaps YMMWORD PTR [rdi], ymm0
    ret
)";

TEST(AsmParser, ExtractsInstructions) {
    const auto out = parseAssembly(SCALAR_ASM);
    // Should contain the actual instructions, not directives
    EXPECT_NE(out.text.find("push"), std::string::npos);
    EXPECT_NE(out.text.find("imul"), std::string::npos);
    EXPECT_NE(out.text.find("ret"),  std::string::npos);
    // Should have stripped .cfi_ and .size etc.
    EXPECT_EQ(out.text.find(".cfi_"), std::string::npos);
    EXPECT_EQ(out.text.find(".size"), std::string::npos);
}

TEST(AsmParser, BuildsSourceMap) {
    const auto out = parseAssembly(SCALAR_ASM);
    ASSERT_FALSE(out.source_map.empty());
    // .loc 1 3 0 should produce a mapping for source line 3
    bool found3 = false;
    for (const auto& m : out.source_map) {
        if (m.source_line == 3) { found3 = true; break; }
    }
    EXPECT_TRUE(found3) << "Expected source mapping for line 3";
}

TEST(AsmParser, DetectsScalarVectorWidth) {
    const auto out = parseAssembly(SCALAR_ASM);
    EXPECT_EQ(out.vector_width_used, 1);
}

TEST(AsmParser, DetectsAvxVectorWidth) {
    const auto out = parseAssembly(VECTOR_ASM);
    EXPECT_EQ(out.vector_width_used, 8);  // ymm = AVX = 8×float
}

TEST(AsmParser, DetectVectorWidthHelper) {
    EXPECT_EQ(detectVectorWidth("vmovaps ymm0, [rax]"), 8);
    EXPECT_EQ(detectVectorWidth("vmovaps zmm0, [rax]"), 16);
    EXPECT_EQ(detectVectorWidth("vmovss  xmm0, [rax]"), 4);
    EXPECT_EQ(detectVectorWidth("mov     eax,  [rax]"), 1);
}

// ---------------------------------------------------------------------------
// Diff engine tests
// ---------------------------------------------------------------------------

TEST(DiffEngine, ExtractInstructions) {
    const std::string asm_text =
        "_Z3fooi:\n"
        "    push    rbp\n"
        "    mov     rbp, rsp\n"
        ".L1:\n"
        "    .size _Z3fooi, .-_Z3fooi\n"
        "    ret\n";
    const auto instrs = extractInstructions(asm_text);
    EXPECT_EQ(instrs.size(), 3u);  // push, mov, ret  (label and .size skipped)
}

TEST(DiffEngine, NormaliseInstruction) {
    // xmm0 and xmm3 normalise to the same string
    EXPECT_EQ(normaliseInstruction("    vmovss xmm0, [rdi]"),
              normaliseInstruction("    vmovss xmm3, [rdi]"));
    // ymm and xmm stay distinct after normalisation
    EXPECT_NE(normaliseInstruction("vmovaps ymm0, [rdi]"),
              normaliseInstruction("vmovss  xmm0, [rdi]"));
}

TEST(DiffEngine, DiffIdenticalInstructions) {
    const std::vector<std::string> instrs = {"    mov eax, 1", "    ret"};
    const auto d = diffInstructions(instrs, instrs, 1, 1);
    EXPECT_EQ(d.instructions_before, 2);
    EXPECT_EQ(d.instructions_after,  2);
    EXPECT_FALSE(d.vectorisation_improved);
    // All unchanged
    for (const auto& c : d.changes)
        EXPECT_EQ(c.kind, InstructionDiff::Kind::Unchanged);
}

TEST(DiffEngine, DiffDetectsVectorisationImprovement) {
    const std::vector<std::string> scalar = {
        "    vmovss xmm0, [rdi]", "    vaddss xmm0, xmm0, xmm1", "    vmovss [rdi], xmm0",
    };
    const std::vector<std::string> vector = {
        "    vmovaps ymm0, [rdi]", "    vaddps ymm0, ymm0, ymm1", "    vmovaps [rdi], ymm0",
    };
    const auto d = diffInstructions(scalar, vector, 1, 8);
    EXPECT_TRUE(d.vectorisation_improved);
    EXPECT_EQ(d.vector_width_before, 1);
    EXPECT_EQ(d.vector_width_after,  8);
    EXPECT_FALSE(d.summary.empty());
}

TEST(DiffEngine, SummaryContainsVectorWidth) {
    const std::vector<std::string> before = {"    vmovss xmm0, [rdi]"};
    const std::vector<std::string> after  = {"    vmovaps ymm0, [rdi]"};
    const auto d = diffInstructions(before, after, 1, 8);
    EXPECT_NE(d.summary.find("1x"), std::string::npos);
    EXPECT_NE(d.summary.find("8x"), std::string::npos);
}

// ---------------------------------------------------------------------------
// CompileCache tests
// ---------------------------------------------------------------------------

TEST(CompileCache, MissReturnsNullopt) {
    CompileCache cache;
    EXPECT_FALSE(cache.get("nonexistent").has_value());
}

TEST(CompileCache, StoreAndRetrieve) {
    CompileCache cache;
    CompileResult r;
    r.success = true;
    r.content_hash = "abc";
    cache.set("abc", r);
    const auto got = cache.get("abc");
    ASSERT_TRUE(got.has_value());
    EXPECT_TRUE(got->success);
    EXPECT_TRUE(got->from_cache);
}

TEST(CompileCache, ClearRemovesEntries) {
    CompileCache cache;
    CompileResult r;
    r.success = true;
    cache.set("key1", r);
    cache.clear();
    EXPECT_FALSE(cache.get("key1").has_value());
}

TEST(CompileCache, EvictsOldestWhenFull) {
    CompileCache cache;
    CompileResult r;
    r.success = true;
    // Fill beyond capacity
    for (int i = 0; i <= CompileCache::MAX_ENTRIES; ++i) {
        cache.set(std::to_string(i), r);
    }
    // "0" should have been evicted
    EXPECT_FALSE(cache.get("0").has_value());
    // Most recent should still be present
    EXPECT_TRUE(cache.get(std::to_string(CompileCache::MAX_ENTRIES)).has_value());
}
