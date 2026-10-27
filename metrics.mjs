import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

// Only numeric metadata is retained. Conversation text and tool arguments are discarded.
const MODEL_ITEM_TYPES = new Set(['Reasoning', 'AgentMessage']);
const MIN_SAMPLE_MS = 1000;
const compact = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const millis = (value) => typeof value === 'number' ? value : Date.parse(value);
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

// Overlapping output items contribute their interval union, never duplicated time.
export function unionDuration(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .map((entry) => [...entry]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [start, finish] of sorted) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
}

// A record is attached to one thread and one turn; unrelated/subagent usage cannot leak in.
export class SessionMetrics {
  constructor(threadId) {
    this.threadId = threadId;
    this.turns = new Map();
    this.sequence = 0;
    this.revision = 0;
    this.latestModel = null;
    this.modelTimestamp = -Infinity;
    this.activeTurn = null;
    this.warnings = new Set();
    this.contexts = [];
    this.usageOwners = new Map();
  }

  turn(id) {
    if (!this.turns.has(id)) this.turns.set(id, {
      id, rootId: id, model: null, items: new Map(), usage: new Map(), phase: [], started: null, finished: null,
    });
    return this.turns.get(id);
  }

  ingest(record) {
    const p = record?.payload;
    if (!p || typeof p !== 'object') return;
    const timestamp = millis(record.timestamp);
    if (!Number.isFinite(timestamp)) return;
    if (p.thread_id && p.thread_id !== this.threadId) return;
    const implicitContext = record.type === 'response_item'
      ? this.contexts.filter((entry) => entry.timestamp <= timestamp).sort((a, b) => b.timestamp - a.timestamp)[0]?.turnId
      : null;
    const turnId = p.turn_id ?? (record.type === 'event_msg' ? p.turn_attribution?.turn_id : null) ?? implicitContext;
    if (!turnId || typeof turnId !== 'string') return;
    const turn = this.turn(turnId);
    const rootId = p.root_turn_id ?? p.turn_attribution?.root_turn_id;
    if (typeof rootId === 'string') turn.rootId = rootId;
    const sequence = this.sequence++;

    // Model attribution belongs to the turn, so a switch never rewrites old samples.
    if (record.type === 'turn_context' && typeof p.model === 'string') {
      turn.model = p.model;
      this.contexts.push({ timestamp, turnId });
      if (timestamp >= this.modelTimestamp) {
        this.latestModel = p.model;
        this.modelTimestamp = timestamp;
      }
    } else if (record.type === 'event_msg' && p.type === 'task_started') {
      turn.started = Math.min(turn.started ?? Infinity, timestamp);
      turn.phase.push({ timestamp, sequence, kind: 'start' });
    } else if (record.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) {
      turn.finished = Math.max(turn.finished ?? -Infinity, timestamp);
      turn.phase.push({ timestamp, sequence, kind: 'finish' });
    } else if (record.type === 'event_msg' && p.type === 'item_completed' && MODEL_ITEM_TYPES.has(p.item?.type)) {
      const start = number(p.started_at_ms);
      const end = number(p.completed_at_ms);
      if (start !== null && end !== null && end >= start && typeof p.item.id === 'string') {
        const old = turn.items.get(p.item.id);
        if (old && (old[0] !== start || old[1] !== end)) this.warnings.add('conflicting-item');
        else turn.items.set(p.item.id, [start, end]);
      }
    } else if (record.type === 'token_usage_record' && typeof p.response_id === 'string') {
      const owner = this.usageOwners.get(p.response_id);
      if (owner && owner !== turnId) { this.warnings.add('duplicate-cross-turn'); return; }
      this.usageOwners.set(p.response_id, turnId);
      const usage = p.usage ?? {};
      const entry = {
        responseId: p.response_id, timestamp,
        output: number(usage.output_tokens), input: number(usage.input_tokens),
        cached: number(usage.cached_input_tokens), reasoning: number(usage.reasoning_output_tokens),
      };
      const old = turn.usage.get(p.response_id);
      if (old) {
        const fields = ['output', 'input', 'cached', 'reasoning'];
        if (fields.some((key) => old[key] !== entry[key])) {
          old.conflict = true;
          this.warnings.add('conflicting-usage');
        }
        old.timestamp = Math.min(old.timestamp, entry.timestamp);
      } else turn.usage.set(p.response_id, entry);
    } else if (record.type === 'response_item' && ['custom_tool_call', 'function_call'].includes(p.type)) {
      turn.phase.push({ timestamp, sequence, kind: 'tool-start', callId: p.call_id });
    } else if (record.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(p.type)) {
      turn.phase.push({ timestamp, sequence, kind: 'tool-end', callId: p.call_id });
    } else return;
    this.revision++;
  }

