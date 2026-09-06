export type AiModelProvider = 'bedrock' | 'local';

export type AiModelRole =
  | 'worker'
  | 'coder'
  | 'quant_researcher'
  | 'reviewer'
  | 'reasoner'
  | 'reflexion';

export type AiModelTier =
  | 'worker'
  | 'specialist'
  | 'challenger'
  | 'premium'
  | 'local';

export interface AiModelDefinition {
  key: string;
  displayName: string;

  provider: AiModelProvider;
  modelId: string;
  region?: string;

  tier: AiModelTier;
  roles: AiModelRole[];

  enabled: boolean;
  experimental: boolean;

  contextTokens: number;
  maxOutputTokens: number;

  capabilities: {
    coding: boolean;
    reasoning: boolean;
    toolUse: boolean;
    structuredOutput: boolean;
  };

  pricing?: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    currency: 'USD';
    pricingVersion?: string;
  };
}
