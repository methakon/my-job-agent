/**
 * Unit tests for the hardened Hermes Bedrock provider (src/ai).
 *
 * Convention follows the repo's existing scripts/*.test.js style: plain
 * node, no Jest, run AFTER `npm run build` (requires ../dist/...).
 *
 * AWS Bedrock is fully mocked: every test injects a fake send()-capable
 * client. No real AWS service is called and no AWS credentials are needed.
 *
 * Run: npm run test:ai   (or: npm run build && node scripts/ai-bedrock-provider.test.js)
 */
'use strict';

const assert = require('node:assert/strict');
const { BedrockProvider } = require('../dist/ai/bedrock.provider');
const {
  AiError,
  AiErrorCategory,
  classifyBedrockError,
} = require('../dist/ai/ai-errors');
const {
  estimateAiCost,
  AI_PRICING_REGISTRY,
} = require('../dist/ai/ai-pricing');

const MODEL = 'qwen.qwen3-coder-30b-a3b-v1:0';
const noSleep = async () => {};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function okResponse(over = {}) {
  const text = 'text' in over ? over.text : 'Hermes AI integration successful';
  const inputTokens = 'inputTokens' in over ? over.inputTokens : 16;
  const outputTokens = 'outputTokens' in over ? over.outputTokens : 7;
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens, outputTokens },
  };
}

/** Mimics an AWS SDK service error shape (name / $metadata.httpStatusCode). */
function sdkError(name, message, status) {
  const err = new Error(message);
  err.name = name;
  if (status !== undefined) err.$metadata = { httpStatusCode: status };
  return err;
}

/** Counting, scriptable fake client. */
function makeClient(handler) {
  const state = { n: 0, last: undefined };
  state.send = async (command) => {
    state.n += 1;
    state.last = command;
    return handler ? handler(state, command) : okResponse();
  };
  return state;
}

/** Provider wired with test overrides; client always injected (never real AWS). */
function makeProvider(over = {}) {
  const client = over.client || makeClient();
  return new BedrockProvider({
    sleep: noSleep,
    baseRetryDelayMs: 1,
    modelId: MODEL,
    client,
    ...over,
  });
}

/** Await a rejection and run a predicate over the thrown value. */
async function rejectsWith(fn, check) {
  let thrown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the call to reject');
  assert.ok(
    check(thrown),
    `rejection predicate failed; got: ${thrown && thrown.message}`,
  );
  return thrown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];

function test(name, fn) {
  tests.push([name, fn]);
}

// 1. Successful Qwen response (contract shape preserved, additive fields OK).
test('successful Qwen response keeps the /ai/test contract', async () => {
  const client = makeClient();
  const provider = makeProvider({ client });
  const res = await provider.generate({
    prompt: 'Reply with exactly: Hermes AI integration successful',
    maxTokens: 64,
    temperature: 0,
  });
  assert.equal(res.text, 'Hermes AI integration successful');
  assert.equal(res.modelId, MODEL);
  assert.equal(res.inputTokens, 16);
  assert.equal(res.outputTokens, 7);
  assert.equal(typeof res.latencyMs, 'number');
  assert.ok(res.latencyMs >= 0);
  assert.equal(res.provider, 'bedrock');
  // Qwen entry exists but is unverified -> honest nulls, identifiable version.
  assert.equal(res.estimatedInputCost, null);
  assert.equal(res.estimatedOutputCost, null);
  assert.equal(res.estimatedTotalCost, null);
  assert.equal(res.pricingVersion, '2026-09-06-unverified');
  assert.equal(client.n, 1);
});

// 2. Token extraction.
test('token extraction reads usage.inputTokens/outputTokens', async () => {
  const provider = makeProvider({
    client: makeClient(() => okResponse({ inputTokens: 1234, outputTokens: 56 })),
  });
  const res = await provider.generate({ prompt: 'hi' });
  assert.equal(res.inputTokens, 1234);
  assert.equal(res.outputTokens, 56);
});

