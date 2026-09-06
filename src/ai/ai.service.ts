import { Inject, Injectable } from '@nestjs/common';
import {
  AI_PROVIDER,
  AiProvider,
  AiRequest,
  AiResponse,
} from './ai-provider.interface';

@Injectable()
export class AiService {
  constructor(
    @Inject(AI_PROVIDER)
    private readonly provider: AiProvider,
  ) {}

  async generate(request: AiRequest): Promise<AiResponse> {
    return this.provider.generate(request);
  }
}