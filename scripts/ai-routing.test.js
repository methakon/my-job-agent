const assert = require('node:assert/strict');

const { AiRoutingService } = require('../dist/ai/ai-routing.service');
const {
  HERMES_MODELS,
  getAiModel,
} = require('../dist/ai/ai-model-registry');

const router = new AiRoutingService();

const qwen = getAiModel('hermes.qwen.coder.default');

assert.ok(qwen, 'Default Qwen model must exist');
assert.equal(qwen.enabled, true, 'Default Qwen model must be enabled');
assert.equal(qwen.experimental, false, 'Default Qwen must not be experimental');

function expectModel(taskType, expectedKey, extra = {}) {
  const result = router.resolve({
    taskType,
    ...extra,
  });

  assert.equal(
    result.key,
    expectedKey,
    `${taskType} should route to ${expectedKey}, got ${result.key}`,
  );
}

/*
 * 1. Default task routing
 */
expectModel('general', qwen.key);
expectModel('coding', qwen.key);
expectModel('code_review', qwen.key);
expectModel('quant_research', qwen.key);
expectModel('trading_research', qwen.key);
expectModel('reasoning', qwen.key);
expectModel('reflexion', qwen.key);

/*
 * 2. Explicit model selection
 *
 * An explicitly requested valid model must be honored.
 */
expectModel(
  'general',
  qwen.key,
  {
    preferredModelKey: qwen.key,
  },
);

/*
 * 3. Unknown model must fail closed
 */
assert.throws(
  () =>
    router.resolve({
      taskType: 'general',
      preferredModelKey: 'does.not.exist',
    }),
  /Unknown Hermes AI model/,
  'Unknown model must fail closed',
);

/*
 * 4. Disabled model must fail closed
 *
 * We temporarily disable the real Qwen object only for this test,
 * then restore it immediately.
 */
const originalEnabled = qwen.enabled;

try {
  qwen.enabled = false;

  assert.throws(
    () =>
      router.resolve({
        taskType: 'general',
        preferredModelKey: qwen.key,
      }),
    /disabled/,
    'Disabled model must be rejected',
  );
} finally {
  qwen.enabled = originalEnabled;
}

/*
 * 5. Experimental model policy
 *
 * Use an isolated test model rather than adding fake production
 * models to the Hermes registry.
 */
const experimentalModel = {
  ...qwen,
  key: 'test.experimental.model',
  displayName: 'Test Experimental Model',
  experimental: true,
  enabled: true,
};

HERMES_MODELS.push(experimentalModel);

try {
  assert.throws(
    () =>
      router.resolve({
        taskType: 'general',
        preferredModelKey: experimentalModel.key,
      }),
    /experimental/,
    'Experimental model must be rejected by default',
  );

  const allowedExperimental = router.resolve({
    taskType: 'general',
    preferredModelKey: experimentalModel.key,
    allowExperimental: true,
  });

  assert.equal(
    allowedExperimental.key,
    experimentalModel.key,
    'Experimental model should be allowed when explicitly enabled',
  );
} finally {
  HERMES_MODELS.pop();
}

/*
 * 6. Premium model policy
 */
const premiumModel = {
  ...qwen,
  key: 'test.premium.model',
  displayName: 'Test Premium Model',
  tier: 'premium',
  enabled: true,
  experimental: false,
};

HERMES_MODELS.push(premiumModel);

try {
  assert.throws(
    () =>
      router.resolve({
        taskType: 'general',
        preferredModelKey: premiumModel.key,
      }),
    /premium/,
    'Premium model must be rejected by default',
  );

  const allowedPremium = router.resolve({
    taskType: 'general',
    preferredModelKey: premiumModel.key,
    allowPremium: true,
  });

  assert.equal(
    allowedPremium.key,
    premiumModel.key,
    'Premium model should be allowed when explicitly enabled',
  );
} finally {
  HERMES_MODELS.pop();
}

/*
 * 7. Policy combination
 *
 * A model that is both premium and experimental requires
 * both permissions.
 */
const restrictedModel = {
  ...qwen,
  key: 'test.restricted.model',
  displayName: 'Test Restricted Model',
  tier: 'premium',
  enabled: true,
  experimental: true,
};

HERMES_MODELS.push(restrictedModel);

try {
  assert.throws(
    () =>
      router.resolve({
        taskType: 'general',
        preferredModelKey: restrictedModel.key,
        allowPremium: true,
      }),
    /not allowed/,
    'Experimental restriction must remain active',
  );

  assert.throws(
    () =>
      router.resolve({
        taskType: 'general',
        preferredModelKey: restrictedModel.key,
        allowExperimental: true,
      }),
    /not allowed/,
    'Premium restriction must remain active',
  );

  const allowedRestricted = router.resolve({
    taskType: 'general',
    preferredModelKey: restrictedModel.key,
    allowPremium: true,
    allowExperimental: true,
  });

  assert.equal(
    allowedRestricted.key,
    restrictedModel.key,
    'Both explicit permissions should allow the restricted model',
  );
} finally {
  HERMES_MODELS.pop();
}
/*
 * 8. Routing decision is auditable
 */
{
  const decision = router.resolveWithDecision({
    taskType: 'quant_research',
  });

  assert.equal(
    decision.routingPolicyVersion,
    'v1',
    'Routing decision must contain the policy version',
  );

  assert.equal(
    decision.taskType,
    'quant_research',
    'Routing decision must record the task type',
  );

  assert.equal(
    decision.requestedModelKey,
    undefined,
    'No explicit model request should be recorded as undefined',
  );

  assert.equal(
    decision.selectedModelKey,
    'hermes.qwen.coder.default',
    'Routing decision must record the selected Hermes model key',
  );

  assert.equal(
    decision.selectedProvider,
    'bedrock',
    'Routing decision must record the selected provider',
  );

  assert.equal(
    decision.selectedModelId,
    'qwen.qwen3-coder-next',
    'Routing decision must record the provider model ID',
  );

  assert.equal(
    decision.selectedModelTier,
    'worker',
    'Routing decision must record the selected model tier',
  );

  assert.equal(
    decision.selectedModelExperimental,
    false,
    'Routing decision must record experimental status',
  );
}

/*
 * 9. Explicit model selection is reflected in the audit decision
 */
{
  const decision = router.resolveWithDecision({
    taskType: 'coding',
    preferredModelKey: 'hermes.qwen.coder.default',
  });

  assert.equal(
    decision.requestedModelKey,
    'hermes.qwen.coder.default',
    'Audit decision must preserve the requested model key',
  );

  assert.equal(
    decision.selectedModelKey,
    'hermes.qwen.coder.default',
    'Audit decision must record the selected model key',
  );

  assert.equal(
    decision.selectedModelId,
    'qwen.qwen3-coder-next',
    'Audit decision must record the selected provider model ID',
  );
}

console.log('AI routing comprehensive tests passed');