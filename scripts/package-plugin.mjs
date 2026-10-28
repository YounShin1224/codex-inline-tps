import { mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/package-plugin.mjs /absolute/path/to/package-folder');
const destination = path.resolve(process.argv[2]);
const source = path.join(root, 'plugins/codex-tps');
for (const file of ['server.mjs', 'panel.html', 'THIRD_PARTY_NOTICES.txt']) await access(path.join(source, 'dist', file));
await mkdir(path.join(destination, 'plugins/codex-tps/dist'), { recursive: true });
await mkdir(path.join(destination, '.agents/plugins'), { recursive: true });
for (const file of ['plugin.json', 'mcp.json', 'README.md', 'dist/server.mjs', 'dist/panel.html', 'dist/THIRD_PARTY_NOTICES.txt']) {
  await copyFile(path.join(source, file), path.join(destination, 'plugins/codex-tps', file));
}
await copyFile(path.join(root, '.agents/plugins/marketplace.json'), path.join(destination, '.agents/plugins/marketplace.json'));
await copyFile(path.join(root, 'LICENSE'), path.join(destination, 'plugins/codex-tps/LICENSE'));
await copyFile(path.join(source, 'README.md'), path.join(destination, 'README.md'));
console.log(`Packaged native Codex TPS marketplace: ${destination}`);
