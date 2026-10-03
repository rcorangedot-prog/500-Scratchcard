/**
 * Public API — platform-neutral (runs in Node and in the browser).
 * Node-only extras (batch generation, HMAC verification) are in ./node.ts.
 */

export * from './config/parSheet.js';
export * from './rng/types.js';
export * from './rng/resultString.js';
export * from './rng/randomStream.js';
export * from './rng/devProviders.js';
export * from './math/grid.js';
export * from './math/outcomeModel.js';
export * from './math/reconcile.js';
export * from './ux/messages.js';
export * from './engine/gameRecord.js';
export * from './engine/hooks.js';
export * from './engine/outcome.js';
export * from './engine/engine.js';
