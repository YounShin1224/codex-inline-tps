import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTpsServer } from '../plugins/codex-tps/server.mjs';
import { Cdp } from '../cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('MCP Apps panel: actual bridge, isolated chats, live refresh, pause, theme, stale replies and teardown', { timeout: 45000 }, async (t) => {
  const candidates = [process.env.CODEX_TPS_TEST_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
  let executable;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) return t.skip('No test Chromium executable available');
  const profile = await mkdtemp(path.join(os.tmpdir(), 'codex-native-panel-'));
  const panel = await readFile(path.join(root, 'plugins/codex-tps/dist/panel.html'), 'utf8');
  let calls = 0, delay = false;
  const snapshot = async (threadId, model) => {
    calls++;
    if (delay && threadId === A) await sleep(700);
    return { threadId, model: model ?? 'gpt-6.1-sol', models: ['gpt-6.1-sol'], found: true, state: 'ready',
      current: threadId === A ? 200 : 75, mean: 180, cache: 99.9999, cacheInputTokens: 10000000, cacheHitTokens: 9999990,
      samples: 3, estimating: false, phase: 'idle', running: false, observedAt: Date.now(), lastSampleAt: 4000, lastDurationMs: 2000 };
  };
  const server = createTpsServer({ html: panel, store: { snapshot, list: async () => [{ threadId: A, modifiedAt: 2000 }, { threadId: B, modifiedAt: 1000 }] } });
  const client = new Client({ name: 'panel-host-test', version: '1.0.0' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  const host = `<!doctype html><style>body{margin:0;display:flex;background:#444}iframe{width:360px;height:950px;border:0;margin:8px}</style>
    <iframe id="a" src="/panel"></iframe><iframe id="b" src="/panel"></iframe><script>
    window.events=[]; window.initial={a:'${A}',b:'${B}'};
    addEventListener('message',async event=>{
      const frame=[...document.querySelectorAll('iframe')].find(f=>f.contentWindow===event.source);if(!frame)return;
      const request=event.data;if(request?.jsonrpc!=='2.0')return;events.push({frame:frame.id,method:request.method});
      const send=result=>event.source.postMessage({jsonrpc:'2.0',id:request.id,result},'*');
      if(request.method==='ui/initialize')send({protocolVersion:'2026-01-26',hostInfo:{name:'test-host',version:'1.0.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:'dark',displayMode:'fullscreen'}});
      else if(request.method==='ui/notifications/initialized'){
        const result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({name:'open_codex_tps',arguments:{threadId:initial[frame.id]}})})).json();
        event.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
      }else if(request.method==='tools/call')send(await(await fetch('/rpc',{method:'POST',body:JSON.stringify(request.params)})).json());
      else if(request.id!==undefined)send({});
    });</script>`;
  const httpServer = http.createServer(async (request, response) => {
    try {
      if (request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(await client.callTool(JSON.parse(body))));
      } else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(request.url === '/panel' ? panel : host); }
    } catch (error) { response.writeHead(500).end(JSON.stringify({ isError: true, content: [{ type: 'text', text: error.message }] })); }
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let browser, page;
  t.after(async () => {
    page?.close();
    if (browser) { await browser.call('Browser.close').catch(() => {}); browser.close(); }
    if (child.exitCode === null) child.kill();
    await client.close(); await server.close(); await new Promise((resolve) => httpServer.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const until = async (check, message) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
    throw new Error(message);
  };
  let port;
  await until(async () => { try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!port; } catch { return false; } }, 'No test browser');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = new Cdp(version.webSocketDebuggerUrl);
  const { targetId } = await browser.call('Target.createTarget', { url: origin });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  page = new Cdp(targets.find((target) => target.id === targetId).webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  const reading = (frame, id) => evaluate(`document.querySelector('#${frame}')?.contentDocument?.querySelector('#${id}')?.textContent`);
  await until(async () => await reading('a', 'current') === '200' && await reading('b', 'current') === '75', 'Native App did not receive initial tool results');
  assert.equal(await reading('a', 'cache'), '<100.00%');
  assert.equal(await evaluate('document.querySelector("#a").contentDocument.documentElement.dataset.theme'), 'dark');
  const before = calls; await sleep(1250); assert.ok(calls > before, 'Panel should refresh without model intervention');
  await evaluate(`for(const frame of document.querySelectorAll('iframe'))frame.contentDocument.querySelector('#pause').click();true`);
  await sleep(200); const paused = calls; await sleep(1200); assert.equal(calls, paused);
  await evaluate(`document.querySelector('#a').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'light'}},'*');true`);
  await until(async () => await evaluate('document.querySelector("#a").contentDocument.documentElement.dataset.theme') === 'light', 'Theme did not update');
  delay = true;
  await evaluate(`document.querySelector('#a').contentDocument.querySelector('#pause').click();true`);
  await sleep(150);
  await evaluate(`let d=document.querySelector('#a').contentDocument;d.querySelector('#thread-input').value='${B}';d.querySelector('#bind').click();true`);
  assert.equal(await reading('a', 'current'), '—', 'Selection changes must immediately clear old numbers');
  await until(async () => await reading('a', 'current') === '75', 'Stale reply overwrote new selection');
  assert.equal(await reading('b', 'current'), '75');
  assert.ok(!(await evaluate('events')).some((event) => ['ui/message', 'ui/update-model-context', 'sampling/createMessage'].includes(event.method)));
  const image = await page.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 752, height: 720, scale: 1 } });
  const preview = process.env.CODEX_TPS_TEST_PREVIEW || path.join(profile, 'native-panel-preview.png');
  await writeFile(preview, Buffer.from(image.data, 'base64'));
  console.log(`Native panel preview: ${preview}`);
  await evaluate(`for(const frame of document.querySelectorAll('iframe'))frame.contentWindow.postMessage({jsonrpc:'2.0',id:999,method:'ui/resource-teardown',params:{}},'*');true`);
  await sleep(200); const stopped = calls; await sleep(1200); assert.equal(calls, stopped, 'Teardown must stop polling');
});
