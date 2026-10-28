import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp } from '../cdp.mjs';
import { controlEndpoint, isAlive } from '../platform.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

test('macOS detached helper: launch, authenticated IPC, inline metrics, singleton and clean stop', { timeout: 45000 }, async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS launcher smoke test');
  const chrome = process.env.CODEX_TPS_TEST_BROWSER ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { await access(chrome); } catch { return t.skip('No test Chromium executable available'); }
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-helper-')));
  const checkout = path.join(temp, 'a checkout with spaces and a long name to exercise the Darwin socket path limit');
  const codexHome = path.join(temp, 'synthetic-codex-home');
  const bundle = path.join(temp, 'Synthetic Codex.app');
  const executable = path.join(bundle, 'Contents', 'MacOS', 'Fixture');
  const thread = '11111111-1111-4111-8111-111111111111';
  const turn = 'test-turn';
  const env = { ...process.env, CODEX_HOME: codexHome };
  let browser, page, helperPid, browserPid;
  const endpoint = controlEndpoint(checkout);
  t.after(async () => {
    // These processes use only this test's synthetic app, logs and browser profile.
    if (helperPid && isAlive(helperPid)) await exec(process.execPath, [path.join(checkout, 'main.mjs'), 'stop'], { env }).catch(() => {});
    if (browser) { await browser.call('Browser.close').catch(() => {}); browser.close(); }
    page?.close();
    if (helperPid && isAlive(helperPid)) process.kill(helperPid, 'SIGTERM');
    if (browserPid && isAlive(browserPid)) process.kill(browserPid, 'SIGTERM');
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(endpoint.directory, { recursive: true, force: true });
  });
  await mkdir(checkout);
  await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  await mkdir(path.dirname(executable), { recursive: true });
  for (const file of ['main.mjs', 'metrics.mjs', 'cdp.mjs', 'renderer.js', 'platform.mjs', 'launch.mjs']) await copyFile(path.join(root, file), path.join(checkout, file));
  await writeFile(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>');
  const fixture = path.join(temp, 'composer.html');
  await writeFile(fixture, `<style>[data-composer-footer-responsive]{display:grid;grid-template-columns:auto 1fr auto} [contenteditable]{grid-column:1/-1} button{grid-row:2;grid-column:3} .permissions{grid-row:2;grid-column:1}</style>
    <div data-codex-composer-root><div data-composer-footer-responsive><div contenteditable="true"></div><span class="permissions">Full access</span><button>GPT-6.1 Sol</button></div></div>`);
  await writeFile(executable, '#!/bin/sh\nexec ' + quote(chrome) + ' --headless=new --disable-background-networking --no-first-run --no-default-browser-check '
    + quote('--user-data-dir=' + path.join(temp, 'isolated-browser')) + ' "$@" ' + quote(pathToFileURL(fixture).href + '#/local/' + thread) + '\n', { mode: 0o755 });
  const record = (timestamp, type, payload) => ({ timestamp: new Date(timestamp).toISOString(), type, payload: { thread_id: thread, turn_id: turn, ...payload } });
  const records = [
    record(0, 'turn_context', { model: 'gpt-6.1-sol' }),
    record(1000, 'event_msg', { type: 'task_started' }),
    record(4000, 'event_msg', { type: 'item_completed', started_at_ms: 2000, completed_at_ms: 4000, item: { id: 'answer', type: 'AgentMessage' } }),
    record(4100, 'token_usage_record', { response_id: 'response', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 400, reasoning_output_tokens: 0 } }),
    record(4200, 'event_msg', { type: 'task_complete' }),
  ];
  await writeFile(path.join(codexHome, 'sessions', `rollout-${thread}.jsonl`), records.map(JSON.stringify).join('\n') + '\n');
  const command = (name, ...args) => exec(process.execPath, [path.join(checkout, 'launch.mjs'), name, ...args], { env });
  const status = async () => JSON.parse((await command('status')).stdout);
  const until = async (check, message) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
    throw new Error(message);
  };
  assert.match((await command('start', '--app', bundle)).stdout, /TPS helper:/);
  let current;
  await until(async () => {
    current = await status();
    helperPid = current.pid;
    browserPid = current.codexPid;
    return current.phase === 'attached' && current.windows.some((window) => window.metrics?.current === 200);
  }, 'Detached helper did not attach and render synthetic metrics');
  assert.equal(current.windows[0].metrics.cache, 90);
  const pid = current.pid;
  assert.match((await command('start', '--app', bundle)).stdout, /attached/);
  assert.equal((await status()).pid, pid);
  const unauthorized = await new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.socket);
    let reply = '';
    socket.on('connect', () => socket.end(JSON.stringify({ command: 'stop', token: '0'.repeat(64) }) + '\n'));
    socket.on('data', (chunk) => { reply += chunk; });
    socket.on('end', () => resolve(JSON.parse(reply)));
    socket.on('error', reject);
  });
  assert.equal(unauthorized.error, 'unauthorized');
  assert.equal((await status()).pid, pid);
  const version = await (await fetch(`http://127.0.0.1:${current.port}/json/version`)).json();
  browser = new Cdp(version.webSocketDebuggerUrl);
  const target = (await (await fetch(`http://127.0.0.1:${current.port}/json/list`)).json()).find((target) => target.id === current.windows[0].id);
  page = new Cdp(target.webSocketDebuggerUrl);
  const countRows = async () => (await page.call('Runtime.evaluate', { expression: 'document.querySelectorAll("[data-codex-tps]").length', returnByValue: true })).result.value;
  assert.equal(await countRows(), 1);
  assert.equal(JSON.parse((await command('diagnostics')).stdout).views[0].view.text, '200tok/s·均值200·缓存90.00%');
  await until(async () => JSON.parse((await command('diagnostics')).stdout).views[0].view.visible, 'Helper did not reveal the row after its layout settled');
  assert.equal(JSON.parse((await command('stop')).stdout).phase, 'stopping');
  await until(async () => (await status()).phase === 'not-running', 'Helper did not stop');
  assert.equal(await countRows(), 0);
  assert.equal(isAlive(browserPid), true, 'Stopping the helper must leave the app running');
  await assert.rejects(access(path.join(checkout, '.runtime', 'helper.lock')), { code: 'ENOENT' });
  await assert.rejects(access(endpoint.socket), { code: 'ENOENT' });
});
