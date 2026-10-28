import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RolloutReader } from '../../metrics.mjs';

export const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// The API accepts a UUID, never a filesystem path. Directory symlinks are not followed.
export class SessionStore {
  constructor(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
    this.home = home;
    this.readers = new Map();
    this.missing = new Map();
    this.jobs = new Map();
  }

  async files(visitor) {
    let visited = 0;
    const walk = async (directory) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return; throw error; }
      for (const entry of entries) {
        if (++visited > 50000) return;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { const result = await walk(file); if (result) return result; }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const match = entry.name.match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
          if (match) { const result = await visitor(file, match[1].toLowerCase()); if (result) return result; }
        }
      }
    };
    for (const folder of ['sessions', 'archived_sessions']) {
      const result = await walk(path.join(this.home, folder));
      if (result) return result;
    }
    return null;
  }

  async list() {
    const recent = new Map();
    await this.files(async (file, threadId) => {
      const info = await stat(file).catch(() => null);
      if (!info) return;
      const entry = { threadId, modifiedAt: info.mtimeMs };
      if (!recent.has(threadId) || recent.get(threadId).modifiedAt < entry.modifiedAt) recent.set(threadId, entry);
    });
    // No session titles, prompts, replies, paths or auth files are exposed to the panel.
    return [...recent.values()].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 30);
  }

  async snapshot(threadId, model = null) {
    if (!THREAD_ID.test(threadId ?? '')) throw new Error('Invalid thread ID');
    const id = threadId.toLowerCase();
    // Serialize tail reads per file across several panel instances without sharing selection state.
    const previous = this.jobs.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.read(id, model));
    this.jobs.set(id, job);
    try { return await job; } finally { if (this.jobs.get(id) === job) this.jobs.delete(id); }
  }

  async read(threadId, model) {
    let reader = this.readers.get(threadId);
    if (!reader) {
      if (Date.now() - (this.missing.get(threadId) ?? 0) < 1500) return this.absent(threadId);
      const file = await this.files((file, id) => id === threadId ? file : null);
      if (!file) {
        this.missing.set(threadId, Date.now());
        if (this.missing.size > 128) this.missing.delete(this.missing.keys().next().value);
        return this.absent(threadId);
      }
      reader = new RolloutReader(file, threadId);
      this.readers.set(threadId, reader);
      if (this.readers.size > 8) this.readers.delete(this.readers.keys().next().value);
      this.missing.delete(threadId);
    }
    let engine;
    try { engine = await reader.poll(); }
    catch (error) {
      if (error.code === 'ENOENT') { this.readers.delete(threadId); return this.absent(threadId); }
      throw error;
    }
    const key = `${engine.revision}|${model ?? ''}`;
    if (reader.snapshotKey !== key || reader.snapshotEngine !== engine) {
      const models = [...new Set([...engine.turns.values()].map((turn) => turn.model).filter(Boolean))];
      const metrics = engine.snapshot(model);
      reader.snapshotValue = { ...metrics, models, found: true,
        state: metrics.current !== null ? 'ready' : 'waiting-for-measurable-response' };
      reader.snapshotKey = key;
      reader.snapshotEngine = engine;
    }
    return { ...reader.snapshotValue, observedAt: Date.now() };
  }

  absent(threadId) {
    return { threadId, found: false, state: 'session-not-found', model: null, models: [], current: null, mean: null,
      cache: null, samples: 0, observedAt: Date.now() };
  }
}
