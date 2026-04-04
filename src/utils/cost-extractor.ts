/**
 * Cost extraction from Claude SDK result messages.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CostInfo {
  tokens: TokenUsage;
  costUsd: number;
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
}

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
};

export function extractCostFromResult(msg: any): CostInfo {
  const costUsd = msg.total_cost_usd ?? 0;
  let tokens: TokenUsage = { ...ZERO_TOKENS };
  const usage = msg.usage;
  if (usage) {
    tokens = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    };
  }

  const modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {};
  const mu = msg.modelUsage as Record<string, any> | undefined;
  if (mu) {
    for (const [modelId, data] of Object.entries(mu)) {
      modelUsage[modelId] = {
        inputTokens: data.inputTokens ?? 0,
        outputTokens: data.outputTokens ?? 0,
        costUsd: data.costUSD ?? 0,
      };
    }
  }
  return { tokens, costUsd, modelUsage };
}

export function zeroCost(): CostInfo {
  return { tokens: { ...ZERO_TOKENS }, costUsd: 0, modelUsage: {} };
}

export function addCost(a: CostInfo, b: CostInfo): CostInfo {
  const mergedUsage = { ...a.modelUsage };
  for (const [model, usage] of Object.entries(b.modelUsage)) {
    if (mergedUsage[model]) {
      mergedUsage[model] = {
        inputTokens: mergedUsage[model].inputTokens + usage.inputTokens,
        outputTokens: mergedUsage[model].outputTokens + usage.outputTokens,
        costUsd: mergedUsage[model].costUsd + usage.costUsd,
      };
    } else {
      mergedUsage[model] = { ...usage };
    }
  }
  return {
    tokens: {
      inputTokens: a.tokens.inputTokens + b.tokens.inputTokens,
      outputTokens: a.tokens.outputTokens + b.tokens.outputTokens,
      cacheReadTokens: a.tokens.cacheReadTokens + b.tokens.cacheReadTokens,
      cacheCreationTokens: a.tokens.cacheCreationTokens + b.tokens.cacheCreationTokens,
    },
    costUsd: a.costUsd + b.costUsd,
    modelUsage: mergedUsage,
  };
}
