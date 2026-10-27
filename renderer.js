(function installCodexTps() {
  // This code lives in an isolated CDP world. It only reads identity/model controls and adds our row.
  if (window.top !== window || globalThis.__codexTps) return;
  if (!document.documentElement) {
    addEventListener('DOMContentLoaded', installCodexTps, { once: true });
    return;
  }
  const ID = 'codex-inline-tps-v1';
  const MODEL = /\b(?:gpt[\s-]?\d|o[134](?:\b|[\s-])|codex[\s-]|deepseek|claude|gemini|kimi)/i;
  const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
  let row = null;
  let anchor = null;
  let frame = null;
  let stopped = false;
  let lastContext = '';
  let lastStyle = '';
  let metrics = null;
  let values = [];

  // Route parsing is per renderer/window. No globally most-recent chat is ever substituted.
  const threadFromLocation = () => {
    for (const path of [location.pathname, location.hash.slice(1)]) {
      const match = decodeURIComponent(path).match(new RegExp(`/(?:local|threads|hotkey-window/thread)/(${UUID})(?:/|$|[?#])`, 'i'));
      if (match) return match[1].toLowerCase();
    }
    return null;
  };
  const visible = (element) => element.isConnected && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden';

  // Prefer the outer dedicated composer wrapper, placing the row outside its inner input card.
  function findComposer() {
    const editors = document.querySelectorAll('[data-codex-composer-root] [contenteditable="true"]');
    for (const editor of editors) {
      if (!visible(editor)) continue;
      let outer = editor.closest('[data-codex-composer-root]');
      let ancestor = outer?.parentElement?.closest('[data-codex-composer-root]');
      while (ancestor) {
        outer = ancestor;
        ancestor = outer.parentElement?.closest('[data-codex-composer-root]');
      }
      if (outer) return { outer, editor, nested: Boolean(outer.querySelector('[data-codex-composer-root]')) };
    }
    return null;
  }

  // Read only model-picker labels. Neither draft text nor reply contents are sent to the helper.
  function modelLabel(composer) {
    if (!composer) return null;
    const candidates = [...composer.outer.querySelectorAll('button, [role="combobox"]')];
    for (const element of candidates) {
      if (!visible(element)) continue;
      const text = element.innerText?.trim().replace(/\s+/g, ' ');
      if (text && text.length < 100 && MODEL.test(text)) return text;
    }
    return null;
  }

  // Stable grid tracks reserve space for every number. Content changes never reposition the group.
  function makeRow() {
    const element = document.createElement('div');
    element.id = ID;
    element.dataset.codexTps = 'true';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'off');
    element.style.cssText = 'display:block;box-sizing:border-box;width:100%;min-height:20px;margin:4px 0 0;padding:0;flex:0 0 auto;text-align:center;pointer-events:auto;cursor:default;user-select:text;';
    const grid = document.createElement('span');
    grid.style.cssText = 'display:inline-grid;grid-template-columns:10ch 2ch 17ch 2ch 13ch;align-items:center;justify-content:center;max-width:100%;font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.5;';
    for (let i = 0; i < 5; i++) {
      const span = document.createElement('span');
      span.style.cssText = 'min-width:0;text-align:center;';
      if (i % 2) span.textContent = '-';
      else values.push(span);
      grid.append(span);
    }
    element.append(grid);
    return element;
  }

  // Native CSS variables preserve custom fonts, theme changes and Electron's own text rendering.
  function syncStyle(composer) {
    const style = getComputedStyle(composer.outer);
    const font = style.getPropertyValue('--font-ui-family').trim()
      || style.getPropertyValue('--font-sans').trim() || style.fontFamily;
    const size = style.getPropertyValue('--text-sm').trim() || '13px';
    const color = style.getPropertyValue('--color-text-secondary').trim()
      || style.getPropertyValue('--color-text-tertiary').trim() || style.color;
    const key = `${font}|${size}|${color}`;
    if (lastStyle !== key) {
      row.style.fontFamily = font;
      row.style.fontSize = size;
      row.style.fontWeight = '400';
      row.style.color = color;
      lastStyle = key;
    }
    // A very narrow composer can wrap at separators while the surrounding row stays centered.
    const narrow = composer.outer.getBoundingClientRect().width < 310;
    const grid = row.firstElementChild;
    const template = narrow ? '1fr' : '10ch 2ch 17ch 2ch 13ch';
    if (grid.style.gridTemplateColumns !== template) grid.style.gridTemplateColumns = template;
    [...grid.children].forEach((element, index) => {
      const display = narrow && index % 2 ? 'none' : '';
      if (element.style.display !== display) element.style.display = display;
    });
  }

  function paint() {
    if (!row) return;
    const tps = (value) => Number.isFinite(value) ? `${Math.round(value)}tok/s` : '—tok/s';
    const text = [
      `${metrics?.estimating && Number.isFinite(metrics.current) ? '≈' : ''}${tps(metrics?.current)}`,
      `均值 ${tps(metrics?.mean)}`,
      `cache ${Number.isFinite(metrics?.cache) ? metrics.cache.toFixed(1) + '%' : '—'}`,
    ];
    values.forEach((element, index) => { if (element.textContent !== text[index]) element.textContent = text[index]; });
    const phase = metrics?.phase === 'tool' ? '工具运行中，保留最近读数。' : metrics?.estimating
      ? '≈ 为本对话同模型最近五次有效响应的加权估算，完成后用本地记录修正。' : '第一项为最近一次可测量的已完成模型响应。';
    const title = `${metrics?.model ?? '等待当前模型数据'}\n${phase}\nTPS = 官方输出 token（含思考）÷ 本地模型输出区间的合并时长；排除工具执行区间。这是本地记录推算值，并非服务器精确瞬时速度。\n均值只含本对话同模型的有效实测样本（${metrics?.samples ?? 0} 次），不足 1 秒的样本不参与。\ncache = 最近一次完成请求的缓存输入 token ÷ 输入 token。`;
    if (row.title !== title) row.title = title;
    const label = text.join(' - ');
    if (row.getAttribute('aria-label') !== label) row.setAttribute('aria-label', label);
  }

  function publish(context) {
    const text = JSON.stringify(context);
    if (text === lastContext) return;
    lastContext = text;
    try { globalThis.__codexTpsContext?.(text); } catch { /* A disconnected helper cannot affect typing. */ }
  }

  function reconcile() {
    frame = null;
    if (stopped) return;
    const threadId = threadFromLocation();
    const composer = findComposer();
    const context = { threadId, modelLabel: modelLabel(composer), mounted: false, reason: null };
    if (!threadId || !composer) {
      row?.remove();
      row = null;
      anchor = null;
      values = [];
      context.reason = !threadId ? 'no-local-thread' : 'no-composer';
      publish(context);
      return;
    }
    const parentStyle = getComputedStyle(composer.outer.parentElement);
    const canInsertSibling = parentStyle.display !== 'flex' || parentStyle.flexDirection.startsWith('column');
    if (!composer.nested && !canInsertSibling) {
      row?.remove();
      row = null;
      values = [];
      context.reason = 'unsupported-composer-layout';
      publish(context);
      return;
    }
    if (!row || !row.isConnected || anchor !== composer.outer) {
      row?.remove();
      document.querySelectorAll('[data-codex-tps]').forEach((element) => element.remove());
      values = [];
      row = makeRow();
      anchor = composer.outer;
      lastStyle = '';
      if (composer.nested) composer.outer.append(row);
      else composer.outer.after(row);
    }
    // Clear stale chat/model values synchronously, before any round trip to the helper.
    const previous = lastContext ? JSON.parse(lastContext) : null;
    if (previous && (previous.threadId !== threadId || previous.modelLabel !== context.modelLabel)) metrics = null;
    syncStyle(composer);
    paint();
    context.mounted = true;
    publish(context);
  }

  // Changes inside our own row are ignored, preventing a MutationObserver/render feedback loop.
  const schedule = () => { if (!stopped && frame === null) frame = setTimeout(reconcile, 100); };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !record.target.closest?.('[data-codex-tps]'))) schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const timer = setInterval(schedule, 750);
  addEventListener('popstate', schedule);
  addEventListener('hashchange', schedule);
  addEventListener('resize', schedule);

  // Stop removes all observers and DOM owned by this component; the native composer is untouched.
  globalThis.__codexTps = {
    update(next) {
      if (next?.threadId !== threadFromLocation()) return;
      if ((next.modelLabel ?? null) !== modelLabel(findComposer())) return;
      metrics = next;
      paint();
    },
    refresh: schedule,
    diagnostics() {
      const context = lastContext ? JSON.parse(lastContext) : null;
      const rect = row?.getBoundingClientRect();
      const composer = anchor?.getBoundingClientRect();
      return { context, text: row?.getAttribute('aria-label'), font: row ? getComputedStyle(row).fontFamily : null,
        fontSize: row ? getComputedStyle(row).fontSize : null,
        centerError: rect && composer ? Math.abs(rect.x + rect.width / 2 - composer.x - composer.width / 2) : null };
    },
    stop() {
      stopped = true;
      observer.disconnect();
      clearInterval(timer);
      if (frame !== null) clearTimeout(frame);
      removeEventListener('popstate', schedule);
      removeEventListener('hashchange', schedule);
      removeEventListener('resize', schedule);
      row?.remove();
      delete globalThis.__codexTps;
    },
  };
  schedule();
})();