// 3. Latency measurement.
test('latency measurement uses the request clock', async () => {
  let elapsed = 0;
  const provider = makeProvider({
    client: makeClient(async () => {
      elapsed += 1250;
      return okResponse();
    }),
    now: () => 1000 + elapsed,
  });
  const res = await provider.generate({ prompt: 'hi' });
  assert.equal(res.latencyMs, 1250);
});

// 4. Model ID propagation.
test('modelId propagates to the Converse request and the response', async () => {
  const client = makeClient();
  const provider = makeProvider({ client });
  const override = 'some.other-model-v1:0';
  const res = await provider.generate({ prompt: 'hi', modelId: override });
  assert.equal(res.modelId, override);
  assert.equal(client.last.input.modelId, override);
  // And without an override the configured default is used.
  const client2 = makeClient();
  const provider2 = makeProvider({ client: client2 });
  const res2 = await provider2.generate({ prompt: 'hi' });
  assert.equal(res2.modelId, MODEL);
  assert.equal(client2.last.input.modelId, MODEL);
});

// 5. Empty response handling.
test('empty content is handled safely (valid empty completion)', async () => {
  const provider = makeProvider({
    client: makeClient(() => ({
      output: { message: { content: [] } },
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
  });
  const res = await provider.generate({ prompt: 'hi' });
  assert.equal(res.text, '');
  assert.equal(res.inputTokens, 0);
  assert.equal(res.outputTokens, 0);
  assert.equal(res.modelId, MODEL);
});

// 6. Validation failure (and no request is ever sent).
test('validation failures reject before any provider call', async () => {
  const cases = [
    { prompt: '' },
    { prompt: '   ' },
    { prompt: 'ok', maxTokens: 0 },
    { prompt: 'ok', maxTokens: -3 },
    { prompt: 'ok', maxTokens: 1.5 },
    { prompt: 'ok', temperature: 1.2 },
    { prompt: 'ok', temperature: -0.1 },
  ];
  for (const req of cases) {
    const client = makeClient();
    const provider = makeProvider({ client });
    await rejectsWith(
      () => provider.generate(req),
      (err) =>
        err instanceof AiError && err.category === AiErrorCategory.VALIDATION,
    );
    assert.equal(client.n, 0, 'no Bedrock call for an invalid request');
  }
  // Boundary values inside the supported range are accepted.
  const provider = makeProvider();
  const res = await provider.generate({
    prompt: 'ok',
    maxTokens: 1,
    temperature: 0,
  });
  assert.equal(res.text, 'Hermes AI integration successful');
});

// Missing model configuration -> clear CONFIGURATION error, no Nova fallback.
test('missing model configuration fails clearly instead of a silent fallback', async () => {
  const saved = process.env.HERMES_BEDROCK_MODEL_ID;
  delete process.env.HERMES_BEDROCK_MODEL_ID;
  try {
    const client = makeClient();
    const provider = new BedrockProvider({ client, sleep: noSleep }); // no modelId option
    await rejectsWith(
      () => provider.generate({ prompt: 'hi' }),
      (err) =>
        err instanceof AiError &&
        err.category === AiErrorCategory.CONFIGURATION &&
        /HERMES_BEDROCK_MODEL_ID/.test(err.message),
    );
    assert.equal(client.n, 0);
    // request.modelId still works when env is missing.
    const res = await provider.generate({ prompt: 'hi', modelId: MODEL });
    assert.equal(res.modelId, MODEL);
  } finally {
    if (saved === undefined) delete process.env.HERMES_BEDROCK_MODEL_ID;
    else process.env.HERMES_BEDROCK_MODEL_ID = saved;
  }
});

// 7. Timeout.
test('bounded timeout rejects with TIMEOUT and no retry', async () => {
  const provider = new BedrockProvider({
    modelId: MODEL,
    sleep: noSleep,
    timeoutMs: 80,
    client: { send: () => new Promise(() => {}) }, // never settles
  });
  const err = await rejectsWith(
    () => provider.generate({ prompt: 'hi' }),
    (e) =>
      e instanceof AiError &&
      e.category === AiErrorCategory.TIMEOUT &&
      e.retryable === false,
  );
  assert.ok(/timed out after 80ms/.test(err.message));
});

// 8. Retryable failure -> successful retry.
test('throttling is retried and succeeds on the second attempt', async () => {
  let calls = 0;
  const provider = makeProvider({
    maxRetries: 2,
    client: makeClient(async () => {
      calls += 1;
      if (calls === 1) throw sdkError('ThrottlingException', 'rate exceeded', 429);
      return okResponse();
    }),
  });
  const res = await provider.generate({ prompt: 'hi' });
  assert.equal(res.text, 'Hermes AI integration successful');
  assert.equal(calls, 2);
});

// 9. Retryable failure -> retry limit exceeded.
test('persistent throttling stops after the bounded retry limit', async () => {
  let calls = 0;
  const provider = makeProvider({
    maxRetries: 2, // 1 initial + 2 retries = 3 attempts max
    client: makeClient(async () => {
      calls += 1;
      throw sdkError('ThrottlingException', 'rate exceeded', 429);
    }),
  });
  const err = await rejectsWith(
    () => provider.generate({ prompt: 'hi' }),
    (e) =>
      e instanceof AiError &&
      e.category === AiErrorCategory.THROTTLING &&
      e.retryable === true,
  );
  assert.equal(calls, 3);
  assert.ok(err.cause, 'original error preserved for logs');
  assert.equal(err.cause.name, 'ThrottlingException');
});

// 10. Non-retryable authorization failure -> no retry.
test('authorization failure is NOT retried', async () => {
  let calls = 0;
  const provider = makeProvider({
    maxRetries: 2,
    client: makeClient(async () => {
      calls += 1;
      throw sdkError('AccessDeniedException', 'not authorized', 403);
    }),
  });
  const err = await rejectsWith(
    () => provider.generate({ prompt: 'hi' }),
    (e) =>
      e instanceof AiError &&
      e.category === AiErrorCategory.AUTHENTICATION &&
      e.retryable === false,
  );
  assert.equal(calls, 1, 'no retry for auth failures');
  assert.equal(err.cause.name, 'AccessDeniedException');
});

// 11. Malformed provider error / unknown provider failure.
test('malformed and unclassifiable provider errors are not retried', async () => {
  // Response object missing output -> MALFORMED_RESPONSE.
  const c1 = makeClient(() => ({}));
  const p1 = makeProvider({ client: c1 });
  await rejectsWith(
    () => p1.generate({ prompt: 'hi' }),
    (e) =>
      e instanceof AiError &&
      e.category === AiErrorCategory.MALFORMED_RESPONSE,
  );
  assert.equal(c1.n, 1);

  // Generic unclassifiable throw -> UNKNOWN, no retry.
  let calls = 0;
  const p2 = makeProvider({
    maxRetries: 2,
    client: makeClient(async () => {
      calls += 1;
      throw new Error('something odd happened');
    }),
  });
  const err = await rejectsWith(
    () => p2.generate({ prompt: 'hi' }),
    (e) =>
      e instanceof AiError &&
      e.category === AiErrorCategory.UNKNOWN &&
      e.retryable === false,
  );
  assert.equal(calls, 1);
  assert.equal(err.cause.message, 'something odd happened');
});

// 11b. Error classifier mapping.
test('error classifier maps Bedrock failures to categories', () => {
  assert.deepEqual(classifyBedrockError(sdkError('ThrottlingException', '', 429)), {
    category: AiErrorCategory.THROTTLING,
    retryable: true,
  });
  assert.deepEqual(classifyBedrockError(sdkError('ValidationException', '', 400)), {
    category: AiErrorCategory.VALIDATION,
    retryable: false,
  });
  assert.deepEqual(
    classifyBedrockError(sdkError('ResourceNotFoundException', '', 404)),
    { category: AiErrorCategory.VALIDATION, retryable: false },
  );
  assert.deepEqual(
    classifyBedrockError(sdkError('AccessDeniedException', '', 403)),
    { category: AiErrorCategory.AUTHENTICATION, retryable: false },
  );
  assert.deepEqual(
    classifyBedrockError(sdkError('InternalServerException', '', 500)),
    { category: AiErrorCategory.TRANSIENT, retryable: true },
  );
  assert.deepEqual(classifyBedrockError({ name: 'AbortError' }), {
    category: AiErrorCategory.TIMEOUT,
    retryable: false,
  });
  assert.deepEqual(classifyBedrockError({ name: 'Error', code: 'ECONNRESET' }), {
    category: AiErrorCategory.TRANSIENT,
    retryable: true,
  });
  assert.deepEqual(classifyBedrockError({}), {
    category: AiErrorCategory.UNKNOWN,
    retryable: false,
  });
});

// 12. Cost estimation (deterministic, known pricing).
test('cost estimation is deterministic for known pricing', () => {
  const registry = {
    'test.model': {
      pricingVersion: 'v2026.1',
      inputUsdPer1k: 0.003,
      outputUsdPer1k: 0.006,
    },
  };
  const a = estimateAiCost({
    modelId: 'test.model',
    inputTokens: 1000,
    outputTokens: 500,
    registry,
  });
  assert.deepEqual(a, {
    estimatedInputCost: 0.003,
    estimatedOutputCost: 0.003,
    estimatedTotalCost: 0.006,
    pricingVersion: 'v2026.1',
    currency: 'USD',
  });
  // Deterministic: identical inputs -> identical outputs.
  const b = estimateAiCost({
    modelId: 'test.model',
    inputTokens: 1000,
    outputTokens: 500,
    registry,
  });
  assert.deepEqual(a, b);
});

// 13. Unknown pricing -> no fabricated cost.
test('unknown pricing yields nulls, never a fabricated cost', () => {
  // Configured Qwen model: entry exists (version identifiable) but unverified.
  const qwen = AI_PRICING_REGISTRY[MODEL];
  assert.ok(qwen, 'qwen pricing entry exists');
  assert.equal(qwen.inputUsdPer1k, null);
  assert.equal(qwen.outputUsdPer1k, null);
  const est = estimateAiCost({ modelId: MODEL, inputTokens: 16, outputTokens: 7 });
  assert.equal(est.estimatedInputCost, null);
  assert.equal(est.estimatedOutputCost, null);
  assert.equal(est.estimatedTotalCost, null);
  assert.equal(est.pricingVersion, '2026-09-06-unverified');
  // Model with no registry entry at all.
  const ghost = estimateAiCost({ modelId: 'ghost.model', inputTokens: 16 });
  assert.equal(ghost.estimatedTotalCost, null);
  assert.equal(ghost.pricingVersion, null);
});

// 14. Secret-safe logging.
test('logs never include secrets or full prompts', async () => {
  const lines = [];
  const logger = {
    log: (m) => lines.push(`log: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
  };
  const prompt = 'TOP-SECRET-PROMPT-BODY';
  const planted = 'AKIAIOSFODNN7EXAMPLE';
  const plantedSecret = 'superS3cretValue';
  const plantedToken = 'tok_abc123';

  // Failing call: provider error message contains planted secrets.
  const failProvider = makeProvider({
    logger,
    client: makeClient(async () => {
      throw sdkError(
        'AccessDeniedException',
        `denied for ${planted} secret=${plantedSecret} token=${plantedToken}`,
        403,
      );
    }),
  });
  await rejectsWith(
    () => failProvider.generate({ prompt }),
    () => true,
  );

  // Successful call with the same sensitive-looking prompt.
  const okProvider = makeProvider({ logger });
  await okProvider.generate({ prompt });

  const joined = lines.join('\n');
  for (const forbidden of [planted, plantedSecret, plantedToken, prompt]) {
    assert.ok(
      !joined.includes(forbidden),
      `log must not contain ${forbidden}; got:\n${joined}`,
    );
  }
  assert.ok(joined.includes('action=failure'));
  assert.ok(joined.includes('action=success'));
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  const failures = [];
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.error(`FAIL - ${name}`);
    }
  }
  console.log(`\n${passed}/${tests.length} AI provider tests passed`);
  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`\n--- ${f.name} ---`);
      console.error(f.err && f.err.stack ? f.err.stack : f.err);
    }
    process.exitCode = 1;
  }
})();
