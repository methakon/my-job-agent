import {
  AiModelProvider,
  AiModelTier,
} from './ai-model.types';

export type AiTaskType =
  | 'general'
  | 'coding'
  | 'code_review'
  | 'quant_research'
  | 'trading_research'
  | 'reasoning'
  | 'reflexion';

export interface AiRoutingRequest {
  taskType: AiTaskType;
  complexity?: 'low' | 'medium' | 'high' | 'critical';
  requiresCoding?: boolean;
  requiresReasoning?: boolean;
  requiresQuantResearch?: boolean;
  allowPremium?: boolean;
  allowExperimental?: boolean;
  preferredModelKey?: string;
}

export interface AiRoutingDecision {
  /** Routing policy version that produced this decision. */
  routingPolicyVersion: string;

  /** Task category used by the router. */
  taskType: AiTaskType;

  /** Explicit Hermes model requested by the caller, if any. */
  requestedModelKey?: string;

  /** Hermes registry key of the model selected by the router. */
  selectedModelKey: string;

  /** Provider selected for execution. */
  selectedProvider: AiModelProvider;

  /** Provider-specific model ID selected for execution. */
  selectedModelId: string;

  /** Capability/tier classification of the selected model. */
  selectedModelTier: AiModelTier;

  /** Whether the selected model is experimental. */
  selectedModelExperimental: boolean;

  /** Deprecated: use selectedModelKey instead. */
  HermesModelKey?: string;
}