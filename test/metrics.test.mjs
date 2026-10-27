import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionMetrics, RolloutReader, unionDuration } from '../metrics.mjs';

// Fixtures carry explicit times and exact token totals, so every expected rate can be hand-checked.
const thread = '11111111-1111-4111-8111-111111111111';
const modelA = 'gpt-6.1-sol';
const modelB = 'gpt-6.1-terra';
const at = (time, type, payload) => ({ timestamp: new Date(time).toISOString(), type, payload });
const context = (id, model, time) => at(time, 'turn_context', { turn_id: id, model });
const event = (id, type, time, extra = {}) => at(time, 'event_msg', { turn_id: id, thread_id: thread, type, ...extra });
const item = (turn, id, start, end, kind = 'AgentMessage') => event(turn, 'item_completed', end, { item: { id, type: kind }, started_at_ms: start, completed_at_ms: end });
const usage = (turn, id, time, output = 400, input = 1000, cached = 905) => at(time, 'token_usage_record', {
  thread_id: thread, turn_id: turn, response_id: id,
  usage: { output_tokens: output, input_tokens: input, cached_input_tokens: cached, reasoning_output_tokens: 100 },
});
function completed(engine, turn, model, start, duration, output, id = turn) {
  [event(turn, 'task_started', start), context(turn, model, start),
    item(turn, id, start + 100, start + 100 + duration), usage(turn, id, start + duration + 200, output),
    event(turn, 'task_complete', start + duration + 300)].forEach((entry) => engine.ingest(entry));
}

test('union merges overlap but keeps tool gaps out of the denominator', () => {
  assert.equal(unionDuration([[0, 2000], [1000, 4000], [9000, 10000], [7, 3]]), 5000);
});

test('official output includes reasoning; weighted mean is not the arithmetic mean of rates', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'a', modelA, 0, 2000, 400);
  completed(engine, 'b', modelA, 10000, 4000, 1600);
  const result = engine.snapshot();
  assert.equal(result.current, 400);
  assert.equal(result.mean, 2000 / 6);
  assert.equal(result.cache, 90.5);
  assert.equal(result.samples, 2);
});

test('out-of-order completed items and overlapping reasoning remain attributable to their response', () => {
  const engine = new SessionMetrics(thread);
  [event('a', 'task_started', 0), context('a', modelA, 0), usage('a', 'r', 8000, 1000),
    item('a', 'm', 3000, 6000), item('a', 'reason', 1000, 4000, 'Reasoning'), event('a', 'task_complete', 9000)]
    .forEach((entry) => engine.ingest(entry));
  assert.equal(engine.snapshot().current, 200);
});

test('response IDs and alternate token_count carriers never double-count', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'a', modelA, 0, 2000, 400, 'shared');
  engine.ingest(usage('a', 'shared', 2300));
  engine.ingest(event('a', 'token_count', 2400, { info: { last_token_usage: { output_tokens: 400 } } }));
  engine.ingest(usage('b', 'shared', 5000));
  assert.equal(engine.snapshot().samples, 1);
  assert.equal(engine.snapshot().mean, 200);
});

test('conflicting duplicates and ambiguous timing are rejected instead of fabricated', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'a', modelA, 0, 2000, 400);
  engine.ingest(usage('a', 'a', 2200, 800));
  assert.equal(engine.snapshot().current, null);
  assert.equal(engine.snapshot().samples, 0);
  assert.ok(engine.snapshot().warnings.includes('conflicting-usage'));
  const other = new SessionMetrics(thread);
  [context('b', modelA, 0), item('b', 'x', 1000, 3000), usage('b', 'one', 4000), usage('b', 'two', 4000)]
    .forEach((entry) => other.ingest(entry));
  assert.equal(other.snapshot().samples, 0);
});

test('short, zero-output, missing-window and crossed-window responses do not affect the mean', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'ok', modelA, 0, 2000, 400);
  completed(engine, 'short', modelA, 10000, 999, 200);
  completed(engine, 'zero', modelA, 20000, 2000, 0);
  engine.ingest(context('missing', modelA, 30000));
  engine.ingest(usage('missing', 'none', 35000));
  assert.equal(engine.snapshot().samples, 1);
  assert.equal(engine.snapshot().mean, 200);
  assert.equal(engine.snapshot().current, null);
});

test('models and threads stay separate, including known UI names and an unknown selected model', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'a', modelA, 0, 2000, 400);
  completed(engine, 'b', modelB, 10000, 4000, 400);
  engine.ingest({ ...usage('bad', 'bad', 20000, 50000), payload: { ...usage('bad', 'bad', 20000).payload, thread_id: 'other' } });
  assert.equal(engine.snapshot().current, 100);
  assert.equal(engine.snapshot('GPT-6.1 Sol 高').current, 200);
  assert.equal(engine.snapshot('GPT-6.2 Future').model, null);
  assert.equal(new SessionMetrics('other').snapshot().current, null);
});

test('generation estimate uses the last five measured samples and never enters the mean', () => {
  const engine = new SessionMetrics(thread);
  for (let i = 0; i < 6; i++) completed(engine, String(i), modelA, i * 10000, 2000, (i + 1) * 200);
  [event('active', 'task_started', 70000), context('active', modelA, 70000)].forEach((entry) => engine.ingest(entry));
  const result = engine.snapshot();
  assert.equal(result.estimating, true);
  assert.equal(result.current, 400);
  assert.equal(result.mean, 350);
  assert.equal(result.samples, 6);
  engine.ingest(event('active', 'turn_aborted', 75000));
  assert.equal(engine.snapshot().estimating, false);
  assert.equal(engine.snapshot().mean, 350);
});

