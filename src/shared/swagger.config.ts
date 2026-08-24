import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { INestApplication } from '@nestjs/common';

/**
 * Mounts Swagger UI at /docs for a service.
 * Call after NestFactory.create(app) in main.ts.
 */
export function setupSwagger(app: INestApplication, serviceName: string, portEnvVar: string): OpenAPIObject {
	const config = new DocumentBuilder()
		.setTitle(`MyLife — ${serviceName}`)
		.setDescription(`${serviceName} API (MyLife platform)`)
		.setVersion('0.1')
		.addBearerAuth()
		.build();
	const document = SwaggerModule.createDocument(app, config);
	SwaggerModule.setup('docs', app, document);
	return document;
}
