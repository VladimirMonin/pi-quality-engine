// Use only in an explicitly owned isolated ModelRuntime. registerProvider's
// models list replaces that provider's model list; do not use on working Pi.
import * as systemOne from '@earendil-works/pi-ai/api/typesafe-system-one';

export const priceProvenance = Object.freeze({
  state: 'unavailable-price-placeholders',
  enginePricePolicy: 'unknown',
  currency: null,
  actualCharge: null,
  contextCapacityBasis: 'retained-declared-64000-not-a-live-measurement',
});
export const modelProfile = Object.freeze({
  provider: 'polza', model: 'typesafe/jev', reasoning: 'off',
  requestTimeoutMs: 30000, maxAttempts: 1, retryDelayMs: 0,
  // Legacy configuration only: classification sends no output-token limit.
  maxOutputTokens: 1024, requiredInputs: ['text'], price: 'unknown',
});
export function registerQualityDecisionRoute(modelRuntime, selectedKey) {
  if (typeof selectedKey !== 'string' || selectedKey.length === 0) throw new Error('selected-credential-required');
  modelRuntime.registerProvider('polza', {
    name: 'Polza isolated typed decision', baseUrl: 'https://api.polza.ai/api/v1/',
    apiKey: selectedKey,
    classifiers: { 'typesafe-system-one': systemOne },
    models: [{
      id: 'typesafe/jev', name: 'Jev (unpriced SDK placeholders)',
      type: 'classifier', api: 'typesafe-system-one', input: ['text'],
      contextWindow: 64000,
      // Required numeric SDK metadata; unavailable prices, NEVER free service.
      // The paired engine profile MUST remain price:unknown.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  });
  return modelProfile;
}
