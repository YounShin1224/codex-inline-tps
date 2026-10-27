import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { RolloutReader } from './metrics.mjs';
import { PageAttachment } from './cdp.mjs';

// All component-owned files live beside the delivered source. Codex's state is opened read-only.
const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, '.runtime');
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const userKey = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16);
const controlPath = process.platform === 'win32' ? `\\\\.\\pipe\\codex-inline-tps-${userKey}` : path.join(runtime, 'control.sock');
const connectionPath = path.join(runtime, 'connection.json');
const controlTokenPath = path.join(runtime, 'control-token');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];

async function log(message, details = {}) {
  await mkdir(runtime, { recursive: true });
  const file = path.join(runtime, 'diagnostics.jsonl');
  try { if ((await stat(file)).size > 1024 * 1024) await writeFile(file, ''); } catch { /* First launch. */ }
  await appendFile(file, JSON.stringify({ time: new Date().toISOString(), message, ...details }) + '\n');
}

// A named pipe controls only our helper. It never forwards commands to Codex or other programs.
async function control(command) {
  const token = (await readFile(controlTokenPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local control secret');
  return new Promise((resolve, reject) => {
    const socket = net.connect(controlPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Helper control timed out')); }, 12000);
    let data = '';
    socket.on('connect', () => socket.end(JSON.stringify({ command, token }) + '\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid helper reply')); } });
  });
}

// Resolve exact thread filenames on demand. An absent thread yields blanks, never a recency guess.
class Sessions {
  constructor() { this.readers = new Map(); this.missing = new Map(); }

  async locate(threadId) {
    for (const folder of ['sessions', 'archived_sessions']) {
      const found = await this.walk(path.join(codexHome, folder), threadId);
      if (found) return found;
    }
    return null;
  }

