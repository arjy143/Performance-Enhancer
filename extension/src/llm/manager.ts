import * as fs from 'fs';
import * as vscode from 'vscode';
import type { LLMProvider, ProviderConfig, RouterContext, StreamChunk, TaskResult } from './types';
import type { OptRemark } from '../sidecar/protocol';
import type { Finding } from '../sidecar/protocol';
import { LLMCache } from './cache';
import { TaskRouter } from './router';
import { executeTask } from './executor';
import { OllamaProvider } from './providers/ollama';
import { OpenAICompatProvider } from './providers/openaiCompat';
import { AnthropicProvider } from './providers/anthropic';
import {
  buildTranslateRemarkRequest,
  buildExplainFindingRequest,
  buildExplainHotnessRequest,
  buildSynthesiseTopFindingsRequest,
} from './promptLibrary';
import type { RemarkContext, FindingContext, HotnessContext, SynthesisContext } from './types';

const MODEL_CLASS_MAP = {
  small: 'small' as const,
  mid: 'mid' as const,
  frontier: 'frontier' as const,
};

function classifyModel(model: string): 'small' | 'mid' | 'frontier' {
  const lower = model.toLowerCase();
  if (lower.includes('opus') || lower.includes('gpt-4') || lower.includes('o1')) return 'frontier';
  if (lower.includes('sonnet') || lower.includes('3.5') || lower.includes('haiku')) return 'mid';
  return 'small';
}

export class LLMManager implements vscode.Disposable {
  private readonly _providers: LLMProvider[] = [];
  private readonly _cache: LLMCache;
  private readonly _router: TaskRouter;

  private _sessionSpendUSD = 0;
  private _budgetWarnFired = false;
  private readonly _onBudgetWarning = new vscode.EventEmitter<number>();
  readonly onBudgetWarning = this._onBudgetWarning.event;

  constructor(storageUri: vscode.Uri) {
    const storageDir = storageUri.fsPath;
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
    this._cache = new LLMCache(storageDir);
    this._router = new TaskRouter(this._providers);
  }

  get hasProviders(): boolean {
    return this._providers.length > 0;
  }

  addProvider(cfg: ProviderConfig): void {
    const provider = this._createProvider(cfg);
    if (provider) this._providers.push(provider);
  }

  get hasHealthyProvider(): boolean {
    return this._providers.some(p => p.health === 'healthy' || p.health === 'degraded');
  }

  async probeAll(): Promise<void> {
    await Promise.all(this._providers.map(p => p.healthCheck()));
  }

  async translateRemark(
    remark: OptRemark,
    snippet: string,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    const ctx: RemarkContext = {
      pass: remark.pass,
      name: remark.name,
      message: remark.message,
      func: remark.function,
      snippet,
      compiler: 'clang',
      optLevel: '-O2',
    };
    const req = buildTranslateRemarkRequest(ctx);
    const routerCtx = this._routerCtx();
    const result = await executeTask('translate_opt_remark', req, this._router, this._cache, signal, routerCtx);
    return this._withSpendTracking(result, routerCtx);
  }

  async explainFinding(
    finding: Finding,
    snippet: string,
    signal: AbortSignal,
  ): Promise<TaskResult> {
    const ctx: FindingContext = {
      ruleId: finding.ruleId,
      title: finding.title,
      snippet,
    };
    const req = buildExplainFindingRequest(ctx);
    const routerCtx = this._routerCtx();
    const result = await executeTask('explain_finding', req, this._router, this._cache, signal, routerCtx);
    return this._withSpendTracking(result, routerCtx);
  }

  async explainHotness(ctx: HotnessContext, signal: AbortSignal): Promise<TaskResult> {
    const req = buildExplainHotnessRequest(ctx);
    const routerCtx = this._routerCtx();
    const result = await executeTask('explain_hotness', req, this._router, this._cache, signal, routerCtx);
    return this._withSpendTracking(result, routerCtx);
  }

  async synthesiseTopFindings(ctx: SynthesisContext, signal: AbortSignal): Promise<TaskResult> {
    const req = buildSynthesiseTopFindingsRequest(ctx);
    const routerCtx = this._routerCtx();
    const result = await executeTask('synthesise_top_findings', req, this._router, this._cache, signal, routerCtx);
    return this._withSpendTracking(result, routerCtx);
  }

  clearCache(): void {
    this._cache.clear();
    void this._cache.persist();
  }

  get sessionSpendUSD(): number { return this._sessionSpendUSD; }

  dispose(): void {
    void this._cache.persist();
    this._onBudgetWarning.dispose();
  }

  // Called after each successful remote call. Estimates cost from output
  // character count (~4 chars/token, $0.002/1k tokens as a conservative average).
  private _recordSpend(outputChars: number): void {
    const cfg = vscode.workspace.getConfiguration('perfLens');
    const budget = cfg.get<number>('llm.budgetUSD');
    if (!budget) return;

    const estimatedTokens = outputChars / 4;
    this._sessionSpendUSD += estimatedTokens * 0.000002;

    if (!this._budgetWarnFired) {
      const warnAt = cfg.get<number>('llm.warnAtPercent', 80);
      const pct = (this._sessionSpendUSD / budget) * 100;
      if (pct >= warnAt) {
        this._budgetWarnFired = true;
        this._onBudgetWarning.fire(pct);
      }
    }
  }

  // Wraps a TaskResult stream to count output chars and record spend.
  private _withSpendTracking(result: TaskResult, ctx: ReturnType<typeof this._routerCtx>): TaskResult {
    if (result.type !== 'success' || !result.stream) return result;
    if (!ctx.allowRemote) return result;
    if (!this._providers.some(p => !p.capabilities.isLocal)) return result;

    const originalStream = result.stream;
    const self = this;
    return {
      ...result,
      stream: (async function* () {
        let chars = 0;
        for await (const chunk of originalStream) {
          if (chunk.type === 'text') chars += chunk.content?.length ?? 0;
          yield chunk;
        }
        self._recordSpend(chars);
      })(),
    };
  }

  private _routerCtx(): RouterContext {
    const cfg = vscode.workspace.getConfiguration('perfLens');
    const allowRemote = cfg.get<boolean>('llm.allowRemote', false);
    const budget = cfg.get<number>('llm.budgetUSD');
    return { allowRemote, budgetRemainingUSD: budget };
  }

  private _createProvider(cfg: ProviderConfig): LLMProvider | undefined {
    const modelClass = classifyModel(cfg.model);
    void MODEL_CLASS_MAP; // referenced via classifyModel
    switch (cfg.type) {
      case 'ollama':
        return new OllamaProvider(
          cfg.baseUrl ?? 'http://localhost:11434',
          cfg.model,
          modelClass,
        );
      case 'openai-compat':
      case 'openai':
        return new OpenAICompatProvider(
          cfg.baseUrl ?? 'https://api.openai.com',
          cfg.model,
          cfg.apiKey ?? '',
          {
            modelClass,
            isLocal: cfg.isLocal ?? cfg.type === 'openai-compat',
            displayName: cfg.id,
          },
        );
      case 'anthropic':
        return new AnthropicProvider(cfg.model, cfg.apiKey ?? '', { modelClass });
      default:
        return undefined;
    }
  }
}

export function readSnippet(filePath: string, line: number, contextLines = 5): string {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    const start = Math.max(0, line - 1 - contextLines);
    const end   = Math.min(lines.length, line + contextLines);
    return lines.slice(start, end).join('\n');
  } catch {
    return '';
  }
}

export async function drainStream(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content;
  }
  return text;
}
