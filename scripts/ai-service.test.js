const assert = require('node:assert/strict');

const { AiService } = require('../dist/ai/ai.service');
const { AiRoutingService } = require('../dist/ai/ai-routing.service');

const EXPECTED_MODEL_ID = 'qwen.qwen3-coder-next';
const EXPECTED_MODEL_KEY = 'hermes.qwen.coder.default';

function createMockProvider() {
  const calls = [];

  return {
    calls,

    async generate(request) {
      calls.push(request);

      return {
        text: 'mock response',
        modelId: request.modelId,
        provider: 'mock',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
        estimatedInputCost: null,
        estimatedOutputCost: null,
        estimatedTotalCost: null,
        pricingVersion: null,
      };
    },
  };
}

function createService() {
  const provider = createMockProvider();
  const routingService = new AiRoutingService();
  const service = new AiService(provider, routingService);

  return {
    service,
    provider,
  };
}

async function main() {
  /*
   * 1. General task routes to the registered default model.
   */
  {
    const { service, provider } = createService();

    const response = await service.generate({
      prompt: 'hello Hermes',
    });

    assert.equal(response.modelId, EXPECTED_MODEL_ID);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].modelId, EXPECTED_MODEL_ID);
    assert.equal(provider.calls[0].prompt, 'hello Hermes');
  }

  /*
   * 2. Coding task is routed correctly.
   */
  {
    const { service, provider } = createService();

    await service.generate({
      prompt: 'review this TypeScript function',
      taskType: 'coding',
    });

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].modelId, EXPECTED_MODEL_ID);
    assert.equal(provider.calls[0].taskType, 'coding');
  }

  /*
   * 3. Quant research task is routed correctly.
   */
  {
    const { service, provider } = createService();

    await service.generate({
      prompt: 'analyze this option chain',
      taskType: 'quant_research',
    });

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].modelId, EXPECTED_MODEL_ID);
    assert.equal(provider.calls[0].taskType, 'quant_research');
  }

  /*
   * 4. Explicit Hermes modelKey is honored.
   */
  {
    const { service, provider } = createService();

    await service.generate({
      prompt: 'explicit model test',
      taskType: 'general',
      modelKey: EXPECTED_MODEL_KEY,
    });

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].modelId, EXPECTED_MODEL_ID);
    assert.equal(provider.calls[0].modelKey, EXPECTED_MODEL_KEY);
  }

  /*
   * 5. Request parameters are preserved.
   */
  {
    const { service, provider } = createService();

    await service.generate({
      prompt: 'parameter preservation test',
      taskType: 'reasoning',
      systemPrompt: 'You are Hermes.',
      maxTokens: 128,
      temperature: 0.2,
    });

    assert.equal(provider.calls.length, 1);

    const request = provider.calls[0];

    assert.equal(request.prompt, 'parameter preservation test');
    assert.equal(request.taskType, 'reasoning');
    assert.equal(request.systemPrompt, 'You are Hermes.');
    assert.equal(request.maxTokens, 128);
    assert.equal(request.temperature, 0.2);
    assert.equal(request.modelId, EXPECTED_MODEL_ID);
  }

  /*
   * 6. Unknown model fails before provider invocation.
   */
  {
    const { service, provider } = createService();

    await assert.rejects(
      service.generate({
        prompt: 'unknown model test',
        modelKey: 'does.not.exist',
      }),
      /Unknown Hermes AI model/,
    );

    assert.equal(
      provider.calls.length,
      0,
      'Provider must not be called when routing fails',
    );
  }

  /*
   * 7. Provider response is returned unchanged.
   */
  {
    const { service, provider } = createService();

    const response = await service.generate({
      prompt: 'response propagation test',
    });

    assert.equal(response.text, 'mock response');
    assert.equal(response.modelId, EXPECTED_MODEL_ID);
    assert.equal(response.provider, 'mock');
    assert.equal(response.inputTokens, 10);
    assert.equal(response.outputTokens, 5);
    assert.equal(response.latencyMs, 1);
  }
  /*
 * 8. Service consumes the auditable routing decision
 */
{
  const { service, provider } = createService();

  const response = await service.generate({
    prompt: 'Audit routing decision',
    taskType: 'quant_research',
  });

  assert.equal(
    response.modelId,
    EXPECTED_MODEL_ID,
    'Service must use the model selected by routing',
  );

  assert.equal(
    provider.calls.length,
    1,
    'Provider must be called exactly once',
  );

  assert.equal(
    provider.calls[0].modelId,
    EXPECTED_MODEL_ID,
    'Provider must receive the routed provider model ID',
  );

  assert.equal(
    provider.calls[0].taskType,
    'quant_research',
    'Provider request must preserve the routed task type',
  );
}
  console.log('AI service integration tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});