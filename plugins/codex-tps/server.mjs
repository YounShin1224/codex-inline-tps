import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { SessionStore } from './session-store.mjs';

export const PANEL_URI = 'ui://codex-tps/panel.html';
const id = z.string().uuid();
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createTpsServer({ store = new SessionStore(), html } = {}) {
  const server = new McpServer({ name: 'codex-tps', title: 'Codex TPS', version: '0.1.0' });
  registerAppResource(server, 'codex-tps-panel', PANEL_URI, { description: 'Local Codex throughput panel' }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }],
  }));

  registerAppTool(server, 'open_codex_tps', {
    title: 'Codex TPS',
    description: 'Open the native Codex TPS panel. Pass the exact current local thread UUID to bind it; if unknown, open unbound and let the user select. Never guess the most recently active chat.',
    inputSchema: { threadId: id.optional() },
    annotations: readOnly,
    _meta: { ui: { resourceUri: PANEL_URI }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, async ({ threadId }) => ({ content: [], structuredContent: threadId
    ? await store.snapshot(threadId) : { state: 'unbound', threadId: null } }));

  registerAppTool(server, 'read_codex_tps', {
    title: 'Read bound Codex TPS',
    description: 'Read numeric metrics for one explicitly selected local thread.',
    inputSchema: { threadId: id, model: z.string().max(100).optional() }, annotations: readOnly,
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
  }, async ({ threadId, model }) => ({ content: [], structuredContent: await store.snapshot(threadId, model) }));

  registerAppTool(server, 'list_codex_tps_sessions', {
    title: 'List local Codex session IDs', description: 'List recent local thread IDs and last update times for explicit selection. No conversation content.',
    inputSchema: {}, annotations: readOnly,
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
  }, async () => ({ content: [], structuredContent: { sessions: await store.list() } }));
  return server;
}
