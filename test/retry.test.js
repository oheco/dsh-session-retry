import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import { harness, response, deferred, event, never } from './fixture.js';

const success = text => (async function* () { yield* response(text); })();
const fail = code => (async function* () { throw new LlmError(`fixture ${code}`, code); })();

test('seven failures recover in one step after the five native retries; user history is admitted once', { timeout: 10000 }, async t => {
  const host = await harness(t, (_options, attempt) => attempt <= 7 ? fail('TRANSPORT') : success('recovered'));
  await host.start();
  assert.equal(host.adapter.requests.length, 8);
  const events = host.events();
  const retries = events.filter(item => item.type === 'llm/retry');
  assert.deepEqual(retries.map(item => item.data.mode), ['normal', 'normal', 'normal', 'normal', 'normal', 'always', 'always']);
  assert.deepEqual(retries.slice(5).map(item => item.data.retry), [1, 2]);
  assert.equal(retries[5].data.retryId, retries[6].data.retryId);
  assert.equal(events.filter(item => item.type === 'llm/retry-started').length, 7);
  assert.equal(events.filter(item => item.type === 'step/start').length, 1);
  assert.equal(events.filter(item => item.type === 'user/message').length, 1);
  assert.equal(events.findLast(item => item.type === 'turn/end').data.reason.kind, 'completed');
  assert.ok(host.adapter.requests.every(Object.isFrozen));
  assert.equal(host.adapter.policy.maxRetries, 5);
});

test('unknown, authentication, quota, and bad-request failures are retried without a code whitelist', { timeout: 10000 }, async t => {
  const codes = ['PI_AI_ERROR', 'AUTH', 'QUOTA', 'INVALID_REQUEST'];
  const host = await harness(t, (_options, attempt) => attempt <= codes.length ? fail(codes[attempt - 1]) : success('ok'));
  await host.start();
  assert.deepEqual(host.events().filter(item => item.type === 'llm/retry').map(item => item.data.failure.code), codes);
  assert.equal(host.adapter.requests.length, 5);
});

test('never-resolving next and return time out, and late results cannot enter the recovered assistant message', { timeout: 10000 }, async t => {
  const late = deferred(); let closes = 0;
  const host = await harness(t, (_options, attempt) => attempt === 1 ? {
    [Symbol.asyncIterator]() { return this; },
    next() { return late.promise; },
    return() { closes++; return never(); },
  } : success('fresh'), { idleTimeoutMs: 20 });
  await host.start();
  assert.equal(host.adapter.requests.length, 2);
  assert.equal(host.events().find(item => item.type === 'llm/retry').data.failure.code, 'TIMEOUT');
  late.resolve({ done: false, value: { type: 'text-delta', index: 0, text: 'stale' } });
  await new Promise(setImmediate);
  assert.equal(closes, 1);
  const visible = host.events().filter(item => item.type === 'assistant/message');
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].data.message.content, [{ type: 'text', text: 'fresh' }]);
});

test('user stop exits a stalled stream without waiting for its next or cleanup', { timeout: 10000 }, async t => {
  const entered = deferred();
  const host = await harness(t, () => ({
    [Symbol.asyncIterator]() { return this; },
    next() { entered.resolve(); return never(); },
    return() { return never(); },
  }), { idleTimeoutMs: 100000 });
  const idle = host.start();
  await entered.promise;
  host.agent.cancel({ kind: 'user' });
  await idle;
  assert.equal(host.adapter.requests.length, 1);
  assert.equal(host.events().filter(item => item.type === 'llm/retry').length, 0);
  assert.equal(host.events().findLast(item => item.type === 'turn/end').data.reason.kind, 'aborted');
});

test('stop during backoff cancels the scheduled retry and does not emit started', { timeout: 10000 }, async t => {
  const host = await harness(t, () => fail('PI_AI_ERROR'), { initialDelayMs: 100000, maxDelayMs: 100000 });
  const scheduled = event(host.ctx, 'llm/retry');
  const idle = host.start();
  await scheduled;
  host.agent.cancel({ kind: 'user' });
  await idle;
  assert.equal(host.adapter.requests.length, 1);
  assert.equal(host.events().filter(item => item.type === 'llm/retry-started').length, 0);
});

