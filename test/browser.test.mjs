import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cdp, PageAttachment } from '../cdp.mjs';

// A dedicated headless browser profile tests the component without touching the user's app/profile.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const fixture = `<!doctype html><meta charset="utf-8"><style>
:root { --font-ui-family: "Segoe UI", sans-serif; --font-sans: var(--font-ui-family); --text-sm:13px; --color-text-secondary:#606060; }
body { margin:0; background:#f6f6f6; color:#171717; font-family:var(--font-sans); }
main { margin:30px auto; width:620px; } #outer { min-width:0; } #inner { background:white; border:1px solid #ddd; border-radius:18px; padding:14px; }
[contenteditable] { min-height:70px; outline:none; } footer {display:flex;justify-content:space-between;margin-top:8px;font-size:13px;}
[data-composer-footer-responsive] { display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;column-gap:5px; }
.input-cell {grid-row:1;grid-column:1/-1;} .left-controls{grid-row:2;grid-column:1;font-size:13px;}
footer{grid-row:2;grid-column:3;gap:6px;}
body.dark { background:#202020; color:#eee; --color-text-secondary:#aaa; } body.dark #inner{background:#292929;border-color:#444;}
</style><main><div id="outer" data-codex-composer-root><div id="inner" data-codex-composer-root><div data-composer-footer-responsive><div class="input-cell"><div contenteditable="true" aria-label="Message">测试输入框</div></div><span class="left-controls">完全访问</span><footer><button id="model">GPT-6.1 Sol</button><button id="send">发送</button></footer></div></div></div></main>
<script>let sends=0;document.querySelector('#send').onclick=()=>sends++;document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')sends++});</script>`;

async function findBrowser() {
  const candidates = [process.env.CODEX_TPS_TEST_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); return candidate; } catch {} }
  return null;
}

async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { if (!/Cannot find context|execution context/i.test(error.message)) throw error; }
    await sleep(100);
  }
  throw new Error(message);
}