test('long tool waits are excluded, and implicit response_item context pauses estimates', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'a', modelA, 0, 2000, 400);
  [event('b', 'task_started', 10000), context('b', modelA, 10000),
    at(11000, 'response_item', { type: 'custom_tool_call', call_id: 'tool1' })].forEach((entry) => engine.ingest(entry));
  assert.equal(engine.snapshot().phase, 'tool');
  assert.equal(engine.snapshot().estimating, false);
  engine.ingest(at(61000, 'response_item', { type: 'custom_tool_call_output', call_id: 'tool1' }));
  assert.equal(engine.snapshot().estimating, true);
  engine.ingest(item('b', 'm', 62000, 64000));
  engine.ingest(usage('b', 'b', 65000, 400));
  engine.ingest(event('b', 'task_complete', 66000));
  assert.equal(engine.snapshot().current, 200);
});

test('zero-input calls do not change a turn cache rate; invalid counts make it unavailable', () => {
  const engine = new SessionMetrics(thread);
  completed(engine, 'a', modelA, 0, 2000, 400);
  engine.ingest(usage('a', 'new', 6000, 400, 0, 0));
  assert.equal(engine.snapshot().cache, 90.5);
  engine.ingest(usage('a', 'invalid', 7000, 400, 1000, 1001));
  assert.equal(engine.snapshot().cache, null);
});

test('whole-turn cache weights every request input instead of averaging percentages', () => {
  const engine = new SessionMetrics(thread);
  [event('a', 'task_started', 0), context('a', modelA, 0),
    usage('a', 'first', 2000, 400, 1000, 800), usage('a', 'second', 5000, 400, 9000, 9000)]
    .forEach((entry) => engine.ingest(entry));
  engine.ingest(usage('a', 'second', 5100, 400, 9000, 9000));
  assert.equal(engine.snapshot().cache, 98);
  assert.equal(engine.snapshot().cacheRequests, 2);
  assert.equal(engine.snapshot().cacheInputTokens, 10000);
  assert.equal(engine.snapshot().cacheHitTokens, 9800);
  engine.ingest(event('a', 'task_complete', 6000));
  assert.equal(engine.snapshot().cache, 98);
  engine.ingest(event('b', 'task_started', 10000));
  engine.ingest(context('b', modelA, 10000));
  assert.equal(engine.snapshot().cache, null);
  assert.equal(engine.snapshot().cacheRequests, 0);
});

test('incremental reader waits for complete JSONL lines and recovers after truncation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-tps-test-'));
  const file = path.join(directory, 'rollout.jsonl');
  try {
    const rows = [context('a', modelA, 0), item('a', 'm', 1000, 3000), usage('a', 'r', 4000)];
    const text = rows.map((row) => JSON.stringify(row) + '\n').join('');
    const last = text.lastIndexOf('\n');
    await writeFile(file, text.slice(0, last));
    const reader = new RolloutReader(file, thread);
    assert.equal((await reader.poll()).snapshot().samples, 0);
    await appendFile(file, '\n');
    assert.equal((await reader.poll()).snapshot().current, 200);
    await writeFile(file, '');
    assert.equal((await reader.poll()).snapshot().samples, 0);
    await writeFile(file, text);
    assert.equal((await reader.poll()).snapshot().samples, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing first sample does not invent a live TPS', () => {
  const engine = new SessionMetrics(thread);
  [context('a', modelA, 0), event('a', 'task_started', 0)].forEach((entry) => engine.ingest(entry));
  assert.equal(engine.snapshot().current, null);
  assert.equal(engine.snapshot().mean, null);
});

test('two responses with tool execution between their model windows retain separate numerators', () => {
  const engine = new SessionMetrics(thread);
  [event('a', 'task_started', 0), context('a', modelA, 0),
    item('a', 'one', 1000, 3000), usage('a', 'r1', 3100, 400),
    item('a', 'tool', 3200, 60000, 'CommandExecution'),
    item('a', 'two', 61000, 65000), usage('a', 'r2', 65100, 1600), event('a', 'task_complete', 66000)]
    .forEach((entry) => engine.ingest(entry));
  assert.equal(engine.snapshot().samples, 2);
  assert.equal(engine.snapshot().current, 400);
  assert.equal(engine.snapshot().mean, 2000 / 6);
});

test('an interval crossing a usage boundary is rejected rather than assigned twice', () => {
  const engine = new SessionMetrics(thread);
  [context('a', modelA, 0), item('a', 'one', 1000, 3000), usage('a', 'r1', 4000),
    item('a', 'crossed', 3900, 6000), usage('a', 'r2', 7000), event('a', 'task_complete', 8000)]
    .forEach((entry) => engine.ingest(entry));
  assert.equal(engine.snapshot().samples, 1);
  assert.equal(engine.snapshot().current, null);
});

test('UTF-8 characters split at an I/O boundary are decoded without corrupting JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-tps-utf8-'));
  const file = path.join(directory, 'rollout.jsonl');
  try {
    const ignored = JSON.stringify({ type: 'ignored', payload: { text: 'x'.repeat(262100) + '测试中文' } }) + '\n';
    const rows = [context('a', modelA, 0), item('a', 'm', 1000, 3000), usage('a', 'r', 4000)];
    await writeFile(file, ignored + rows.map((entry) => JSON.stringify(entry) + '\n').join(''));
    const engine = await new RolloutReader(file, thread).poll();
    assert.equal(engine.snapshot().samples, 1);
    assert.deepEqual(engine.snapshot().warnings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
