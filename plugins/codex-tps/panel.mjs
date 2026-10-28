import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Codex TPS', version: '0.1.0' }, {}, { autoResize: false });
const $ = (id) => document.getElementById(id);
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const state = { threadId: null, model: '', connected: false, paused: false, inFlight: false, generation: 0, timer: null, disposed: false, points: [], lastSample: null };
let modelSignature = '';

function theme(context) {
  if (context?.theme) { applyDocumentTheme(context.theme); document.documentElement.dataset.theme = context.theme; }
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
function error(message = '') { $('error').textContent = message; }
function status(text, active = false) { $('status').textContent = text; $('status').dataset.active = String(active); }
function format(value) { return Number.isFinite(value) ? String(Math.round(value)) : '—'; }
function reset() {
  for (const id of ['current', 'mean', 'cache']) $(id).textContent = '—';
  $('kind').textContent = ''; $('hint').textContent = ''; $('updated').textContent = '';
  $('spark-path').setAttribute('d', ''); $('samples').textContent = '0 次有效测量';
  state.points = []; state.lastSample = null;
}
function draw() {
  const points = state.points;
  if (points.length < 2) { $('spark-path').setAttribute('d', ''); return; }
  const max = Math.max(1, ...points);
  const d = points.map((value, i) => `${i ? 'L' : 'M'}${(i / (points.length - 1) * 296 + 2).toFixed(2)},${(51 - value / max * 46).toFixed(2)}`).join(' ');
  $('spark-path').setAttribute('d', d);
}
function render(data) {
  if (!data || data.threadId !== state.threadId) return;
  $('empty').hidden = true; $('metrics').hidden = false; $('thread').textContent = `会话 ${data.threadId}`;
  $('current').textContent = format(data.current); $('mean').textContent = format(data.mean);
  let cache = '—';
  if (Number.isFinite(data.cache)) {
    const value = data.cache.toFixed(2);
    const full = data.cacheInputTokens > 0 && data.cacheHitTokens === data.cacheInputTokens;
    cache = `${value === '100.00' && !full ? '<100.00' : value}%`;
  }
  $('cache').textContent = cache;
  $('kind').textContent = data.estimating ? '生成中 · 历史样本估算' : data.current !== null ? '最近有效响应' : '等待有效样本';
  $('samples').textContent = `${data.samples ?? 0} 次有效测量`;
  $('updated').textContent = `更新于 ${new Date(data.observedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  const signature = JSON.stringify(data.models ?? []);
  if (signature !== modelSignature) {
    const options = [new Option('跟随最新请求', ''), ...(data.models ?? []).map((model) => new Option(model, model))];
    if (state.model && !options.some((option) => option.value === state.model)) options.push(new Option(state.model, state.model));
    $('model').replaceChildren(...options); $('model').value = state.model; modelSignature = signature;
  }
  $('hint').textContent = !data.found ? '找不到这个会话的本地记录，请确认会话 ID 或切换会话。'
    : data.current === null ? '还没有可测量的响应；缺少用量或计时的记录不会生成速度值。'
    : data.phase === 'tool' ? '工具运行中，保留最近一次有效响应的读数。'
    : data.estimating ? '当前值为历史估算，响应完成后修正。'
    : `最近有效输出区间 ${((data.lastDurationMs ?? 0) / 1000).toFixed(2)} 秒；${data.model ?? '等待模型记录'}。`;
  if (!data.estimating && Number.isFinite(data.current) && data.lastSampleAt && state.lastSample !== data.lastSampleAt) {
    state.lastSample = data.lastSampleAt; state.points.push(data.current); if (state.points.length > 30) state.points.shift(); draw();
  }
  status(state.paused ? '已暂停' : !data.found ? '未找到会话' : data.running ? data.phase === 'tool' ? '工具运行中' : '生成中' : '等待输入', data.running && !state.paused);
}
function schedule(delay = 1000) {
  clearTimeout(state.timer);
  if (!state.disposed && !state.paused && !document.hidden && state.threadId) state.timer = setTimeout(poll, delay);
}
async function poll() {
  if (state.disposed || state.paused || !state.connected || !state.threadId || document.hidden) return;
  if (state.inFlight) { schedule(250); return; }
  state.inFlight = true;
  const generation = state.generation;
  const args = { threadId: state.threadId, ...(state.model ? { model: state.model } : {}) };
  try {
    const result = await app.callServerTool({ name: 'read_codex_tps', arguments: args }, { timeout: 10000 });
    if (generation !== state.generation || state.disposed) return;
    if (result.isError) throw new Error('读取会话失败');
    render(result.structuredContent); error();
  } catch {
    if (generation !== state.generation || state.disposed) return;
    status('连接中断'); reset(); error('暂时无法刷新，正在重试。');
  } finally { state.inFlight = false; schedule(generation === state.generation ? 1000 : 0); }
}
function bind(threadId, initial = null) {
  if (!validId(threadId)) { error('请输入完整、有效的本地会话 ID。'); return; }
  state.generation++; state.threadId = threadId.toLowerCase(); state.model = ''; modelSignature = '';
  clearTimeout(state.timer); reset(); error();
  $('thread-input').value = state.threadId; $('binding').open = false;
  $('empty').hidden = true; $('metrics').hidden = false; $('thread').textContent = `会话 ${state.threadId}`;
  status('等待数据');
  if (initial) render(initial);
  schedule(initial ? 1000 : 0);
}
async function list() {
  $('reload').disabled = true;
  try {
    const result = await app.callServerTool({ name: 'list_codex_tps_sessions', arguments: {} }, { timeout: 15000 });
    if (result.isError) throw new Error('Cannot list');
    $('sessions').replaceChildren(new Option('选择最近更新的会话…', ''), ...(result.structuredContent?.sessions ?? []).map((entry) =>
      new Option(`${new Date(entry.modifiedAt).toLocaleString('zh-CN', { hour12: false })} · ${entry.threadId.slice(0, 8)}`, entry.threadId)));
  } catch { error('无法加载会话列表，可粘贴完整会话 ID 绑定。'); }
  finally { $('reload').disabled = false; }
}

// Each panel owns its selection and polling. No global 'latest chat' and no model-context writes.
app.ontoolresult = ({ structuredContent }) => {
  if (!state.threadId && validId(structuredContent?.threadId)) bind(structuredContent.threadId, structuredContent);
  else if (structuredContent?.threadId === state.threadId && !state.model) render(structuredContent);
};
app.ontoolinput = ({ arguments: args }) => { if (validId(args?.threadId) && !state.threadId) bind(args.threadId); };
app.onhostcontextchanged = theme;
app.onteardown = async () => { state.disposed = true; state.generation++; clearTimeout(state.timer); return {}; };
$('bind').onclick = () => bind($('thread-input').value.trim());
$('thread-input').onkeydown = (event) => { if (event.key === 'Enter') bind($('thread-input').value.trim()); };
$('sessions').onchange = () => { if ($('sessions').value) bind($('sessions').value); };
$('reload').onclick = list;
$('model').onchange = () => { state.generation++; state.model = $('model').value; reset(); status('等待数据'); schedule(0); };
$('pause').onclick = () => {
  state.paused = !state.paused; state.generation++; clearTimeout(state.timer);
  $('pause').textContent = state.paused ? '继续' : '暂停'; status(state.paused ? '已暂停' : '等待数据');
  if (!state.paused) schedule(0);
};
document.addEventListener('visibilitychange', () => { state.generation++; clearTimeout(state.timer); if (!document.hidden) schedule(0); });
window.addEventListener('pagehide', () => { state.disposed = true; state.generation++; clearTimeout(state.timer); });
async function connect() {
  try {
    await app.connect(); state.connected = true; $('pause').disabled = false;
    theme(app.getHostContext()); if (!state.threadId) status('未绑定会话');
    await list(); schedule(0);
  } catch { status('无法连接'); error('请在支持 MCP Apps 的 Codex 桌面端中打开此插件。'); }
}
connect();
