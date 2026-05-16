import type { LLMProvider, TaskKind, RouterContext, ModelClass } from './types';
import { taskDefinitions } from './taskDefinitions';

const MODEL_CLASS_RANK: Record<ModelClass, number> = { small: 0, mid: 1, frontier: 2 };

export class TaskRouter {
  constructor(private readonly _providers: LLMProvider[]) {}

  selectProvider(task: TaskKind, ctx: RouterContext): LLMProvider | undefined {
    const def = taskDefinitions[task];
    const minRank = MODEL_CLASS_RANK[def.minimumModelClass];

    const candidates = this._providers.filter(p =>
      p.health !== 'unavailable' &&
      MODEL_CLASS_RANK[p.capabilities.modelClass] >= minRank &&
      (ctx.allowRemote || p.capabilities.isLocal) &&
      this._withinBudget(p, def.expectedOutputTokens, ctx.budgetRemainingUSD),
    );

    if (candidates.length === 0) return undefined;

    // Local-first: prefer local providers; among equal locality sort by model rank asc
    // (smallest sufficient model to limit cost).
    candidates.sort((a, b) => {
      const localDiff = (b.capabilities.isLocal ? 1 : 0) - (a.capabilities.isLocal ? 1 : 0);
      if (localDiff !== 0) return localDiff;
      return MODEL_CLASS_RANK[a.capabilities.modelClass] - MODEL_CLASS_RANK[b.capabilities.modelClass];
    });

    return candidates[0];
  }

  getProviderChain(task: TaskKind, ctx: RouterContext): LLMProvider[] {
    const def = taskDefinitions[task];
    const minRank = MODEL_CLASS_RANK[def.minimumModelClass];

    return this._providers
      .filter(p =>
        MODEL_CLASS_RANK[p.capabilities.modelClass] >= minRank &&
        (ctx.allowRemote || p.capabilities.isLocal),
      )
      .sort((a, b) => {
        const healthDiff = (b.health === 'healthy' ? 1 : 0) - (a.health === 'healthy' ? 1 : 0);
        if (healthDiff !== 0) return healthDiff;
        const localDiff = (b.capabilities.isLocal ? 1 : 0) - (a.capabilities.isLocal ? 1 : 0);
        if (localDiff !== 0) return localDiff;
        return MODEL_CLASS_RANK[a.capabilities.modelClass] - MODEL_CLASS_RANK[b.capabilities.modelClass];
      });
  }

  private _withinBudget(
    provider: LLMProvider,
    expectedOutputTokens: number,
    budgetRemainingUSD?: number,
  ): boolean {
    if (provider.capabilities.isLocal) return true;
    if (budgetRemainingUSD === undefined) return true;
    const costPerOut = provider.capabilities.costPerOutputToken ?? 0;
    const estimatedCost = costPerOut * expectedOutputTokens;
    return estimatedCost <= budgetRemainingUSD;
  }
}
