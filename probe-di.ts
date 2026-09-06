import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { BedrockProvider } from './src/ai/bedrock.provider';

@Module({ providers: [BedrockProvider] })
class ProbeModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(ProbeModule, { logger: false });
  const p = app.get(BedrockProvider);
  console.log('DI_OK', p.constructor.name);
  await app.close();
}
main().catch((e) => { console.error('DI_FAIL', e.message); process.exit(1); });
