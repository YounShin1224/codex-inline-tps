import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins', 'codex-tps');
const dist = path.join(plugin, 'dist');
await mkdir(dist, { recursive: true });
const ui = await build({ entryPoints: [path.join(plugin, 'panel.mjs')], bundle: true, format: 'iife', platform: 'browser',
  minify: true, write: false, legalComments: 'none', target: 'es2022' });
const template = await readFile(path.join(plugin, 'panel.html'), 'utf8');
await writeFile(path.join(dist, 'panel.html'), template.replace('/* __PANEL_SCRIPT__ */', () => ui.outputFiles[0].text.replaceAll('</script', '<\\/script')));
await build({ entryPoints: [path.join(plugin, 'entry.mjs')], outfile: path.join(dist, 'server.mjs'), bundle: true,
  platform: 'node', format: 'esm', target: 'node24', legalComments: 'linked',
  banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' } });
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = [];
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location.startsWith('node_modules/')) continue;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'COPYING']) {
    try {
      const text = await readFile(path.join(root, location, name), 'utf8');
      notices.push(`${location.replace(/^node_modules\//, '')} ${info.version}\n${text}`);
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await writeFile(path.join(dist, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
console.log('Built native Codex TPS plugin in plugins/codex-tps/dist');
