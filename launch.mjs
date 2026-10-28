import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDirectory, resolveMacApp } from './platform.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(root, 'main.mjs');
const args = process.argv.slice(2);

function invoke(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [main, command], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`TPS ${command} failed (${code})`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid helper reply')); }
    });
  });
}

try {
  if (process.platform !== 'darwin') throw new Error('This launcher is for macOS; use start.ps1 on Windows.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  if (args[0] === 'start') {
    const status = await invoke('status');
    if (status.phase !== 'not-running') {
      console.log(`TPS helper: ${status.phase}`);
    } else {
      const index = args.indexOf('--app');
      if (index !== -1 && !args[index + 1]) throw new Error('--app requires a .app path');
      const app = await resolveMacApp({ app: index === -1 ? process.env.CODEX_TPS_APP : args[index + 1] });
      const runtime = path.join(root, '.runtime');
      await privateDirectory(runtime);
      const log = await open(path.join(runtime, 'launcher.log'), 'a', 0o600);
      try {
        // A detached helper survives Terminal/Finder closing. No login item or launch agent is installed.
        const child = spawn(process.execPath, [main, 'start', '--codex', app.executable, '--existing-pid', String(app.pid)],
          { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        let started;
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          started = await invoke('status');
          if (started.phase !== 'not-running') break;
        }
        if (!started || started.phase === 'not-running') throw new Error('TPS helper did not start; see .runtime/launcher.log');
        console.log(`TPS helper: ${started.phase}`);
        if (app.pid) console.log('Codex is running. When your work is saved, quit it normally with Cmd+Q; TPS will reopen it automatically.');
        console.log('Status: node main.mjs status | Stop: node launch.mjs stop');
      } finally { await log.close(); }
    }
  } else if (['stop', 'status', 'diagnostics'].includes(args[0])) {
    console.log(JSON.stringify(await invoke(args[0]), null, 2));
  } else throw new Error('Usage: node launch.mjs start [--app /path/to/Codex.app] | stop | status | diagnostics');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
