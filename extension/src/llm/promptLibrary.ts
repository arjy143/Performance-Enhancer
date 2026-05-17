import type { RemarkContext, FindingContext, HotnessContext, SynthesisContext, RefactorContext, CompletionRequest } from './types';

// Bump these when prompts change — cache keys include the version.
export const PROMPT_VERSIONS = {
  translate_opt_remark:      '1',
  explain_finding:           '1',
  explain_hotness:           '1',
  classify_opt_remark_cause: '1',
  synthesise_top_findings:   '1',
  suggest_novel_refactor:    '1',
} as const;

// ---------------------------------------------------------------------------
// translate_opt_remark
// ---------------------------------------------------------------------------

const TRANSLATE_OPT_REMARK_SYSTEM = `You are a C++ compiler optimisation explainer. Translate compiler optimisation remarks into clear plain English. Explain WHY at the machine level (cache lines, pipeline stalls, vector units) when relevant.

Respond with a JSON object — no markdown, no preamble:
{
  "summary": "<one-sentence plain-English summary>",
  "why": "<2-3 sentences on the underlying machine-level cause>",
  "action": "<what the developer should do>",
  "confidence": "high" | "medium" | "low"
}`;

export function buildTranslateRemarkRequest(ctx: RemarkContext): CompletionRequest {
  const user = `REMARK:
- Pass: ${ctx.pass}
- Name: ${ctx.name}
- Message: ${ctx.message}

CONTEXT:
- Function: ${ctx.func}
- Code near remark:
${ctx.snippet}
- Compiler: ${ctx.compiler}
- Optimisation level: ${ctx.optLevel}

Translate this remark for the developer.`;

  return {
    system: TRANSLATE_OPT_REMARK_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.2,
    maxTokens: 300,
    responseFormat: 'json',
  };
}

// ---------------------------------------------------------------------------
// explain_finding
// ---------------------------------------------------------------------------

const EXPLAIN_FINDING_SYSTEM = `You are a C++ performance expert. Explain static analysis findings in clear language with machine-level reasoning.

Structure your response as four paragraphs:
1. What the rule detected.
2. Why it matters at the machine level.
3. How to fix it (specific to the provided code).
4. Expected impact and caveats.

Do not use markdown headers or bullet lists. Plain prose only. Do not invent measurements.`;

export function buildExplainFindingRequest(ctx: FindingContext): CompletionRequest {
  const optLine = ctx.optRemark
    ? `\nCOMPILER REMARK: ${ctx.optRemark}` : '';
  const hotnessLine = ctx.hotness !== undefined
    ? `\nHOTNESS: ${ctx.hotness.toFixed(1)}% of total runtime` : '';

  const user = `RULE: ${ctx.ruleId}
TITLE: ${ctx.title}

CODE:
\`\`\`cpp
${ctx.snippet}
\`\`\`
${optLine}${hotnessLine}

Explain this finding.`;

  return {
    system: EXPLAIN_FINDING_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    maxTokens: 500,
    responseFormat: 'text',
  };
}

// ---------------------------------------------------------------------------
// explain_hotness
// ---------------------------------------------------------------------------

const EXPLAIN_HOTNESS_SYSTEM = `You are a C++ performance expert. Given a profile showing hot functions and static analysis findings, explain what is happening and why. Be specific: refer to the function names and finding types provided. Do not invent measurements not in the data.

Structure your response as three paragraphs:
1. Where the CPU time is going (top functions and why they dominate).
2. What the static findings indicate about the root cause.
3. Concrete next steps, ordered by expected impact.

Plain prose only. No markdown headers. No bullet lists.`;

export function buildExplainHotnessRequest(ctx: HotnessContext): CompletionRequest {
  const topStr = ctx.topFunctions
    .slice(0, 5)
    .map((f, i) => `  ${i + 1}. ${f.function}: ${f.pct.toFixed(1)}% of ${f.eventType}`)
    .join('\n');

  const findingsStr = ctx.activeFindings.length > 0
    ? '\nSTATIC FINDINGS ON HOT CODE:\n' + ctx.activeFindings
        .slice(0, 8)
        .map(f => `  - [${f.ruleId}] ${f.title} at ${f.file.split('/').pop()}:${f.line}`)
        .join('\n')
    : '';

  const user = `PROFILE: "${ctx.profileLabel}" (${ctx.totalSamples.toLocaleString()} samples)

TOP FUNCTIONS BY CPU TIME:
${topStr}
${findingsStr}

Explain what is happening in this profile and what the developer should investigate first.`;

  return {
    system: EXPLAIN_HOTNESS_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.3,
    maxTokens: 500,
    responseFormat: 'text',
  };
}

