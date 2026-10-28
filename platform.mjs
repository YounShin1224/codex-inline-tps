import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execute = promisify(execFile);
export const isAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// ps comm has no argument parsing or shell quoting, even when the .app path contains spaces.
export function parseMacProcesses(output) {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    return match ? [{ pid: Number(match[1]), executable: match[2] }] : [];
  });
}

// Validate the bundle ID: ChatGPT.app is also the name of current Codex distributions.
export async function resolveMacApp({ app, home = os.homedir(), exec = execute } = {}) {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm=']);
  const processes = parseMacProcesses(stdout);
  let candidates;
  if (app) {
    const expanded = app.startsWith('~/') ? path.join(home, app.slice(2)) : path.resolve(app);
    candidates = [expanded.includes('.app/Contents/MacOS/') ? expanded.split('/Contents/MacOS/')[0] : expanded];
  } else {
    candidates = processes.map((entry) => entry.executable.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1]).filter(Boolean);
    for (const directory of ['/Applications', path.join(home, 'Applications')]) {
      candidates.push(path.join(directory, 'Codex.app'), path.join(directory, 'ChatGPT.app'));
    }
    // Spotlight also finds user-installed/renamed bundles without crawling the filesystem.
    try {
      const result = await exec('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "com.openai.codex"']);
      candidates.push(...result.stdout.trim().split('\n').filter(Boolean));
    } catch { /* Spotlight can be unavailable; standard paths still work. */ }
  }
  for (const candidate of new Set(candidates)) {
    try {
      const bundle = await realpath(candidate);
      const plist = path.join(bundle, 'Contents', 'Info.plist');
      const id = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
      if (id.stdout.trim() !== 'com.openai.codex') continue;
      const name = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist])).stdout.trim();
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue;
      const executable = path.join(bundle, 'Contents', 'MacOS', name);
      await access(executable);
      const running = [];
      for (const entry of processes.filter((entry) => entry.executable.endsWith(`/Contents/MacOS/${name}`))) {
        // /var and /private/var (or a symlinked Applications folder) identify the same executable.
        if (entry.executable === executable || await realpath(entry.executable).catch(() => null) === executable) running.push(entry);
      }
      return { bundle, executable, pid: running[0]?.pid ?? 0 };
    } catch { /* Skip missing, unreadable or non-Codex bundles. */ }
  }
  throw new Error('Codex desktop app not found (bundle ID com.openai.codex). Use --app /path/to/Codex.app or CODEX_TPS_APP.');
}

// Darwin sun_path is only 104 bytes; never put the socket below a long checkout/TMPDIR.
export function controlEndpoint(root, platform = process.platform, home = os.homedir(), uid = process.getuid?.() ?? 0) {
  const userKey = createHash('sha256').update(home).digest('hex').slice(0, 16);
  if (platform === 'win32') return { socket: `\\\\.\\pipe\\codex-inline-tps-${userKey}`, directory: null };
  const key = createHash('sha256').update(`${home}\0${root}`).digest('hex').slice(0, 16);
  const directory = path.join('/tmp', `codex-inline-tps-${uid}-${key}`);
  return { socket: path.join(directory, 'control.sock'), directory };
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe local runtime directory');
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

// Serialize startup before removing a socket left by a crash. A live helper is never displaced.
export async function acquireRuntimeLock(runtime) {
  const directory = path.join(runtime, 'helper.lock');
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error('Unsafe helper lock directory');
    const pid = Number(await readFile(path.join(directory, 'pid'), 'utf8').catch(() => ''));
    if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) throw new Error('A TPS helper is already starting or running; retry shortly.');
    const reclaim = path.join(directory, 'reclaim');
    await writeFile(reclaim, String(process.pid), { flag: 'wx', mode: 0o600 });
    // Recheck after claiming: another contender may have already replaced the stale lock.
    const owner = Number(await readFile(path.join(directory, 'pid'), 'utf8'));
    if (owner !== pid || isAlive(owner)) {
      await rm(reclaim);
      throw new Error('A TPS helper is already starting or running; retry shortly.');
    }
    await rm(directory, { recursive: true });
    await mkdir(directory, { mode: 0o700 });
  }
  await writeFile(path.join(directory, 'pid'), String(process.pid), { mode: 0o600 });
  return () => rm(directory, { recursive: true, force: true });
}
