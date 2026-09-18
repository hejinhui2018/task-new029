import type { Bus, KeyValueStore } from './types';

/**
 * 模拟「标签页休眠 / 网卡顿」：暂停期间
 *  - 入站消息不投递（真实休眠时事件会被浏览器挂起）；
 *  - storage 事件不投递；
 * 恢复时按顺序补放积压事件。
 * 出站与读写不拦截（休眠窗口里本就不会有用户操作）。
 */
export class PausableBus implements Bus {
  private handlers = new Set<(message: unknown) => void>();
  private paused = false;
  private queue: unknown[] = [];
  private offInner: () => void;

  constructor(private inner: Bus) {
    this.offInner = inner.on((message) => {
      if (this.paused) this.queue.push(message);
      else this.dispatch(message);
    });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const queued = this.queue;
    this.queue = [];
    queued.forEach((message) => this.dispatch(message));
  }

  isPaused(): boolean {
    return this.paused;
  }

  post(message: unknown): void {
    this.inner.post(message);
  }

  on(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.offInner();
    this.handlers.clear();
  }

  private dispatch(message: unknown): void {
    this.handlers.forEach((handler) => handler(message));
  }
}

interface BridgedKey {
  handlers: Set<(value: string | null, oldValue: string | null) => void>;
  off: () => void;
}

/** 配合 PausableBus：暂停期间挂起 storage 事件，恢复时按 key 合并补放
 * （同一 key 多次变化只需看到最新值，旧值取暂停前最后一次的快照）。 */
export class PausableKV implements KeyValueStore {
  private bridges = new Map<string, BridgedKey>();
  private paused = false;
  private pending = new Map<
    string,
    { value: string | null; oldValue: string | null }
  >();

  constructor(private inner: KeyValueStore) {}

  read(key: string): string | null {
    return this.inner.read(key);
  }

  write(key: string, value: string): void {
    this.inner.write(key, value);
  }

  onStorage(
    key: string,
    handler: (value: string | null, oldValue: string | null) => void,
  ): () => void {
    let bridge = this.bridges.get(key);
    if (!bridge) {
      const handlers = new Set<typeof handler>();
      const off = this.inner.onStorage(key, (value, oldValue) => {
        if (this.paused) {
          const existing = this.pending.get(key);
          this.pending.set(key, {
            value,
            // 合并多次变化：旧值保留暂停前第一次变化前的值。
            oldValue: existing ? existing.oldValue : oldValue,
          });
        } else {
          handlers.forEach((h) => h(value, oldValue));
        }
      });
      bridge = { handlers, off };
      this.bridges.set(key, bridge);
    }
    bridge.handlers.add(handler);
    return () => {
      const current = this.bridges.get(key);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        current.off();
        this.bridges.delete(key);
      }
    };
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const pending = this.pending;
    this.pending = new Map();
    pending.forEach((event, key) => {
      this.bridges
        .get(key)
        ?.handlers.forEach((handler) => handler(event.value, event.oldValue));
    });
  }

  isPaused(): boolean {
    return this.paused;
  }
}
