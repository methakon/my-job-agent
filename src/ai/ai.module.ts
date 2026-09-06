import { Module } from '@nestjs/common';

import { AiService } from './ai.service';
import { AiRoutingService } from './ai-routing.service';
import { BedrockProvider } from './bedrock.provider';
import { AI_PROVIDER } from './ai-provider.interface';
import { AiTestController } from './ai-test.controller';

@Module({
  controllers: [AiTestController],

  providers: [
    AiService,
    AiRoutingService,
    BedrockProvider,
    {
      provide: AI_PROVIDER,
      useExisting: BedrockProvider,
    },
  ],

  exports: [
    AiService,
    AiRoutingService,
  ],
})
export class AiModule {}