  // UI labels are matched only to this thread's known model IDs, with effort words allowed.
  resolveModel(label) {
    if (!label) return this.latestModel;
    const value = compact(label);
    const efforts = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', '低', '中', '高', '极高']);
    return [...new Set([...this.turns.values()].map((turn) => turn.model).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .find((model) => value.startsWith(compact(model)) && efforts.has(value.slice(compact(model).length))) ?? null;
  }

  // Recompute by event timestamps, allowing a late/out-of-order item to repair its own sample.
  snapshot(modelLabel = null) {
    const model = this.resolveModel(modelLabel);
    const samples = [];
    let latestResponse = null;
    let rejected = 0;
    const turns = [...this.turns.values()];
    for (const turn of turns) {
      const usages = [...turn.usage.values()].sort((a, b) => a.timestamp - b.timestamp || a.responseId.localeCompare(b.responseId));
      let boundary = turn.started ?? -Infinity;
      for (let index = 0; index < usages.length; index++) {
        const usage = usages[index];
        const ambiguousTime = usages.some((other, otherIndex) => otherIndex !== index && other.timestamp === usage.timestamp);
        const allItems = [...turn.items.values()];
        const crossing = allItems.some(([a, b]) => a < boundary && b > boundary && b <= usage.timestamp);
        const windows = allItems.filter(([a, b]) => a >= boundary && b <= usage.timestamp && b > boundary);
        const duration = unionDuration(windows);
        const valid = !usage.conflict && !ambiguousTime && !crossing && usage.output > 0
          && duration >= MIN_SAMPLE_MS && (usage.reasoning === null || (usage.reasoning >= 0 && usage.reasoning <= usage.output));
        if (turn.model === model && model) {
          const response = { ...usage, duration, valid, model };
          if (!latestResponse || usage.timestamp > latestResponse.timestamp) latestResponse = response;
          if (valid) samples.push(response);
          else rejected++;
        }
        boundary = usage.timestamp;
      }
    }
    samples.sort((a, b) => a.timestamp - b.timestamp);

    // Estimates use only completed valid responses from this thread and this model.
    const weighted = (entries) => entries.length
      ? entries.reduce((sum, entry) => sum + entry.output, 0) * 1000 / entries.reduce((sum, entry) => sum + entry.duration, 0)
      : null;
    const active = turns.filter((turn) => turn.started !== null).sort((a, b) => b.started - a.started)[0];
    const running = Boolean(active && (active.finished === null || active.finished < active.started));
    const calls = new Set();
    if (active) for (const event of [...active.phase].sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence)) {
      if (event.kind === 'start' || event.kind === 'finish') calls.clear();
      if (event.kind === 'tool-start' && event.callId) calls.add(event.callId);
      if (event.kind === 'tool-end') calls.delete(event.callId);
    }
    const estimating = Boolean(running && active.model === model && calls.size === 0);
    const latestValid = latestResponse?.valid ? latestResponse : null;
    // Cache is weighted over the current root turn, including every main-chat model/tool follow-up.
    // A new turn starts empty; duplicate response IDs were already removed while ingesting usage.
    const cacheTurn = active ?? turns.filter((turn) => turn.usage.size).sort((a, b) =>
      Math.max(...b.usage.values().map((entry) => entry.timestamp)) - Math.max(...a.usage.values().map((entry) => entry.timestamp)))[0];
    const cacheTurnId = cacheTurn?.rootId ?? null;
    const cacheUsages = cacheTurnId ? turns.filter((turn) => turn.rootId === cacheTurnId).flatMap((turn) => [...turn.usage.values()]) : [];
    const cacheComplete = cacheUsages.length > 0 && cacheUsages.every((usage) => !usage.conflict
      && usage.input !== null && usage.cached !== null && usage.input >= 0 && usage.cached >= 0 && usage.cached <= usage.input);
    const cacheInputTokens = cacheComplete ? cacheUsages.reduce((sum, usage) => sum + usage.input, 0) : null;
    const cacheHitTokens = cacheComplete ? cacheUsages.reduce((sum, usage) => sum + usage.cached, 0) : null;
    const cache = cacheInputTokens > 0 ? cacheHitTokens / cacheInputTokens * 100 : null;
    return {
      threadId: this.threadId, model, running, estimating,
      phase: running ? (calls.size ? 'tool' : 'generating') : 'idle',
      current: estimating ? weighted(samples.slice(-5)) : latestValid ? latestValid.output * 1000 / latestValid.duration : null,
      mean: weighted(samples), cache, samples: samples.length, rejected,
      cacheTurnId, cacheRequests: cacheUsages.length, cacheInputTokens, cacheHitTokens, cacheComplete,
      lastSampleAt: latestValid?.timestamp ?? null, lastDurationMs: latestValid?.duration ?? null,
      warnings: [...this.warnings],
    };
  }
}

// Read appended UTF-8 JSONL without breaking multibyte characters or consuming unfinished lines.
export class RolloutReader {
  constructor(path, threadId) {
    this.path = path;
    this.threadId = threadId;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
    this.engine = new SessionMetrics(this.threadId);
    this.identity = null;
  }

  async poll() {
    const info = await stat(this.path);
    const identity = `${info.dev}:${info.ino}`;
    if ((this.identity && identity !== this.identity) || info.size < this.offset) this.reset();
    this.identity = identity;
    if (info.size === this.offset) return this.engine;
    const handle = await open(this.path, 'r');
    try {
      const buffer = Buffer.alloc(256 * 1024);
      while (this.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const text = this.pending + this.decoder.write(buffer.subarray(0, bytesRead));
        const lines = text.split('\n');
        this.pending = lines.pop();
        for (const line of lines) {
          try { this.engine.ingest(JSON.parse(line)); }
          catch { this.engine.warnings.add('invalid-json-line'); }
        }
      }
    } finally { await handle.close(); }
    return this.engine;
  }
}