test('a successful finish is sufficient even when the following read or return would hang', { timeout: 10000 }, async t => {
  const chunks = response('done'); let reads = 0;
  const host = await harness(t, () => ({
    [Symbol.asyncIterator]() { return this; },
    next() { reads++; return Promise.resolve(chunks.length ? { done: false, value: chunks.shift() } : never()); },
    return() { return never(); },
  }));
  await host.start();
  assert.equal(reads, 4);
  assert.equal(host.events().filter(item => item.type === 'llm/retry').length, 0);
});

test('middleware throws become recoverable stream failures, and auxiliary calls remain unchanged', { timeout: 10000 }, async t => {
  const host = await harness(t, () => success('ok'));
  let failures = 0;
  host.ctx.on('llm/stream', (_options, next) => { if (failures++ === 0) throw new LlmError('middleware transport', 'TRANSPORT'); return next(); });
  await host.start();
  assert.equal(host.events().find(item => item.type === 'llm/retry').data.failure.code, 'TRANSPORT');
  const auxiliary = { provider: 'fixture', model: 'fixture-model', messages: [] };
  const chunks = [];
  for await (const chunk of host.llm.stream(auxiliary)) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('plugin disabled preserves the native finite retry policy', { timeout: 10000 }, async t => {
  const host = await harness(t, () => fail('TRANSPORT'), { enabled: false });
  await host.start();
  assert.equal(host.adapter.requests.length, 6);
  assert.equal(host.events().filter(item => item.type === 'llm/retry').length, 5);
  assert.equal(host.events().findLast(item => item.type === 'turn/end').data.reason.kind, 'error');
});

test('plugin unload settles backoff and removes all request handlers', { timeout: 10000 }, async t => {
  const host = await harness(t, () => fail('PI_AI_ERROR'), { initialDelayMs: 100000, maxDelayMs: 100000 });
  const scheduled = event(host.ctx, 'llm/retry');
  const idle = host.start();
  await scheduled;
  await host.fiber.dispose();
  await idle;
  assert.equal(host.events().filter(item => item.type === 'llm/retry-started').length, 0);
  const before = host.adapter.requests.length;
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }] }));
  await host.agent.whenIdle();
  assert.equal(host.adapter.requests.length, before + 1);
});

test('a recovery handler throwing a non-Error value does not stop retry', { timeout: 10000 }, async t => {
  const host = await harness(t, (_options, attempt) => attempt === 1 ? fail('PI_AI_ERROR') : success('ok'));
  host.ctx.on('agent/request-error', () => { throw null; });
  await host.start();
  assert.equal(host.adapter.requests.length, 2);
  assert.equal(host.events().findLast(item => item.type === 'turn/end').data.reason.kind, 'completed');
});

test('plugin disposal leaves native-owned backoff cancellable by the original turn', { timeout: 10000 }, async t => {
  const host = await harness(t, () => fail('TRANSPORT'), {}, {
    mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 100000, maxDelayMs: 100000, jitterRatio: 0 },
  });
  const scheduled = event(host.ctx, 'llm/retry');
  const idle = host.start();
  assert.equal((await scheduled).data.mode, 'normal');
  await host.fiber.dispose();
  host.agent.cancel({ kind: 'user' });
  await idle;
  assert.equal(host.adapter.requests.length, 1);
  assert.equal(host.events().filter(item => item.type === 'llm/retry-started').length, 0);
});

test('request-error policy metadata is unchanged for other recovery handlers', { timeout: 10000 }, async t => {
  const host = await harness(t, (_options, attempt) => attempt === 1 ? fail('PI_AI_ERROR') : success('ok'));
  let policy;
  host.ctx.on('agent/request-error', (payload, next) => { policy = payload.retryPolicy; return next(); });
  await host.start();
  assert.equal(policy.mode, 'normal');
  assert.equal(policy.maxRetries, 5);
});