test('inline rendering: center, font, themes, model/chat isolation, reload and clean removal', { timeout: 90000 }, async (t) => {
  const executable = await findBrowser();
  if (!executable) { t.skip('No test Chromium executable available'); return; }
  const profile = await mkdtemp(path.join(os.tmpdir(), 'codex-tps-browser-'));
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let browser;
  const pages = [];
  try {
    let port;
    await until(async () => {
      try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return Boolean(port); }
      catch { return false; }
    }, 'Headless browser did not start');
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browser = new Cdp(version.webSocketDebuggerUrl);
    const source = await readFile(path.join(root, 'renderer.js'), 'utf8');
    async function attach(thread) {
      const { targetId } = await browser.call('Target.createTarget', { url: `${origin}/local/${thread}` });
      let info;
      await until(async () => {
        info = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) => entry.id === targetId);
        return Boolean(info);
      }, 'No page target');
      const page = new PageAttachment(info, source, () => {});
      await page.attach();
      pages.push(page);
      await until(() => page.context?.mounted, 'Row did not mount');
      return page;
    }
    const pageA = await attach(A);
    const pageB = await attach(B);
    const evaluate = async (page, expression) => (await page.cdp.call('Runtime.evaluate', { expression, returnByValue: true })).result?.value;
    const reading = (threadId, current, modelLabel = 'GPT-6.1 Sol') => ({ threadId, model: 'gpt-6.1-sol', modelLabel,
      current, mean: 200, cache: 90.5, samples: 4, estimating: false, phase: 'idle' });
    await pageA.update(reading(A, 200));
    await pageB.update(reading(B, 75));
    let a = await pageA.diagnostics();
    let b = await pageB.diagnostics();
    assert.equal(a.text, '200tok/s·均值200·缓存90.50%');
    assert.equal(b.text, '75tok/s·均值200·缓存90.50%');
    assert.ok(a.visualCenterError < 0.5);
    assert.match(a.font, /Segoe UI/);
    assert.equal(a.fontSize, '13px');
    const before = await evaluate(pageA, 'document.querySelector("[data-codex-tps]").getBoundingClientRect().x');
    await pageA.update(reading(A, 9));
    assert.ok(Math.abs(await evaluate(pageA, 'document.querySelector("[data-codex-tps]").getBoundingClientRect().x') - before) < 0.5,
      'Changing the TPS digit count must not visibly shift the row (allow subpixel font rounding)');
    await pageA.update({ ...reading(A, 215), estimating: true, phase: 'generating' });
    assert.ok((await pageA.diagnostics()).text.startsWith('215tok/s'));

    // Native font/theme changes, narrower composers and multiline drafts preserve alignment.
    await evaluate(pageA, 'document.body.classList.add("dark");document.documentElement.style.setProperty("--font-ui-family","Arial");document.querySelector("main").style.width="360px";document.querySelector("[contenteditable]").innerText="one\\ntwo\\nthree";true');
    await until(async () => (await pageA.diagnostics())?.font.includes('Arial'), 'Font did not follow native CSS');
    const layout = await evaluate(pageA, '(()=>{let a=document.querySelector("[data-codex-tps]").getBoundingClientRect(),b=document.querySelector("#model").getBoundingClientRect();return {row:a.toJSON(),model:b.toJSON()}})()');
    assert.ok(Math.abs(layout.row.y + layout.row.height / 2 - layout.model.y - layout.model.height / 2) < 1
      && layout.row.right <= layout.model.left, JSON.stringify(layout));
    assert.equal(await evaluate(pageA, 'getComputedStyle(document.querySelector("[data-codex-tps]")).color'), 'rgb(170, 170, 170)');
    const dimensions = await pageA.cdp.call('Page.getLayoutMetrics');
    const image = await pageA.cdp.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: Math.min(dimensions.cssContentSize.width, 1000), height: 300, scale: 1 } });
    await writeFile(path.join(profile, 'inline-preview.png'), Buffer.from(image.data, 'base64'));
    console.log(`UI preview: ${path.join(profile, 'inline-preview.png')}`);

    // Pointer input and keyboard shortcuts are not captured; losing focus does not hide the row.
    const button = await evaluate(pageA, '(()=>{let r=document.querySelector("#send").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await pageA.cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button });
    await pageA.cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...button });
    assert.equal(await evaluate(pageA, 'sends'), 1);
    await evaluate(pageA, 'document.querySelector("[contenteditable]").focus()');
    await pageA.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
    await pageA.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(pageA, 'sends'), 2);
    await pageA.cdp.call('Emulation.setFocusEmulationEnabled', { enabled: false });
    assert.equal(await evaluate(pageA, 'document.querySelector("[data-codex-tps]").getClientRects().length'), 1);

    // A chat or picker switch clears the old numbers before new data can be delivered.
    await evaluate(pageA, `history.pushState({},'', '/local/${B}');dispatchEvent(new PopStateEvent('popstate'));true`);
    await until(() => pageA.context?.threadId === B, 'Thread context did not switch');
    assert.ok((await pageA.diagnostics()).text.startsWith('—tok/s'));
    await pageA.update(reading(A, 999));
    assert.ok((await pageA.diagnostics()).text.startsWith('—tok/s'));
    await pageA.update(reading(B, 75));
    assert.ok((await pageA.diagnostics()).text.startsWith('75tok/s'));
    await evaluate(pageA, 'document.querySelector("#model").textContent="GPT-6.1 Terra";true');
    await until(() => pageA.context?.modelLabel === 'GPT-6.1 Terra', 'Model context did not switch');
    assert.ok((await pageA.diagnostics()).text.startsWith('—tok/s'));

    // A native subtree replacement and full page reload each recreate exactly one row.
    await evaluate(pageB, 'document.querySelector("#outer").outerHTML=document.querySelector("#outer").outerHTML;true');
    await sleep(350);
    await until(async () => await evaluate(pageB, 'document.querySelectorAll("[data-codex-tps]").length') === 1, 'Remount created missing/duplicate rows');
    await pageB.cdp.call('Page.reload');
    await until(async () => pageB.world && pageB.context?.mounted && Boolean(await pageB.diagnostics()), 'Reload did not restore the row');
    assert.equal(await evaluate(pageB, 'document.querySelectorAll("[data-codex-tps]").length'), 1);
    await pageA.detach();
    assert.equal(await evaluate(pageA, 'document.querySelectorAll("[data-codex-tps]").length').catch(() => 0), 0);
    const verify = new Cdp(`ws://127.0.0.1:${port}/devtools/page/${pageA.id}`);
    assert.equal((await verify.call('Runtime.evaluate', { expression: 'document.querySelectorAll("[data-codex-tps]").length', returnByValue: true })).result.value, 0);
    verify.close();
  } finally {
    await Promise.allSettled(pages.map((page) => page.closed ? null : page.detach()));
    if (browser) { await browser.call('Browser.close').catch(() => {}); browser.close(); }
    if (child.exitCode === null) child.kill();
    server.close();
  }
});
