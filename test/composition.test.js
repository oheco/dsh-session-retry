import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import ConfigEditor from '@deepseek-ai/dsh-config-editor';
import SettingsForms from '@deepseek-ai/dsh-settings';
import { mountRootInclude, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import { LlmRuntime, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import InvariantRegistry from '@deepseek-ai/dsh-invariants';
import * as retryInvariant from '@deepseek-ai/dsh-llm-retry/invariant';
import * as streamInvariant from '@deepseek-ai/dsh-llm/invariant';
import * as nativeRetry from '@deepseek-ai/dsh-llm-retry';
import * as plugin from '../index.js';
import { Adapter, response } from './fixture.js';

const runtime = process.env.DSH_TEST_RUNTIME ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/runtime');
async function boot(t, root) {
  const profile = { name: 'fixture', dir: path.join(root, 'profile'), home: path.join(root, 'home'), cwd: root,
    patchPath: path.join(root, 'profile/cordis.patch.yml'), installAnchor: path.join(runtime, 'package.json'),
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined };
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('profileContext', profile);
  const adapter = new Adapter((_options, attempt) => (async function* () {
    if (attempt <= 7) throw new LlmError('fixture unavailable', 'TRANSPORT');
    yield* response('recovered');
  })());
  let loop, mounts = 0;
  await ctx.plugin({ name: 'fixture-loader-services', apply(c) {
    new Loader(c, { baseUrl: pathToFileURL(`${runtime}/`).href });
    new ConfigEditor(c);
    new SettingsForms(c);
    new InvariantRegistry(c);
  } });
  Object.assign(ctx.loader.builtins, {
    'fixture-runtime': { name: 'fixture-runtime', apply(c) {
      new AgentRegistry(c); new SessionStore(c); new SessionProjectionRegistry(c);
      const llm = new LlmRuntime(c); llm.registerAdapter(['fixture'], adapter);
      new SystemPrompt(c, { includeHarnessIdentity: false, includeRuntimeContext: false });
      new ToolRuntime(c); loop = new AgentLoop(c, AgentLoop.Config({ agents: [] }));
    } },
    'native-retry': nativeRetry,
    'retry-invariant': retryInvariant,
    'stream-invariant': streamInvariant,
    'session-retry': { ...plugin, apply(c, config) { mounts++; return plugin.apply(c, config); } },
  });
  await mountRootInclude(ctx, path.join(root, 'base.yml'), readProfilePatches('dsh', profile));
  await ctx.loader.await();
  return { ctx, adapter, get loop() { return loop; }, mounts: () => mounts };
}

test('Loader profile: native configuration persists atomically, reloads, and drives a real agent with invariant checks', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(process.env.TMPDIR, 'dsh-retry-composition-')), owned = await realpath(root);
  // Register cleanup first; Context cleanup is registered later and runs first explicitly below.
  await mkdir(path.join(root, 'profile')); await mkdir(path.join(root, 'home'));
  await writeFile(path.join(root, 'profile/package.json'), JSON.stringify({ name: 'fixture-profile', private: true, dsh: { profile: { bundles: [] } } }));
  await writeFile(path.join(root, 'base.yml'), '[]\n');
  await writeFile(path.join(root, 'profile/cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'fixture-runtime', name: 'cordis:fixture-runtime' },
    { id: 'llm-retry', name: 'cordis:native-retry' },
    { id: 'retry-invariant', name: 'cordis:retry-invariant' },
    { id: 'stream-invariant', name: 'cordis:stream-invariant' },
    { id: 'oheco-session-retry', name: 'cordis:session-retry', config: { idleTimeoutMs: 1000, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  ] }], null, 2));
  let host, restored;
  try {
    host = await boot(t, root);
    const initial = host.ctx.settings.describe().find(item => item.ns === 'oheco-session-retry');
    assert.ok(initial);
    assert.equal(initial.autoGenerate, true);
    assert.equal(initial.value.enabled, true);
    const entry = host.ctx.loader.resolve('include:oheco-session-retry'), fiber = entry.fiber, ref = fiber.config.idleTimeoutMs;
    await host.ctx.settings.mutate(initial.ns, [{ op: 'set', path: ['idleTimeoutMs'], value: 2000 }], initial.revision);
    const updated = host.ctx.settings.describe().find(item => item.ns === initial.ns);
    assert.equal(entry.fiber, fiber); assert.equal(fiber.config.idleTimeoutMs, ref); assert.equal(ref.get(), 2000);
    assert.equal(host.mounts(), 1);
    const persisted = await readFile(path.join(root, 'profile/cordis.patch.yml'), 'utf8');
    assert.match(persisted, /idleTimeoutMs: 2000/);
    await assert.rejects(host.ctx.settings.mutate(initial.ns, [{ op: 'set', path: ['idleTimeoutMs'], value: 2500 }], initial.revision), { code: 'SETTINGS_CONFLICT' });
    await assert.rejects(host.ctx.settings.mutate(initial.ns, [
      { op: 'set', path: ['idleTimeoutMs'], value: 2500 }, { op: 'set', path: ['jitterRatio'], value: 2 },
    ], updated.revision));
    assert.equal(await readFile(path.join(root, 'profile/cordis.patch.yml'), 'utf8'), persisted);
    assert.equal(ref.get(), 2000);
    const agent = await host.loop.create('composition-agent', { provider: 'fixture', model: 'fixture-model' });
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }] }));
    await agent.whenIdle();
    assert.equal(host.adapter.requests.length, 8);
    assert.equal(agent.session.snapshotEvents().findLast(item => item.type === 'turn/end').data.reason.kind, 'completed');
    await host.ctx.fiber.dispose();
    restored = await boot(t, root);
    assert.equal(restored.ctx.settings.describe().find(item => item.ns === initial.ns).value.idleTimeoutMs, 2000);
  } finally {
    await restored?.ctx.fiber.dispose(); await host?.ctx.fiber.dispose();
    assert.equal(await realpath(root), owned);
    assert.ok(path.basename(owned).startsWith('dsh-retry-composition-'));
    await rm(owned, { recursive: true });
  }
});
