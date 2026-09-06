import {
  AiModelDefinition,
  AiModelRole,
} from './ai-model.types';

export const HERMES_MODELS: readonly AiModelDefinition[] = [
  {
    key: 'hermes.qwen.coder.default',
    displayName: 'Qwen3 Coder Next',

    provider: 'bedrock',
    modelId: 'qwen.qwen3-coder-next',
    region: 'us-east-1',

    tier: 'worker',

    roles: [
      'worker',
      'coder',
      'quant_researcher',
      'reviewer',
      'reasoner',
      'reflexion',
    ],

    enabled: true,
    experimental: false,

    contextTokens: 256_000,
    maxOutputTokens: 16_384,

    capabilities: {
      coding: true,
      reasoning: true,
      toolUse: true,
      structuredOutput: true,
    },

    pricing: {
      inputPerMillion: undefined,
      outputPerMillion: undefined,
      currency: 'USD',
    },
  },
];

export function getAiModel(key: string): AiModelDefinition {
  const model = HERMES_MODELS.find((item) => item.key === key);

  if (!model) {
    throw new Error(`Unknown Hermes AI model: ${key}`);
  }

  return model;
}

export function getEnabledAiModels(): AiModelDefinition[] {
  return HERMES_MODELS.filter((model) => model.enabled);
}

export function getModelsForRole(
  role: AiModelRole,
): AiModelDefinition[] {
  return HERMES_MODELS.filter(
    (model) =>
      model.enabled &&
      model.roles.includes(role),
  );
}