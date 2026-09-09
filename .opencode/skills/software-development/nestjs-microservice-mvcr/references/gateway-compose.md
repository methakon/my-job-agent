# Gateway + docker-compose layout (MyLife services, 2026-08-22)

## Gateway edge auth

`services/mylife-gateway/src/jwt-verify.middleware.ts`:
- Public-path regexes bypass verification: /auth/signup, /auth/login,
  /auth/refresh, /auth/google*, /auth/facebook*, /docs, /docs-json, /health.
- Reads `JWT_PUBLIC_KEY_PATH` from root .env, resolves relative paths against
  the repo root, verifies RS256.
- On success injects `X-User-Id` and `X-User-Email` request headers so
  downstream services never see tokens.

## Route wiring (app.module.ts implements NestModule)

```ts
const PROXY_ROUTES = [
  { path: '/auth', target: process.env.AUTH_URL },
  { path: '/users', target: process.env.USERS_URL }, // etc
];
configure(consumer: MiddlewareConsumer) {
  for (const route of PROXY_ROUTES) {
    const target = route.target || DEFAULT_TARGETS[route.path];
    consumer.apply(JwtVerifyMiddleware).forRoutes(route.path);
    consumer.apply(proxyFor(target)).forRoutes(route.path);
  }
}
// proxyFor returns the raw http-proxy-middleware handler —
// NestJS apply() cannot construct middleware classes with constructor args.
```

## docker-compose.yml

- `mysql:8.0` with healthcheck (`mysqladmin ping`); all services
  `depends_on: mysql: {condition: service_healthy}`.
- Init script mounted at `/docker-entrypoint-initdb.d/01-create-databases.sql`
  creates mylife_auth/users/astrology/career/finance/learning on first boot
  (only runs when the data volume is empty).
- One service container each; single shared `docker/Dockerfile.service`
  parameterized by `SERVICE_DIR` build arg:
  node:22-alpine, `npm ci`, tsc build stage, then slim runtime copying
  node_modules + dist. Each container gets `env_file: .env` plus overrides
  (`MYSQL_HOST: mysql`, PORT, inter-service URLs like `AUTH_URL: http://auth:3001`).
- Validate without building: `docker compose config`.