  async walk(directory, threadId) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
    const file = entries.find((entry) => entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`));
    if (file) return path.join(directory, file.name);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = await this.walk(path.join(directory, entry.name), threadId);
      if (match) return match;
    }
    return null;
  }

  async engine(threadId) {
    let reader = this.readers.get(threadId);
    if (!reader) {
      if (Date.now() - (this.missing.get(threadId) ?? 0) < 1500) return null;
      const file = await this.locate(threadId);
      if (!file) { this.missing.set(threadId, Date.now()); return null; }
      reader = new RolloutReader(file, threadId);
      this.readers.set(threadId, reader);
    }
    try { return await reader.poll(); }
    catch (error) {
      if (error.code === 'ENOENT') { this.readers.delete(threadId); return null; }
      throw error;
    }
  }
}

// Reserve a loopback-only random port for Electron. No browser-debugging port is exposed to the LAN.
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function jsonAt(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`Debugger HTTP ${response.status}`);
  return response.json();
}

async function run() {
  await mkdir(runtime, { recursive: true });
  try { console.log(JSON.stringify(await control('status'))); return; } catch { /* Start one helper only. */ }
  const source = await readFile(path.join(root, 'renderer.js'), 'utf8');
  const codexExecutable = args.includes('--codex') ? flag('--codex') : null;
  if (!codexExecutable) throw new Error('Start with start.ps1 so the installed Codex executable is resolved correctly');
  const pages = new Map();
  const sessions = new Sessions();
  let stopping = false;
  let port = null;
  let codexPid = Number(args.includes('--existing-pid') ? flag('--existing-pid') : 0);
  let phase = 'starting';
  let discoverAt = 0;
  let lastError = null;

  // Persist one local control secret; it never enters diagnostics, page scripts or Git.
  try { await writeFile(controlTokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const controlToken = (await readFile(controlTokenPath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(controlToken)) throw new Error('Invalid local control secret');

  // Status contains only numeric metrics, model IDs and thread IDs, never conversation content.
  const status = () => ({ phase, pid: process.pid, codexPid, port, error: lastError,
    windows: [...pages.values()].map((page) => ({ id: page.id, ...page.context, metrics: page.metrics ?? null })) });
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      let request;
      try { request = JSON.parse(input); } catch { socket.end('{"error":"invalid-command"}'); return; }
      input = '';
      if (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token)
        || !timingSafeEqual(Buffer.from(request.token), Buffer.from(controlToken))) {
        socket.end('{"error":"unauthorized"}');
        return;
      }
      const { command } = request;
      if (command === 'stop') {
        stopping = true;
        socket.end(JSON.stringify({ phase: 'stopping' }));
      } else if (command === 'diagnostics') {
        Promise.allSettled([...pages.values()].map(async (page) => ({ id: page.id, view: await page.diagnostics() })))
          .then((results) => socket.end(JSON.stringify({ ...status(), views: results.map((entry) => entry.status === 'fulfilled' ? entry.value : null) })));
      } else socket.end(JSON.stringify(status()));
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(controlPath, resolve); });
  const stopSignal = () => { stopping = true; };
  process.on('SIGINT', stopSignal);
  process.on('SIGTERM', stopSignal);

  try {
    // Reuse only our saved debugger endpoint for the same still-running Codex process.
    try {
      const previous = JSON.parse(await readFile(connectionPath, 'utf8'));
      if (previous.codexPid === codexPid && alive(codexPid) && previous.executable === codexExecutable) {
        await jsonAt(previous.port, '/json/version');
        port = previous.port;
      }
    } catch { /* A normal Codex launch has no debugger endpoint yet. */ }
    if (!port && codexPid && alive(codexPid)) {
      phase = 'waiting-for-restart';
      await log(phase);
      // A normal user exit is required. No active task or draft is forcibly closed.
      while (!stopping && alive(codexPid)) await pause(500);
    }
    if (stopping) return;
    if (!port) {
      port = await freePort();
      const child = spawn(codexExecutable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
        { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (error) => { lastError = error.message; stopping = true; });
      codexPid = child.pid;
      child.unref();
      await writeFile(connectionPath, JSON.stringify({ port, codexPid, executable: codexExecutable }));
      phase = 'waiting-for-debugger';
      const deadline = Date.now() + 60000;
      while (!stopping) {
        try { await jsonAt(port, '/json/version'); break; } catch { /* Electron may still be starting. */ }
        if (!alive(codexPid) || Date.now() > deadline) throw new Error('Codex did not expose the local debugger; restart through the provided launcher');
        await pause(500);
      }
    }
    phase = 'attached';
    await log(phase, { port, codexPid });

    // Poll tails at 500 ms and discover page targets every two seconds. Rendering occurs on change.
    while (!stopping) {
      if (!alive(codexPid)) break;
      if (Date.now() >= discoverAt) {
        discoverAt = Date.now() + 2000;
        try {
          const targets = await jsonAt(port, '/json/list');
          const present = new Set();
          for (const info of targets) {
            if (info.type !== 'page' || !info.webSocketDebuggerUrl) continue;
            if (!/^(?:file:|app:|codex:|https?:\/\/localhost|https?:\/\/127\.0\.0\.1)/i.test(info.url)) continue;
            present.add(info.id);
            if (pages.has(info.id) && !pages.get(info.id).closed) continue;
            const page = new PageAttachment(info, source, (item) => {
              log('context', { window: item.id, ...item.context }).catch(() => {});
            });
            try { await page.attach(); pages.set(info.id, page); }
            catch (error) { await page.detach().catch(() => {}); await log('page-attach-failed', { error: error.message }); }
          }
          for (const [id, page] of pages) if (!present.has(id) || page.closed) {
            await page.detach().catch(() => {});
            pages.delete(id);
          }
          lastError = null;
        } catch (error) { lastError = error.message; }
      }
      const engines = new Map();
      for (const page of pages.values()) {
        const context = page.context;
        if (!context?.mounted || !context.threadId || page.closed) continue;
        try {
          if (!engines.has(context.threadId)) engines.set(context.threadId, await sessions.engine(context.threadId));
          if (page.context !== context) continue;
          const engine = engines.get(context.threadId);
          const cacheKey = `${engine?.revision ?? -1}|${context.threadId}|${context.modelLabel}`;
          if (page.metricsKey !== cacheKey) {
            page.metrics = engine?.snapshot(context.modelLabel) ?? { threadId: context.threadId, model: null, current: null, mean: null, cache: null, samples: 0 };
            page.metricsKey = cacheKey;
          }
          await page.update(page.metrics, context);
        } catch (error) { lastError = error.message; }
      }
      await pause(500);
    }
  } finally {
    phase = 'stopping';
    await Promise.allSettled([...pages.values()].map((page) => page.detach()));
    server.close();
    await log('stopped');
  }
}

// CLI inspection can verify real local records without starting or restarting Codex.
try {
  if (args[0] === 'start') await run();
  else if (args[0] === 'inspect' && args[1]) {
    const engine = await new Sessions().engine(args[1]);
    console.log(JSON.stringify(engine?.snapshot() ?? { error: 'thread-not-found' }, null, 2));
  } else if (['status', 'stop', 'diagnostics'].includes(args[0])) {
    try { console.log(JSON.stringify(await control(args[0]), null, 2)); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) console.log(JSON.stringify({ phase: 'not-running' }));
      else throw error;
    }
  } else console.log('node main.mjs status | diagnostics | stop | inspect THREAD_ID');
} catch (error) {
  console.error(error.message);
  await log('error', { error: error.message }).catch(() => {});
  process.exitCode = 1;
}
