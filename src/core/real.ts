/**
 * 真实浏览器适配器：Date 时钟、BroadcastChannel、localStorage、
 * Web Locks、以及可被「模拟休眠」冻结的定时器。
 */
import type {
  Bus,
  Clock,
  KeyValueStore,
  LockManager as LockManagerLike,
  Scheduler,
} from './types';
import { CHANNEL_NAME } from './protocol';

export const realClock: Clock = { now: () => Date.now() };

/** BroadcastChannel 适配：转发消息，关闭时解绑。 */
export class BroadcastChannelBus implements Bus {
  private channel: BroadcastChannel;
  private handlers = new Set<(message: unknown) => void>();

  constructor(name: string = CHANNEL_NAME) {
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (event: MessageEvent) => {
      this.handlers.forEach((handler) => handler(event.data));
    };
  }

  post(message: unknown): void {
    this.channel.postMessage(message);
  }

  on(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
    this.channel.close();
  }
}

/** localStorage 适配：storage 事件只在其他标签页写入时触发。 */
export class LocalStorageStore implements KeyValueStore {
  private listeners = new Map<
    string,
    Set<(value: string | null, oldValue: string | null) => void>
  >();
  private listener: (event: StorageEvent) => void;

  constructor(private storage: Storage = window.localStorage) {
    this.listener = (event: StorageEvent) => {
      if (event.storageArea !== this.storage || event.key === null) return;
      const set = this.listeners.get(event.key);
      set?.forEach((handler) => handler(event.newValue, event.oldValue));
    };
    window.addEventListener('storage', this.listener);
  }

  read(key: string): string | null {
    return this.storage.getItem(key);
  }

  write(key: string, value: string): void {
    this.storage.setItem(key, value);
  }

  onStorage(
    key: string,
    handler: (value: string | null, oldValue: string | null) => void,
  ): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  dispose(): void {
    window.removeEventListener('storage', this.listener);
    this.listeners.clear();
  }
}

/** Web Locks API 适配（不可用时回退到进程内互斥，见 fallbackLocks）。 */
export class WebLockManager implements LockManagerLike {
  constructor(
    private locks: Pick<globalThis.LockManager, 'request'> | undefined =
      typeof navigator !== 'undefined' ? navigator.locks : undefined,
  ) {}

  runExclusive<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.locks) {
      return fallbackLocks.runExclusive(name, fn);
    }
    return this.locks.request(name, async () => fn()) as Promise<T>;
  }
}

/** 单标签页内的互斥回退（真正的跨标签页互斥仍由 Web Locks 提供）。 */
export const fallbackLocks: LockManagerLike = (() => {
  const queues = new Map<string, Promise<unknown>>();
  return {
    runExclusive(name, fn) {
      const previous = queues.get(name) ?? Promise.resolve();
      const next = previous.then(fn, fn);
      queues.set(
        name,
        next.then(
          () => undefined,
          () => undefined,
        ),
      );
      return next;
    },
  };
})();

/**
 * 真实定时器调度器，支持「模拟休眠」：
 * freeze 期间挂起所有计时器，醒来后立即补跑被挂起的周期任务一次，
 * 从而真实复现「主控休眠 -> 租约过期 -> 恢复后还以为自己是主控」。
 */
export class RealScheduler implements Scheduler {
  private frozen = false;
  private pending: Array<() => void> = [];
  private intervals = new Set<number>();
  private timeouts = new Set<number>();

  setInterval(fn: () => void, intervalMs: number): () => void {
    const wrapped = () => {
      if (this.frozen) {
        this.pending.push(fn);
        return;
      }
      fn();
    };
    const id = window.setInterval(wrapped, intervalMs);
    this.intervals.add(id);
    return () => {
      window.clearInterval(id);
      this.intervals.delete(id);
    };
  }

  setTimeout(fn: () => void, delayMs: number): () => void {
    const wrapped = () => {
      this.timeouts.delete(id);
      if (this.frozen) this.pending.push(fn);
      else fn();
    };
    const id = window.setTimeout(wrapped, delayMs);
    this.timeouts.add(id);
    return () => {
      window.clearTimeout(id);
      this.timeouts.delete(id);
    };
  }

  /** 模拟标签页休眠：停止执行任何计时器回调。 */
  freeze(): void {
    this.frozen = true;
  }

  /** 恢复：补跑一次挂起的周期回调（随后各席位按真实时钟重新对账）。 */
  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    const queued = this.pending;
    this.pending = [];
    // 只补跑每类回调一次，避免长睡后雪崩式补 N 次心跳。
    const unique = new Set(queued);
    unique.forEach((fn) => fn());
  }

  isFrozen(): boolean {
    return this.frozen;
  }
}
