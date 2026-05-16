import type { RemarkContext, FindingContext, CompletionRequest } from './types';

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
// explain_hotness  (stub — profile data arrives in Phase 6)
// ---------------------------------------------------------------------------

const EXPLAIN_HOTNESS_SYSTEM = `You are a C++ performance expert. Explain why a function or code region is hot based on profile data.`;

export function buildExplainHotnessRequest(funcName: string, hotnessPct: number): CompletionRequest {
  return {
    system: EXPLAIN_HOTNESS_SYSTEM,
    messages: [{
      role: 'user',
      content: `Function "${funcName}" consumed ${hotnessPct.toFixed(1)}% of total runtime. Explain common reasons and suggest investigation steps.`,
    }],
    temperature: 0.3,
    maxTokens: 300,
    responseFormat: 'text',
  };
}
