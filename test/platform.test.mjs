import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireRuntimeLock, controlEndpoint, isAlive, parseMacProcesses, privateDirectory, resolveMacApp } from '../platform.mjs';

test('macOS process detection preserves spaces and excludes Electron helper processes', () => {
  const output = '  10 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n'
    + '11 /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper\n'
    + ' invalid\n';
  assert.deepEqual(parseMacProcesses(output), [
    { pid: 10, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 11, executable: '/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper' },
  ]);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(NaN), false);
  assert.equal(isAlive(process.pid), true);
});

test('bundle identity, not filename, selects Codex and its exact main process', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-platform-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bundle = path.join(temp, 'Renamed Codex.app');
  const executable = path.join(bundle, 'Contents', 'MacOS', 'ChatGPT');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, 'fixture');
  const calls = [];
  let identifier = 'com.openai.codex';
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (command === '/bin/ps') return { stdout: `19 ${executable} Helper\n42 ${executable}\n` };
    if (command === '/usr/bin/mdfind') return { stdout: '' };
    if (args.includes('Print :CFBundleIdentifier')) return { stdout: identifier + '\n' };
    if (args.includes('Print :CFBundleExecutable')) return { stdout: 'ChatGPT\n' };
    throw new Error('Unexpected command');
  };
  assert.deepEqual(await resolveMacApp({ app: bundle, exec }), { bundle: await realpath(bundle), executable: await realpath(executable), pid: 42 });
  assert.equal((await resolveMacApp({ app: executable, exec })).executable, await realpath(executable));
  assert.equal((await resolveMacApp({ exec })).pid, 42);
  const canonicalBundle = await realpath(bundle);
  assert.ok(calls.some((call) => call.args.at(-1) === path.join(canonicalBundle, 'Contents', 'Info.plist')));
  identifier = 'com.openai.chat';
  await assert.rejects(resolveMacApp({ app: bundle, exec }), /Codex desktop app not found/);
});

test('Unix control endpoint binds even when checkout and TMPDIR exceed Darwin path limits', async (t) => {
  const checkout = '/Users/example/Documents/' + 'long-project-name/'.repeat(15);
  const endpoint = controlEndpoint(checkout, 'darwin', '/Users/example');
  assert.ok(Buffer.byteLength(endpoint.socket) < 104);
  assert.notEqual(endpoint.socket, controlEndpoint(checkout + '-other', 'darwin', '/Users/example').socket);
  assert.notEqual(endpoint.socket, controlEndpoint(checkout, 'darwin', '/Users/another').socket);
  assert.match(controlEndpoint(checkout, 'win32').socket, /^\\\\\.\\pipe\\codex-inline-tps-/);
  if (process.platform === 'win32') return;
  await privateDirectory(endpoint.directory);
  const server = net.createServer((socket) => socket.end('ok'));
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(endpoint.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint.socket, resolve); });
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.socket);
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.equal(reply, 'ok');
  assert.equal((await lstat(endpoint.directory)).mode & 0o777, 0o700);
});

test('runtime lock serializes launches, releases cleanly and recovers a crashed helper', async (t) => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'codex-lock-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const release = await acquireRuntimeLock(runtime);
  await assert.rejects(acquireRuntimeLock(runtime), /already starting or running/);
  assert.equal(Number(await readFile(path.join(runtime, 'helper.lock', 'pid'), 'utf8')), process.pid);
  await release();
  await assert.rejects(access(path.join(runtime, 'helper.lock')), { code: 'ENOENT' });
  await mkdir(path.join(runtime, 'helper.lock'));
  await writeFile(path.join(runtime, 'helper.lock', 'pid'), '2147483647');
  const results = await Promise.allSettled([acquireRuntimeLock(runtime), acquireRuntimeLock(runtime)]);
  const acquired = results.filter((entry) => entry.status === 'fulfilled');
  assert.equal(acquired.length, 1);
  await acquired[0].value();
});

test('private runtime directories reject symlinks instead of changing their target permissions', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix permissions');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-private-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const target = path.join(temp, 'target');
  await mkdir(target);
  await chmod(target, 0o755);
  await symlink(target, path.join(temp, 'link'));
  await assert.rejects(privateDirectory(path.join(temp, 'link')), /Unsafe local runtime/);
  assert.equal((await lstat(target)).mode & 0o777, 0o755);
});
