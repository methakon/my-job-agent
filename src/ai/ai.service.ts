import { Inject, Injectable } from '@nestjs/common';
import {
  AI_PROVIDER,
  AiProvider,
  AiRequest,
  AiResponse,
} from './ai-provider.interface';
import { AiRoutingService } from './ai-routing.service';
import { AiRoutingDecision } from './ai-routing.types';

@Injectable()
export class AiService {
  constructor(
    @Inject(AI_PROVIDER)
    private readonly provider: AiProvider,
    private readonly routingService: AiRoutingService,
  ) {}

  async generate(request: AiRequest): Promise<AiResponse> {
    const routingDecision = this.routingService.resolveWithDecision({
      taskType: request.taskType ?? 'general',
      preferredModelKey: request.modelKey,
    });

    const routedRequest: AiRequest = {
      ...request,
      modelId: routingDecision.selectedModelId,
    };

    const baseResponse = await this.provider.generate(routedRequest);

    // Add routing metadata to response for audit and transparency
    // The LLM may provide its own model identity, but we overwrite it with trusted routing metadata
    const routingMetadata: AiResponse['routingMetadata'] = {
      routingPolicyVersion: routingDecision.routingPolicyVersion,
      hermesModelKey: routingDecision.requestedModelKey || routingDecision.selectedModelKey,
      selectedModelKey: routingDecision.selectedModelKey,
      selectedProvider: routingDecision.selectedProvider,
      selectedModelId: routingDecision.selectedModelId,
      selectedModelTier: routingDecision.selectedModelTier,
      selectedModelExperimental: routingDecision.selectedModelExperimental,
    };

    return {
      ...baseResponse,
      routingMetadata,
    };
  }
}