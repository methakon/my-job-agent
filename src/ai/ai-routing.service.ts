import { Injectable } from '@nestjs/common';

import {
  getAiModel,
  getModelsForRole,
} from './ai-model-registry';

import {
  AiModelDefinition,
} from './ai-model.types';

import {
  AiRoutingRequest,
  AiTaskType,
  AiRoutingDecision,
} from './ai-routing.types';

@Injectable()
export class AiRoutingService {
  /**
   * Resolve the model Hermes should use for a task.
   *
   * Routing is deterministic. The model itself never decides
   * which model should handle the request.
   */
  resolve(request: AiRoutingRequest): AiModelDefinition {
    const requestedModelKey = request.preferredModelKey;

    if (requestedModelKey) {
      return this.resolvePreferredModel(requestedModelKey, request);
    }

    const role = this.roleForTask(request.taskType);

    const candidates = getModelsForRole(role).filter(
      (model) =>
        this.isAllowedByPolicy(model, request),
    );

    if (candidates.length === 0) {
      throw new Error(
        `No enabled Hermes AI model is available for task type: ${request.taskType}`,
      );
    }

    return candidates[0];
  }

  private resolvePreferredModel(
    modelKey: string,
    request: AiRoutingRequest,
  ): AiModelDefinition {
    const model = getAiModel(modelKey);

    if (!model.enabled) {
      throw new Error(
        `Hermes AI model is disabled: ${modelKey}`,
      );
    }

    if (!this.isAllowedByPolicy(model, request)) {
      throw new Error(
        `Hermes AI model is not allowed for this request: ${modelKey}`,
      );
    }

    return model;
  }

  private isAllowedByPolicy(
    model: AiModelDefinition,
    request: AiRoutingRequest,
  ): boolean {
    if (model.experimental && !request.allowExperimental) {
      return false;
    }

    if (model.tier === 'premium' && !request.allowPremium) {
      return false;
    }

    return true;
  }

  private roleForTask(taskType: AiTaskType) {
    switch (taskType) {
      case 'coding':
        return 'coder' as const;

      case 'code_review':
        return 'reviewer' as const;

      case 'quant_research':
      case 'trading_research':
        return 'quant_researcher' as const;

      case 'reasoning':
        return 'reasoner' as const;

      case 'reflexion':
        return 'reflexion' as const;

      case 'general':
      default:
        return 'worker' as const;
    }
  }
  resolveWithDecision(
    request: AiRoutingRequest,
  ): AiRoutingDecision {
    const model = this.resolve(request);

    return {
      routingPolicyVersion: 'v1',
      taskType: request.taskType,
      requestedModelKey: request.preferredModelKey,
      selectedModelKey: model.key,
      selectedProvider: model.provider,
      selectedModelId: model.modelId,
      selectedModelTier: model.tier,
      selectedModelExperimental: model.experimental,
    };
  }
}