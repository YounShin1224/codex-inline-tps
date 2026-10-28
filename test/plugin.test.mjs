import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTpsServer, PANEL_URI } from '../plugins/codex-tps/server.mjs';
import { SessionStore } from '../plugins/codex-tps/session-store.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function records(threadId, output = 400) {
  const entry = (timestamp, type, payload) => ({ timestamp: new Date(timestamp).toISOString(), type,
    payload: { thread_id: threadId, turn_id: 'turn', ...payload } });
  return [entry(0, 'turn_context', { model: 'gpt-6.1-sol' }), entry(1000, 'event_msg', { type: 'task_started' }),
    entry(4000, 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'answer', text: 'PRIVATE-REPLY' }, started_at_ms: 2000, completed_at_ms: 4000 }),
    entry(4100, 'token_usage_record', { response_id: 'response', usage: { output_tokens: output, input_tokens: 1000, cached_input_tokens: 900 } }),
    entry(4200, 'event_msg', { type: 'task_complete' })].map(JSON.stringify).join('\n') + '\n';
}
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-plugin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'sessions'));
  const file = path.join(home, 'sessions', `rollout-${A}.jsonl`);
  await writeFile(file, records(A));
  return { home, file, store: new SessionStore(home) };
}
async function connect(t, store) {
  const server = createTpsServer({ store, html: '<!doctype html><title>TPS</title>' });
  const client = new Client({ name: 'native-plugin-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(right), client.connect(left)]);
  return client;
}

test('native entrypoint is a thread panel; background reads are app-only and read-only', async (t) => {
  const { store } = await fixture(t);
  const client = await connect(t, store);
  const { tools } = await client.listTools();
  const open = tools.find((tool) => tool.name === 'open_codex_tps');
  assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  assert.equal(open._meta.ui.resourceUri, PANEL_URI);
  for (const tool of tools) assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tools.find((tool) => tool.name === 'read_codex_tps')._meta.ui.visibility, ['app']);
  const initial = await client.callTool({ name: 'open_codex_tps', arguments: {} });
  assert.equal(initial.structuredContent.state, 'unbound', 'An entrypoint must not pick the newest chat');
  const opened = await client.callTool({ name: 'open_codex_tps', arguments: { threadId: A } });
  assert.equal(opened.structuredContent.current, 200);
  assert.equal(opened.structuredContent.cache, 90);
  assert.ok(!JSON.stringify(opened).includes('PRIVATE-REPLY'));
  const resource = await client.readResource({ uri: PANEL_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
});

test('MCP rejects path traversal and unknown selected models never show another model speed', async (t) => {
  const { store } = await fixture(t);
  const client = await connect(t, store);
  const invalid = await client.callTool({ name: 'read_codex_tps', arguments: { threadId: '../../auth.json' } });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({ name: 'read_codex_tps', arguments: { threadId: A, model: 'gpt-unknown' } });
  assert.equal(unknown.structuredContent.current, null);
  assert.equal(unknown.structuredContent.model, null);
  const missing = await client.callTool({ name: 'read_codex_tps', arguments: { threadId: B } });
  assert.equal(missing.structuredContent.found, false);
});

test('session discovery is bounded metadata and does not follow linked logs', async (t) => {
  const { home, store } = await fixture(t);
  const before = await readFile(path.join(home, 'sessions', `rollout-${A}.jsonl`), 'utf8');
  if (process.platform !== 'win32') {
    await writeFile(path.join(home, 'private.jsonl'), 'not-a-session');
    await symlink(path.join(home, 'private.jsonl'), path.join(home, 'sessions', `rollout-${B}.jsonl`));
  }
  const sessions = await store.list();
  assert.deepEqual(sessions.map((item) => item.threadId), [A]);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['modifiedAt', 'threadId']);
  assert.equal(await readFile(path.join(home, 'sessions', `rollout-${A}.jsonl`), 'utf8'), before);
});

test('concurrent panels keep explicit selections; replacing a log invalidates snapshot caches', async (t) => {
  const { home, file, store } = await fixture(t);
  await writeFile(path.join(home, 'sessions', `rollout-${B}.jsonl`), records(B, 200));
  const results = await Promise.all([store.snapshot(A), store.snapshot(B), store.snapshot(A)]);
  assert.deepEqual(results.map((entry) => entry.current), [200, 100, 200]);
  const replacement = records(A, 600);
  await rm(file); await writeFile(file, replacement);
  assert.equal((await store.snapshot(A)).current, 300);
});

test('built stdio package starts without node_modules beside it and serves self-contained UI', async (t) => {
  const { home } = await fixture(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-tps-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['server.mjs', 'panel.html']) {
    await writeFile(path.join(dir, name), await readFile(path.join(root, 'plugins/codex-tps/dist', name)));
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(dir, 'server.mjs')], env: { CODEX_HOME: home }, stderr: 'pipe' });
  const client = new Client({ name: 'package-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const metrics = await client.callTool({ name: 'open_codex_tps', arguments: { threadId: A } });
  assert.equal(metrics.structuredContent.current, 200);
  const resource = await client.readResource({ uri: PANEL_URI });
  const html = resource.contents[0].text;
  assert.ok(html.includes('<title>Codex TPS</title>'));
  assert.ok(!html.includes('/* __PANEL_SCRIPT__ */'));
  assert.ok(!/<script[^>]+src=/.test(html));
});
