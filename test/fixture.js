import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { LlmRuntime, LlmAdapter, createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as nativeRetry from '@deepseek-ai/dsh-llm-retry';
import * as plugin from '../index.js';

export const response = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];
export const deferred = () => Promise.withResolvers();
export const never = () => new Promise(() => {});

export class Adapter extends LlmAdapter {
  requests = [];
  constructor(script, policy = { mode: 'normal', maxRetries: 5 }) { super(); this.script = script; this.policy = policy; }
  providerRetryPolicy() {
    return resolveRetryPolicy({ ...this.policy, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, ...this.policy.backoff } }, 'fixture');
  }
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  stream(options) {
    this.requests.push(options);
    return this.script(options, this.requests.length);
  }
}

export async function harness(t, script, config = {}, policy) {
  const ctx = new Context();
  const adapter = script instanceof LlmAdapter ? script : new Adapter(script, policy);
  let loop, llm;
  await ctx.plugin({ name: 'fixture-runtime', apply(c) {
    new AgentRegistry(c);
    new SessionStore(c);
    new SessionProjectionRegistry(c);
    llm = new LlmRuntime(c);
    new SystemPrompt(c, { includeHarnessIdentity: false, includeRuntimeContext: false });
    new ToolRuntime(c);
    loop = new AgentLoop(c, AgentLoop.Config({ agents: [] }));
    llm.registerAdapter(['fixture'], adapter);
  } });
  await ctx.plugin(nativeRetry);
  let fiber = await ctx.plugin(plugin, { idleTimeoutMs: 100, requestTimeoutMs: 1000, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, ...config });
  t.after(() => ctx.fiber.dispose());
  const agent = await loop.create(`fixture-${crypto.randomUUID()}`, { provider: 'fixture', model: 'fixture-model' });
  return { ctx, agent, adapter, llm, fiber, events: () => agent.session.snapshotEvents(),
    start() { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }] })); return agent.whenIdle(); },
    async reload() { await fiber.dispose(); fiber = await ctx.plugin(plugin, { idleTimeoutMs: 100, requestTimeoutMs: 1000, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, ...config }); return fiber; },
  };
}

export function event(ctx, type, predicate = () => true) {
  const ready = deferred();
  const dispose = ctx.on('session/event', (_session, item) => {
    if (item.type === type && predicate(item)) { dispose(); ready.resolve(item); }
  }, { global: true });
  return ready.promise;
}
