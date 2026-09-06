import { Controller, Post, Body } from '@nestjs/common';
import { AiService } from './ai.service';
import { AllowAiTestToken } from '../auth/bypass-auth.decorator';

@Controller('ai')
export class AiTestController {
  constructor(private readonly aiService: AiService) {}

  @Post('test')
  @AllowAiTestToken()
  async test(@Body() body: { prompt?: string }) {
    return this.aiService.generate({
      prompt: body.prompt || 'Reply with exactly: Hermes AI integration successful',
      maxTokens: 64,
      temperature: 0,
    });
  }
}
