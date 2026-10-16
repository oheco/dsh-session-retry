import { randomUUID } from 'node:crypto';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { Config, snapshot } from './config.js';
import { guardStream } from './stream.js';

export { Config };
export const name = 'oheco-session-retry';
export const inject = ['llm', 'agents', 'sessionProjections'];
const POLICY_KEY = '@oheco/dsh-session-retry/v1';

function wait(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = ready => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(ready);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/**
 * Extend the base profile's finite retries using its durable retry events/UI.
 * No provider configuration, request content, or prepared call is rewritten.
 * @param {object} ctx Cordis plugin context.
 * @param {object} config Validated native live configuration references.
 */
export function apply(ctx, config = Config({})) {
  const lifetime = new AbortController(), operations = new Set();
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled([...operations]);
  });

  // Prepend so downstream middleware errors and stalled cleanup are guarded too.
  ctx.on('llm/stream', (options, next) => {
    const current = snapshot(config);
    if (!current.enabled || !isAgentLoopRequest(options)) return next();
    return guardStream(next, { ...current, signal: options.signal, lifetime: lifetime.signal });
  }, { prepend: true });

  async function recover(payload, next) {
    if (!config.enabled.get() || payload.signal.aborted || lifetime.signal.aborted) return next();
    let downstream;
    try { downstream = await next(); }
    catch (error) {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown recovery error';
      ctx.logger.warn('Another model recovery handler failed; automatic retry will continue: %s', message);
    }
    if (downstream?.kind === 'retry') return downstream;
    const current = snapshot(config);
    if (!current.enabled || payload.signal.aborted || lifetime.signal.aborted) return undefined;
    const { agent, turn, step, provider, failure } = payload;
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetry');
    if (state === undefined) throw new Error('Session retry requires the base profile llm-retry executor.');
    const previous = state[JSON.stringify([provider, POLICY_KEY])];
    const retry = (previous?.retry ?? 0) + 1;
    const retryId = previous?.retryId ?? randomUUID();
    const exponential = Math.min(current.initialDelayMs * 2 ** Math.min(retry - 1, 1024), current.maxDelayMs);
    const local = Math.min(exponential * (1 - current.jitterRatio + 2 * current.jitterRatio * Math.random()), current.maxDelayMs);
    const after = failure.providerRetryAfterMs;
    const delayMs = Number.isFinite(after) && after > 0 && after <= current.maxDelayMs ? after : local;
    const signal = AbortSignal.any([payload.signal, lifetime.signal]);
    if (signal.aborted) return undefined;
    agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'always', policyKey: POLICY_KEY, retry, delayMs, failure });
    const operation = wait(delayMs, signal);
    operations.add(operation);
    let ready;
    try { ready = await operation; }
    finally { operations.delete(operation); }
    if (!ready || signal.aborted || !config.enabled.get()) return undefined;
    agent.session.append('llm/retry-started', { retryId, turn, step, retry });
    return { kind: 'retry' };
  }

  ctx.on('agent/request-error', recover, { prepend: true });
}
