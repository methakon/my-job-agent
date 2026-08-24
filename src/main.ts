import { checkCredentials } from './shared/env-check';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupSwagger } from './shared/swagger.config';
import { join } from 'path';
import * as express from 'express';

async function bootstrap(): Promise<void> {
	checkCredentials('my-job-agent');
	const app = await NestFactory.create<NestExpressApplication>(AppModule);
	app.enableCors();
	app.useStaticAssets(join(__dirname, '..', 'public'));
	app.getHttpAdapter().getInstance().get('/', (_req: unknown, res: { sendFile: (p: string) => void }) =>
		res.sendFile(join(__dirname, '..', 'public', 'dashboard.html')));
	setupSwagger(app, 'my-job-agent', 'AGENT_PORT');
	await app.listen(Number(process.env.AGENT_PORT || 3010));
}
bootstrap();
