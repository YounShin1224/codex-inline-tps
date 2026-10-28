import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTpsServer } from './server.mjs';

try {
  const html = await readFile(new URL('./panel.html', import.meta.url), 'utf8');
  const server = createTpsServer({ html });
  await server.connect(new StdioServerTransport());
} catch (error) { console.error('Codex TPS could not start:', error.message); process.exitCode = 1; }
