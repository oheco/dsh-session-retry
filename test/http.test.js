import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Config as PiConfig, apply as applyPi } from '@deepseek-ai/dsh-llm-pi-ai';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { harness } from './fixture.js';

function adapterFor(baseURL) {
  let adapter;
  const handle = () => {}; handle.replace = () => {};
  const credentials = { resolve: async () => ({ value: 'test-only-key' }), readRecord: async () => undefined, listRecords: async () => [] };
  applyPi({
    fiber: { entry: { options: { id: 'fixture-pi' } } }, on() {}, inject() {}, logger: { warn() {}, error() {} },
    get: name => name === 'credentials' ? credentials : undefined,
    llm: { registerConfigurableProviders: () => handle, registerModelDiscovery() {}, registerAdapter(_providers, value) { adapter = value; return handle; } },
  }, PiConfig({ providers: { fixture: { api: 'openai-responses', apiKeyEnv: 'FIXTURE_ONLY', baseURL,
    models: [{ id: 'fixture-model', contextWindow: 8192, maxTokens: 256, reasoningEfforts: false }],
    retryPolicy: { mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  } } }));
  return adapter;
}

test('actual pi-ai Responses HTTP/SSE adapter recovers from seven 502s, truncated SSE, and idle connections', { timeout: 20000 }, async t => {
  const requests = [], faults = Array(7).fill('502');
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const fault = faults.shift();
    if (fault === '502') {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Upstream service temporarily unavailable' } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (fault === 'idle') return;
    const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'HTTP recovered', annotations: [] }] };
    send({ type: 'response.created', response: { id: 'resp-fixture', model: 'fixture-model', status: 'in_progress', output: [] } });
    if (fault === 'truncated') { response.end(); return; }
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
    send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'HTTP recovered' });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'resp-fixture', model: 'fixture-model', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const host = await harness(t, adapterFor(`http://127.0.0.1:${server.address().port}/v1`), { idleTimeoutMs: 100, requestTimeoutMs: 5000 });
  await host.start();
  assert.equal(requests.length, 8);
  assert.deepEqual(host.events().filter(item => item.type === 'llm/retry').map(item => item.data.mode), ['normal', 'normal', 'normal', 'normal', 'normal', 'always', 'always']);
  assert.deepEqual(requests[0], requests[7], 'Retries send the same model-visible request.');
  faults.push('truncated', 'idle');
  host.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second turn' }] }));
  await host.agent.whenIdle();
  assert.equal(requests.length, 11);
  const errors = host.events().filter(item => item.type === 'llm/retry').slice(7).map(item => item.data.failure.code);
  assert.ok(errors.includes('TIMEOUT'));
  assert.equal(errors.length, 2);
  assert.equal(host.events().findLast(item => item.type === 'turn/end').data.reason.kind, 'completed');
});
