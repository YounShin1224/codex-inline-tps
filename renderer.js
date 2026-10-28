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
  let mountPoint = null;
  let frame = null;
  let stopped = false;
  let lastContext = '';
  let lastStyle = '';
  let metrics = null;
  let values = [];
  let digits = [];
  let suffixes = [];
  let positionedHost = null;
  let originalPosition = '';
  let visualCenter = null;
  let verticalOffset = 0;
  let layoutSignature = null;
  let layoutChangedAt = 0;
  let readiness = 'waiting-for-data';
  let observedLayout = [];
  const layoutObserver = new ResizeObserver(() => reconcileNow());

  function hideRow() {
    if (!row) return;
    row.style.visibility = 'hidden';
    row.setAttribute('aria-hidden', 'true');
  }

  function invalidateLayout() {
    layoutSignature = null;
    readiness = 'waiting-for-layout';
    hideRow();
    schedule();
  }

  function reconcileNow() {
    if (stopped) return;
    if (frame !== null) clearTimeout(frame);
    reconcile();
  }

  // Route parsing is per renderer/window. No globally most-recent chat is ever substituted.
  const threadFromLocation = () => {
    const composer = findComposer();
    const marker = composer?.outer.querySelector('[data-above-composer-conversation-id]');
    if (marker) {
      const id = marker.getAttribute('data-above-composer-conversation-id');
      return new RegExp(`^${UUID}$`, 'i').test(id ?? '') ? id.toLowerCase() : null;
    }
    for (const path of [location.pathname, location.hash.slice(1)]) {
      const match = decodeURIComponent(path).match(new RegExp(`/(?:local|threads|hotkey-window/thread)/(${UUID})(?:/|$|[?#])`, 'i'));
      if (match) return match[1].toLowerCase();
    }
    return null;
  };
  const visible = (element) => element.isConnected && (element.checkVisibility
    ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    : element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');

  // Mount directly in the native footer grid, on the same grid row as its model picker.
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
      const footer = editor.closest('[data-composer-footer-responsive]');
      const mount = footer ?? null;
      if (outer) return { outer, editor, mount };
    }
    return null;
  }

  // Read only model-picker labels. Neither draft text nor reply contents are sent to the helper.
  function modelLabel(composer) {
    if (!composer) return null;
    const candidates = [...composer.outer.querySelectorAll('button, [role="combobox"]')];
    for (const element of candidates) {
      if (!visible(element)) continue;
      const nativeName = element.querySelector('[class*="ModelPickerTriggerModelText"]');
      if (nativeName && visible(nativeName)) return nativeName.textContent.trim();
      const label = element.cloneNode(true);
      label.querySelectorAll('select, option, [hidden], [aria-hidden="true"]').forEach((node) => node.remove());
      const text = label.textContent?.trim().replace(/\s+/g, ' ');
      if (text && text.length < 100 && MODEL.test(text)) return text;
    }
    return null;
  }

  // Reserve only numeric digit widths. Labels and separators keep compact, natural spacing.
  function makeRow() {
    const element = document.createElement('div');
    element.id = ID;
    element.dataset.codexTps = 'true';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'off');
    element.style.cssText = 'position:absolute;display:block;visibility:hidden;box-sizing:border-box;width:max-content;height:20px;margin:0;padding:0;grid-column:1 / -1;grid-row:2;align-self:center;justify-self:center;z-index:2;text-align:center;pointer-events:auto;cursor:default;user-select:text;overflow:hidden;';
    element.setAttribute('aria-hidden', 'true');
    const grid = document.createElement('span');
    grid.style.cssText = 'display:inline-flex;align-items:center;column-gap:2px;font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:20px;';
    for (let i = 0; i < 5; i++) {
      const span = document.createElement('span');
      span.style.cssText = 'min-width:0;text-align:center;';
      if (i % 2) {
        span.textContent = '·';
        span.style.opacity = '0.55';
        span.setAttribute('aria-hidden', 'true');
      }
      else {
        span.style.display = 'inline-flex';
        span.style.alignItems = 'baseline';
        const index = values.length;
        if (index) {
          const label = document.createElement('span');
          label.textContent = index === 1 ? '均值' : '缓存';
          span.append(label);
        }
        if (index === 0) span.style.fontWeight = '500';
        const digit = document.createElement('span');
        digit.style.cssText = `display:inline-block;min-width:${index === 0 ? 3 : 0}ch;text-align:${index === 0 ? 'right' : 'left'};`;
        const suffix = document.createElement('span');
        suffix.textContent = index === 0 ? 'tok/s' : index === 2 ? '%' : '';
        if (index === 0) {
          suffix.style.fontWeight = '400';
        }
        span.append(digit, suffix);
        digits.push(digit);
        suffixes.push(suffix);
        values.push(span);
      }
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
    const primary = style.getPropertyValue('--color-text').trim()
      || style.getPropertyValue('--app-color-text-foreground').trim() || style.color;
    const key = `${font}|${size}|${color}|${primary}`;
    if (lastStyle !== key) {
      row.style.fontFamily = font;
      row.style.fontSize = size;
      row.style.fontWeight = '400';
      row.style.color = color;
      values[0].style.color = primary;
      lastStyle = key;
    }
  }

  // Positioning does not add a new input row. Restore the native host style when stopping/remounting.
  function releaseHost() {
    if (positionedHost && positionedHost.style.position === 'relative') positionedHost.style.position = originalPosition;
    positionedHost = null;
    layoutObserver.disconnect();
    observedLayout = [];
    layoutSignature = null;
  }

  function syncPlacement(composer) {
    const host = composer.mount;
    const nativeModel = host.querySelector('[class*="ModelPickerTriggerModelText"]')?.closest('button')
      ?? [...host.querySelectorAll('button')].find((button) => visible(button) && MODEL.test(button.textContent));
    if (!nativeModel || !visible(nativeModel)) return null;
    let controlCell = nativeModel;
    while (controlCell?.parentElement && controlCell.parentElement !== host) controlCell = controlCell.parentElement;
    const nativeRow = controlCell ? getComputedStyle(controlCell).gridRowStart : null;
    if (!/^\d+$/.test(nativeRow ?? '')) return null;
    if (row.style.gridRow !== nativeRow && /^\d+$/.test(nativeRow)) row.style.gridRow = nativeRow;

    // Center in the actual gap between controls so unequal left/right button widths feel balanced.
    const bounds = host.getBoundingClientRect();
    const modelBounds = nativeModel.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || modelBounds.width <= 0 || modelBounds.height <= 0) return null;
    const centerY = modelBounds.y + modelBounds.height / 2;
    const leftCell = [...host.children].find((element) => element !== row
      && getComputedStyle(element).gridColumnStart === '1'
      && getComputedStyle(element).gridRowStart === nativeRow
      && !element.contains(composer.editor));
    const left = (leftCell?.getBoundingClientRect().right ?? bounds.left) + 8;
    const rightControls = [...(controlCell?.querySelectorAll('button,[role="button"]') ?? [])]
      .filter((element) => visible(element) && Math.abs(element.getBoundingClientRect().y + element.getBoundingClientRect().height / 2 - centerY) < 8);
    const right = (rightControls.length ? Math.min(...rightControls.map((element) => element.getBoundingClientRect().left)) : bounds.right) - 8;
    const available = Math.max(0, right - left);
    if (!leftCell || !visible(leftCell) || available <= 0) return null;
    row.style.maxWidth = `${available}px`;
    const width = Math.min(row.firstElementChild.getBoundingClientRect().width, available);
    const center = bounds.x + bounds.width / 2;
    visualCenter = (left + right) / 2;
    const clamped = Math.max(left + width / 2, Math.min(visualCenter, right - width / 2));
    const margin = `${(clamped - center) * 2}px`;
    if (row.style.marginLeft !== margin) row.style.marginLeft = margin;
    // Native button metrics/margins differ on macOS. Align to the visible picker, not its grid cell.
    const rowBounds = row.getBoundingClientRect();
    const offset = Math.round((verticalOffset + centerY - rowBounds.y - rowBounds.height / 2) * 64) / 64;
    if (offset !== verticalOffset) {
      verticalOffset = offset;
      row.style.transform = `translateY(${offset}px)`;
    }
    const targets = [host, nativeModel, leftCell];
    if (targets.some((element, index) => element !== observedLayout[index])) {
      layoutObserver.disconnect();
      targets.forEach((element) => layoutObserver.observe(element));
      observedLayout = targets;
    }
    // A transient native grid/model-picker layout must settle before the row is revealed.
    const geometry = [bounds.x, bounds.y, bounds.width, bounds.height, modelBounds.x, modelBounds.y,
      modelBounds.width, modelBounds.height, left, right, row.firstElementChild.getBoundingClientRect().width];
    return JSON.stringify(geometry.map((value) => Math.round(value * 64) / 64));
  }

  function syncVisibility(context, placement) {
    const dataReady = context.modelLabel && metrics?.model && metrics.threadId === context.threadId
      && [metrics.current, metrics.mean, metrics.cache].every((value) => Number.isFinite(value) && value >= 0)
      && metrics.cache <= 100;
    if (!dataReady || !placement) {
      readiness = dataReady ? 'waiting-for-layout' : 'waiting-for-data';
      layoutSignature = null;
      hideRow();
      return;
    }
    const signature = `${context.threadId}|${context.modelLabel}|${lastStyle}|${placement}`;
    if (signature !== layoutSignature) {
      layoutSignature = signature;
      layoutChangedAt = performance.now();
    }
    // Settle only before revealing a hidden/new row. Once ready, valid geometry updates
    // (typing, caret/focus styling, hover and resizing) reposition it without blinking.
    if (row.style.visibility !== 'visible' && performance.now() - layoutChangedAt < 120) {
      readiness = 'layout-settling';
      hideRow();
      schedule();
      return;
    }
    readiness = 'ready';
    row.style.visibility = 'visible';
    row.removeAttribute('aria-hidden');
  }

  function paint() {
    if (!row) return;
    const tps = (value) => Number.isFinite(value) ? `${Math.round(value)}tok/s` : '—tok/s';

    // Cache always uses two decimals; never round a partial cache hit into a full-hit claim.
    let cacheValue = '—';
    if (Number.isFinite(metrics?.cache)) {
      const ordinary = metrics.cache.toFixed(2);
      const fullHit = metrics.cacheInputTokens > 0 && metrics.cacheHitTokens === metrics.cacheInputTokens;
      cacheValue = ordinary === '100.00' && !fullHit ? '<100.00' : ordinary;
    }
    const text = [
      `${metrics?.approximate ? '≈' : ''}${tps(metrics?.current)}`,
      `均值${metrics?.approximate ? '≈' : ''}${Number.isFinite(metrics?.mean) ? Math.round(metrics.mean) : '—'}`,
      `缓存${Number.isFinite(metrics?.cache) ? cacheValue + '%' : '—'}`,
    ];
    const numeric = [metrics?.current, metrics?.mean].map((value) => Number.isFinite(value)
      ? `${metrics?.approximate ? '≈' : ''}${Math.round(value)}` : '—');
    numeric.push(cacheValue);
    digits.forEach((element, index) => { if (element.textContent !== numeric[index]) element.textContent = numeric[index]; });
    suffixes[2].textContent = Number.isFinite(metrics?.cache) ? '%' : '';
    const phase = metrics?.phase === 'tool' ? '工具运行中，保留最近一次有效模型响应的读数。' : metrics?.estimating
      ? '生成中：第一项为本对话同模型最近五次有效响应的加权估算，完成后用本地记录修正。'
      : metrics?.held ? '最新响应没有有效计时，当前保留最近一次有效模型响应的读数。' : '第一项为最近一次可测量的已完成模型响应。';
    const measuredAt = Number.isFinite(metrics?.lastSampleAt)
      ? `\n最近有效样本：${new Date(metrics.lastSampleAt).toLocaleTimeString('zh-CN', { hour12: false })}，${metrics.approximate ? '响应' : '输出'}区间 ${(metrics.lastDurationMs / 1000).toFixed(2)} 秒。` : '';
    const cacheDetails = metrics?.cacheComplete
      ? `本轮已完成 ${metrics.cacheRequests} 次模型请求，缓存输入合计 ${metrics.cacheHitTokens}，输入合计 ${metrics.cacheInputTokens}。`
      : '等待本轮完整的请求用量计数。';
    const formula = metrics?.approximate
      ? '≈ 表示旧日志缺少生成起始时间：官方输出 token ÷ 请求开始（或上次工具返回）到输出完成/用量回报的响应时长，可能含排队、首 token 等待及用量回报延迟，属于响应平均速度估算，不是模型纯生成 TPS。只与同口径样本统计均值。'
      : 'TPS = 官方输出 token（含思考）÷ 本地模型输出区间的合并时长；排除工具执行区间。这是本地记录推算值，并非服务器精确瞬时速度。';
    const title = `${metrics?.model ?? '等待当前模型数据'}\n${phase}${measuredAt}\n${formula}\n均值只含本对话同模型、同口径的有效样本（${metrics?.samples ?? 0} 次），不足 1 秒的样本不参与。\n缓存 = 当前主会话这一轮所有已完成请求的缓存输入总和 ÷ 输入总和。${cacheDetails}`;
    if (row.title !== title) row.title = title;
    const label = text.join('·');
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
      releaseHost();
      row = null;
      anchor = null;
      mountPoint = null;
      values = [];
      context.reason = !threadId ? 'no-local-thread' : 'no-composer';
      publish(context);
      return;
    }
    if (!composer.mount) {
      row?.remove();
      releaseHost();
      row = null;
      values = [];
      context.reason = 'unsupported-composer-layout';
      publish(context);
      return;
    }
    if (!row || !row.isConnected || anchor !== composer.outer || mountPoint !== composer.mount) {
      row?.remove();
      releaseHost();
      document.querySelectorAll('[data-codex-tps]').forEach((element) => element.remove());
      values = [];
      digits = [];
      suffixes = [];
      row = makeRow();
      verticalOffset = 0;
      anchor = composer.outer;
      mountPoint = composer.mount;
      lastStyle = '';
      composer.mount.append(row);
      if (getComputedStyle(composer.mount).position === 'static') {
        positionedHost = composer.mount;
        originalPosition = composer.mount.style.position;
        composer.mount.style.position = 'relative';
      }
    }
    // Clear stale chat/model values synchronously, before any round trip to the helper.
    const previous = lastContext ? JSON.parse(lastContext) : null;
    if (previous && (previous.threadId !== threadId || previous.modelLabel !== context.modelLabel)) metrics = null;
    syncStyle(composer);
    paint();
    const placement = syncPlacement(composer);
    syncVisibility(context, placement);
    context.mounted = true;
    publish(context);
  }

  // Changes inside our own row are ignored, preventing a MutationObserver/render feedback loop.
  const schedule = () => { if (!stopped && frame === null) frame = setTimeout(reconcile, 100); };
  const observer = new MutationObserver((records) => {
    const external = records.filter((record) => !record.target.closest?.('[data-codex-tps]'));
    if (!external.length) return;
    const previous = lastContext ? JSON.parse(lastContext) : null;
    const composer = findComposer();
    if (!row?.isConnected || previous?.threadId !== threadFromLocation()
      || previous?.modelLabel !== modelLabel(composer)) invalidateLayout();
    else schedule();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const timer = setInterval(schedule, 750);
  addEventListener('popstate', invalidateLayout);
  addEventListener('hashchange', invalidateLayout);
  addEventListener('resize', reconcileNow);

  // Stop removes all observers and DOM owned by this component; the native composer is untouched.
  globalThis.__codexTps = {
    update(next) {
      if (next?.threadId !== threadFromLocation()) return;
      if ((next.modelLabel ?? null) !== modelLabel(findComposer())) return;
      metrics = next;
      // Apply data, positioning and visibility in one task so no unpositioned frame is painted.
      reconcileNow();
    },
    refresh: schedule,
    diagnostics() {
      const context = lastContext ? JSON.parse(lastContext) : null;
      const rect = row?.getBoundingClientRect();
      const composer = anchor?.getBoundingClientRect();
      return { context, text: row?.getAttribute('aria-label'), visible: Boolean(row && getComputedStyle(row).visibility === 'visible'), readiness,
        font: row ? getComputedStyle(row).fontFamily : null,
        fontSize: row ? getComputedStyle(row).fontSize : null,
        centerError: rect && composer ? Math.abs(rect.x + rect.width / 2 - composer.x - composer.width / 2) : null,
        visualCenterError: rect && Number.isFinite(visualCenter) ? Math.abs(rect.x + rect.width / 2 - visualCenter) : null };
    },
    stop() {
      stopped = true;
      observer.disconnect();
      layoutObserver.disconnect();
      clearInterval(timer);
      if (frame !== null) clearTimeout(frame);
      removeEventListener('popstate', invalidateLayout);
      removeEventListener('hashchange', invalidateLayout);
      removeEventListener('resize', reconcileNow);
      row?.remove();
      releaseHost();
      delete globalThis.__codexTps;
    },
  };
  schedule();
})();
