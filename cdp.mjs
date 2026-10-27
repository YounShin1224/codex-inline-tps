import { EventEmitter } from 'node:events';

// The connection accepts only loopback WebSocket endpoints supplied by the local Electron instance.
export class Cdp extends EventEmitter {
  constructor(url) {
    super();
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'ws:') {
      throw new Error('Refusing a non-loopback debugger endpoint');
    }
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Debugger connection timed out')); this.socket.close(); }, 8000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Debugger connection failed')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
        else request.resolve(message.result ?? {});
      } else if (message.method) this.emit(message.method, message.params ?? {});
    });
    this.socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Debugger closed')); }
      this.pending.clear();
      this.emit('closed');
    });
  }

  async call(method, params = {}) {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Debugger is not connected');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 7000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }
}

// Each renderer keeps independent thread/model context, even with several Codex windows open.
export class PageAttachment {
  constructor(info, source, onContext) {
    this.id = info.id;
    this.cdp = new Cdp(info.webSocketDebuggerUrl);
    this.source = source;
    this.onContext = onContext;
    this.context = null;
    this.world = null;
    this.mainFrame = null;
    this.worlds = new Map();
    this.scriptId = null;
    this.closed = false;
    this.lastValue = null;
    this.worldName = 'codex-inline-tps-v1';
    this.cdp.on('closed', () => { this.closed = true; });
    this.cdp.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) { this.mainFrame = frame.id; this.context = null; this.lastValue = null; }
    });
    this.cdp.on('Runtime.executionContextsCleared', () => { this.worlds.clear(); this.world = null; this.context = null; this.lastValue = null; });
    this.cdp.on('Runtime.executionContextCreated', ({ context }) => {
      if (context.name === this.worldName) {
        this.worlds.set(context.id, context.auxData?.frameId);
        if (context.auxData?.frameId === this.mainFrame) this.world = context.id;
      }
    });
    this.cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      this.worlds.delete(executionContextId);
      if (this.world === executionContextId) { this.world = null; this.context = null; this.lastValue = null; }
    });
    this.cdp.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
      if (name !== '__codexTpsContext' || this.worlds.get(executionContextId) !== this.mainFrame) return;
      try {
        const context = JSON.parse(payload);
        if (context.threadId !== null && !/^[a-f0-9-]{36}$/i.test(context.threadId)) return;
        this.world = executionContextId;
        this.context = { threadId: context.threadId, modelLabel: typeof context.modelLabel === 'string' ? context.modelLabel.slice(0, 100) : null,
          mounted: context.mounted === true, reason: context.reason ?? null };
        this.lastValue = null;
        this.onContext(this);
      } catch { /* Ignore malformed page messages. */ }
    });
  }

  async attach() {
    await this.cdp.call('Runtime.enable');
    await this.cdp.call('Page.enable');
    const { frameTree } = await this.cdp.call('Page.getFrameTree');
    this.mainFrame = frameTree.frame.id;
    await this.cdp.call('Runtime.addBinding', { name: '__codexTpsContext', executionContextName: this.worldName });
    const script = await this.cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: this.source, worldName: this.worldName });
    this.scriptId = script.identifier;
    const { executionContextId } = await this.cdp.call('Page.createIsolatedWorld', { frameId: this.mainFrame, worldName: this.worldName });
    this.world = executionContextId;
    this.worlds.set(executionContextId, this.mainFrame);
    const result = await this.cdp.call('Runtime.evaluate', { expression: this.source, contextId: executionContextId });
    if (result.exceptionDetails) throw new Error('Could not initialize the inline component');
  }

  async update(metrics, expectedContext = this.context) {
    if (!this.world || !this.context || expectedContext !== this.context) return;
    const value = { ...metrics, modelLabel: expectedContext.modelLabel };
    const serialized = JSON.stringify(value);
    if (serialized === this.lastValue) return;
    const result = await this.cdp.call('Runtime.evaluate', {
      contextId: this.world, expression: `globalThis.__codexTps?.update(${serialized})`, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('Could not render metrics');
    this.lastValue = serialized;
  }

  async diagnostics() {
    if (!this.world) return null;
    const result = await this.cdp.call('Runtime.evaluate', {
      contextId: this.world, expression: 'globalThis.__codexTps?.diagnostics() ?? null', returnByValue: true,
    });
    return result.result?.value ?? null;
  }

  async detach() {
    try {
      if (this.scriptId) await this.cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId });
      if (this.world) await this.cdp.call('Runtime.evaluate', { contextId: this.world, expression: 'globalThis.__codexTps?.stop()' });
      await this.cdp.call('Runtime.removeBinding', { name: '__codexTpsContext' });
    } finally { this.cdp.close(); }
  }
}