// ---------------------------------------------------------------------------
// synthesise_top_findings — rich prompt combining profile + static analysis
// ---------------------------------------------------------------------------

const SYNTHESISE_TOP_FINDINGS_SYSTEM = `You are a C++ performance expert tasked with writing an actionable performance report. You receive profile data (where time is spent) and static analysis findings (what might be causing it). Synthesise them into concrete recommendations.

Respond with a JSON object:
{
  "recommendations": [
    {
      "rank": 1,
      "function": "<function name>",
      "expectedImpact": "<1-sentence impact estimate>",
      "action": "<specific thing to do>",
      "evidence": "<why — profile data + finding>"
    }
  ],
  "summary": "<2-3 sentence overall assessment>"
}

Limit to top 3 recommendations. Do not invent data. Only reference functions and findings you were given.`;

export function buildSynthesiseTopFindingsRequest(ctx: SynthesisContext): CompletionRequest {
  const topStr = ctx.topFunctions
    .slice(0, 8)
    .map((f, i) => `  ${i + 1}. ${f.function}: ${f.pct.toFixed(1)}%`)
    .join('\n');

  const findingsStr = ctx.activeFindings.length > 0
    ? ctx.activeFindings.slice(0, 10)
        .map(f => `  - [${f.ruleId}] ${f.title} at ${f.file.split('/').pop()}:${f.line}`)
        .join('\n')
    : '  (none)';

  const cpuLine = ctx.cpuModel ? `\nCPU: ${ctx.cpuModel}` : '';

  const user = `PROFILE: "${ctx.profileLabel}" (${ctx.totalSamples.toLocaleString()} samples)${cpuLine}

TOP FUNCTIONS:
${topStr}

STATIC FINDINGS:
${findingsStr}

Synthesise the top 3 most impactful recommendations.`;

  return {
    system: SYNTHESISE_TOP_FINDINGS_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.2,
    maxTokens: 600,
    responseFormat: 'json',
  };
}

// ---------------------------------------------------------------------------
// suggest_novel_refactor — frontier-model deep refactor suggestion
// ---------------------------------------------------------------------------

const SUGGEST_NOVEL_REFACTOR_SYSTEM = `You are a senior C++ performance engineer specialising in low-latency and high-throughput systems. You will be given a code snippet with one or more performance findings and asked to propose a concrete, novel refactoring strategy.

Your proposal must go beyond the obvious fix already identified by the static analyser. Consider: data-structure redesign, algorithmic improvement, SIMD/loop restructuring, lock-free concurrency, memory layout changes, template metaprogramming, or compiler-hint annotations.

Respond with plain prose — no markdown headers, no bullet lists. Structure as:
1. Root cause analysis (2-3 sentences: what is actually limiting performance here).
2. Proposed refactoring (detailed, specific to the code shown — include concrete code changes or patterns).
3. Expected impact and measurement strategy (how to verify the improvement).
4. Caveats and risks (what could go wrong or where this advice does not apply).

Do not repeat the findings verbatim. Be specific and concrete. Reference line numbers when relevant.`;

export function buildSuggestNovelRefactorRequest(ctx: RefactorContext): CompletionRequest {
  const findingsStr = ctx.findings.length > 0
    ? '\nOTHER FINDINGS IN THIS REGION:\n' + ctx.findings
        .slice(0, 6)
        .map(f => `  - [${f.ruleId}] ${f.title} at line ${f.line}`)
        .join('\n')
    : '';

  const hotnessLine = ctx.hotness !== undefined
    ? `\nPROFILE HOTNESS: ${ctx.hotness.toFixed(1)}% of total CPU time` : '';

  const user = `FILE: ${ctx.file}:${ctx.line}
PRIMARY FINDING: [${ctx.ruleId}] ${ctx.title}${hotnessLine}${findingsStr}

CODE:
\`\`\`cpp
${ctx.snippet}
\`\`\`

Propose a novel, concrete refactoring strategy for this code.`;

  return {
    system: SUGGEST_NOVEL_REFACTOR_SYSTEM,
    messages: [{ role: 'user', content: user }],
    temperature: 0.5,
    maxTokens: 800,
    responseFormat: 'text',
  };
}
