# Swagger on all services (added 2026-08-22, session d)

Setup that worked across all 8 services in the MyLife monorepo:

1. `npm install @nestjs/swagger` per service.
2. Enable the CLI plugin in each `nest-cli.json`:
   ```json
   "compilerOptions": { "deleteOutDir": true, "plugins": ["@nestjs/swagger"] }
   ```
   With the plugin, DTO schemas auto-generate from class-validator decorators —
   no manual `@ApiProperty()` needed for standard input/response DTOs.
3. Shared helper `services/shared/swagger.config.ts`:
   ```ts
   export function setupSwagger(app: INestApplication, serviceName: string) {
     const config = new DocumentBuilder()
       .setTitle(`MyLife — ${serviceName}`)
       .setDescription(`${serviceName} API (MyLife platform)`)
       .setVersion('0.1')
       .addBearerAuth()
       .build();
     const document = SwaggerModule.createDocument(app, config);
     SwaggerModule.setup('docs', app, document);
   }
   ```
4. **Copy this file into each service's `src/`** and import it as
   `./swagger.config`. Do NOT import it from `../../shared/` at type level:
   each service has its own node_modules, so `INestApplication` resolves to
   different declarations and tsc fails with long
   "Types of property 'enableVersioning' are incompatible" errors pointing at
   the shared file. This is the same rootDir/duplicate-deps constraint as
   env-check.ts.
5. main.ts: call `setupSwagger(app, '<service-name>')` after NestFactory.create;
   UI is then served at `/docs`.
6. Gateway public-path regexes must include `/^\/docs$/` and `/^\/docs-json$/`
   so Swagger UI stays reachable without a token.
7. Verify with `npx tsc --noEmit` per service; validate compose edits with
   `docker compose config` (no build needed).
