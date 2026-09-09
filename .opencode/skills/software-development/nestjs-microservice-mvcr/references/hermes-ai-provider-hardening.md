# Hermes AI provider hardening (my-job-agent Step 6A) — 2026-09-06

Session detail for the AWS Bedrock Converse provider hardening in
`~/projects/my-job-agent/src/ai/`. Module: `AiTestController -> AiService ->
AI_PROVIDER (Symbol) -> BedrockProvider -> BedrockRuntimeClient ConverseCommand`.

Verified prod config (user-verified, keep working): `AWS_PROFILE=hermes`,
`AWS_REGION=us-east-1`,
`HERMES_BEDROCK_MODEL_ID=qwen.qwen3-coder-30b-a3b-v1:0`.
E2E baseline `POST /ai/test`:
`{text:"Hermes AI integration successful", modelId:"qwen...", inputTokens:16,
outputTokens:7, latencyMs:1261}`.

## Repo test convention (my-job-agent, and useful for any Jest-less NestJS repo)

- **No Jest, no @nestjs/testing in devDependencies.** Tests are plain node
  scripts in `scripts/*.test.js` using `node:assert/strict`, run AFTER
  `npm run build`, requiring `../dist/<path>` (no `.js` extension).
- Wire via package.json: `"test:ai": "npm run build && node
  scripts/ai-bedrock-provider.test.js"`. Existing `test:trading` chains
  several such scripts.
- Small harness: `const tests=[[name,fn],...]`, sequential await, tally
  pass/fail, `process.exitCode = 1` on failure. No test framework needed.
- To assert a rejection without assert.rejects quirks, use a helper that
  try/awaits, asserts `threw` is truthy, and runs a check predicate.

## Silent exit-0 hang (node plain-script suites) — diagnose first

Symptom: test output STOPS mid-suite at test N, then `EXIT=0`, no FAIL lines,
remaining tests never run. Cause: a test left a never-settling promise and no
event-loop handles remain (e.g. fake client that never resolves AND ignores
the abortSignal; the abort timer already fired, `finally` never ran) — node
drains the loop and exits 0 as if successful.

Check: count `^ok -` lines vs expected; inspect the tail of the output file.
A process that died would be non-zero; exit 0 with truncated output = event
loop drained. Fix the hang (below), not the harness.

## Bounded timeout must NOT depend on the client honoring abortSignal

Provider timeout implemented as `Promise.race` between the real send (with
`abortSignal` passed so the real SDK cancels the in-flight request) and a
timer promise rejecting with a typed timeout error. `Promise.race` attaches
handlers to every input, so the loser's later rejection is handled — no
unhandled-rejection crash. `clearTimeout` in `finally`. This fires even
against a non-cooperative/stubbed client that never settles.

## NestJS: optional ctor options for testable providers, no tokens

`constructor(@Optional() options?: BedrockProviderOptions)` — the interface
erases to the `Object` token at runtime, nothing is registered for it, and
`@Optional()` makes Nest inject `undefined` in production (env defaults
used). Tests construct `new BedrockProvider({ client: fake, logger: cap,
sleep: async()=>{}, modelId, timeoutMs, now })` directly — full injection of
fakes without DI tokens or a testing module. Verified with a throwaway
`NestFactory.createApplicationContext` probe compiled through the project
build (probe file deleted afterwards).

Dependency-faking knobs worth adding to the options surface: `client`,
`logger`, `now` (latency determinism), `sleep` (skip real backoff waits).

## Bedrock Converse hardening decisions

- Model config: read env at construction; `request.modelId > env`; if neither
  -> throw CONFIGURATION error naming the env var. NO silent fallback model
  (the original `|| 'amazon.nova-lite-v1:0'` fallback was the top hazard).
- Client `maxAttempts: 1` so the app layer is the SINGLE bounded retry
  authority (worst case exactly 1+maxRetries sends; no SDK+app double
  retries / retry storms).
- Retry only: THROTTLING (ThrottlingException, ProvisionedThroughputExceeded,
  http 429) and TRANSIENT (InternalServerException, ServiceUnavailable,
  ModelTimeout, ModelNotReady, http 500/502/503/504, network codes
  ECONNRESET/EPIPE/ETIMEDOUT/EAI_AGAIN/ENOTFOUND). NEVER retry:
  AccessDenied/Unauthorized (401/403), ValidationException,
  ResourceNotFoundException/ModelNotFoundException (invalid modelId),
  own-timeout, malformed response, unknown. Unknown => fail safe, no retry.
- Timeout: env `HERMES_BEDROCK_TIMEOUT_MS` default 60000; NOT retried
  (avoids stacking LLM waits). Retry count env `HERMES_BEDROCK_MAX_RETRIES`
  default 2, clamp 0..5; backoff base 250ms, delay in [exp/2, exp], cap 1500ms.
- Response parse: missing `output.message.content` -> MALFORMED_RESPONSE;
  present-but-empty text blocks -> `text: ''` (valid empty completion, safe).
  Tokens from `output.usage.inputTokens/outputTokens` (optional numbers).
- Error taxonomy file with `AiError { category, retryable, cause }` —
  original error preserved on `cause` for logs, never serialized to API
  responses; log lines carry provider/model/latency/tokens/attempt/category/
  error name/http status ONLY (never prompt, response, or raw err.message).
- classifyBedrockError: match SDK `err.name` sets first, then
  `err.$metadata.httpStatusCode`, then `err.code` network codes; UNKNOWN
  otherwise.

## Cost estimation (deterministic, honest)

Separate registry file keyed by exact modelId, entry = `{ pricingVersion,
inputUsdPer1k, outputUsdPer1k, note }` (USD per 1K tokens). Pure function
`estimateAiCost({modelId, inputTokens, outputTokens, registry?})`:
tokens * price / 1000, round 6dp. NULL price or NULL token count or unknown
model -> null costs + null pricingVersion — never a fabricated number.
Configured Qwen entry exists with `pricingVersion '2026-09-06-unverified'
and both prices null (AWS list price not yet verified); update = edit entry +
bump version, provider logic untouched.

## Result contract

Extended `AiResponse` with OPTIONAL additive fields only (provider, cost
fields, pricingVersion) so the 5 verified baseline fields stay byte-identical
and old consumers keep working; new fields ride along in the /ai/test body
until stripped in the controller if exact-body parity is wanted.
