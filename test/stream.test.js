import test from 'node:test';
import assert from 'node:assert/strict';
import { guardStream } from '../stream.js';
import { harness, response, never } from './fixture.js';

const collect = async stream => { const chunks = []; for await (const item of stream) chunks.push(item); return chunks; };
const options = overrides => ({ lifetime: new AbortController().signal, idleTimeoutMs: 1000, requestTimeoutMs: 20, ...overrides });

test('total deadline bounds a stream that keeps producing chunks', { timeout: 5000 }, async () => {
  let returned = false;
  const chunks = await collect(guardStream(() => ({
    [Symbol.asyncIterator]() { return this; },
    async next() { return { done: false, value: { type: 'heartbeat' } }; },
    return() { returned = true; return never(); },
  }), options()));
  assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT');
  assert.match(chunks.at(-1).reason.failure.message, /exceeded/);
  assert.equal(chunks.filter(item => item.type === 'finish').length, 1);
  assert.equal(returned, true);
});

test('a partially emitted assistant attempt is discarded before the recovered response', { timeout: 10000 }, async t => {
  const host = await harness(t, (_options, attempt) => attempt === 1 ? (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'discard this partial answer' };
    await never();
  })() : (async function* () { yield* response('complete'); })(), { idleTimeoutMs: 20 });
  await host.start();
  const messages = host.events().filter(item => item.type === 'assistant/message');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].data.message.content, [{ type: 'text', text: 'complete' }]);
  assert.ok(!JSON.stringify(host.adapter.requests[1].messages).includes('discard this partial answer'));
});

test('late next rejection and rejected cleanup are observed without leaking an unhandled rejection', { timeout: 5000 }, async () => {
  const gate = Promise.withResolvers(), unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const chunks = await collect(guardStream(() => ({
      [Symbol.asyncIterator]() { return this; },
      next() { return gate.promise; },
      return() { return Promise.reject(new Error('cleanup failed')); },
    }), options({ idleTimeoutMs: 10, requestTimeoutMs: 0 })));
    assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT');
    gate.reject(new Error('late read failed'));
    await new Promise(setImmediate);
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener('unhandledRejection', listener); }
});

test('request duration may be disabled while idle timeout still applies', { timeout: 5000 }, async () => {
  const chunks = await collect(guardStream(() => ({
    [Symbol.asyncIterator]() { return this; }, next: never, return: never,
  }), options({ idleTimeoutMs: 10, requestTimeoutMs: 0 })));
  assert.match(chunks[0].reason.failure.message, /no response/);
});
