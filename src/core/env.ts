import type { WireMessage } from './types';

/**
 * 可注入的运行环境。核心引擎只依赖这些接口，
 * 浏览器环境用真实 BroadcastChannel / localStorage / Web Locks，
 * 测试环境用内存手动时钟与可控延迟通道。
 */
export interface Clock {
  now(): number;
  setInterval(cb: () => void, ms: number): number;
  clearInterval(handle: number): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface MessageBus {
  post(msg: WireMessage): void;
  onMessage(cb: (msg: WireMessage) => void): void;
  close(): void;
}

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** 监听其他标签页的写入（storage 事件语义：自己写不触发） */
  onStorage(cb: (key: string, value: string | null) => void): void;
}

/** Web Locks 抽象：同一把锁全局互斥，持锁期间执行 work */
export interface LockManagerLike {
  runExclusive<T>(name: string, work: () => T | Promise<T>): Promise<T>;
}

export const STORAGE_KEYS = {
  lease: 'pocc.lease.v1',
  state: 'pocc.state.v1',
} as const;

export const LOCK_NAME = 'pocc-lease-lock-v1';

/* ------------------------------ 浏览器实现 ------------------------------ */

export function createBrowserClock(): Clock {
  return {
    now: () => Date.now(),
    setInterval: (cb, ms) => window.setInterval(cb, ms) as unknown as number,
    clearInterval: (h) => window.clearInterval(h),
    setTimeout: (cb, ms) => window.setTimeout(cb, ms) as unknown as number,
    clearTimeout: (h) => window.clearTimeout(h),
  };
}

export function createBrowserBus(channelName: string): MessageBus {
  const ch = new BroadcastChannel(channelName);
  const handlers = new Set<(msg: WireMessage) => void>();
  ch.onmessage = (e: MessageEvent<WireMessage>) => {
    handlers.forEach((h) => h(e.data));
  };
  return {
    post(msg) {
      ch.postMessage(msg);
    },
    onMessage(cb) {
      handlers.add(cb);
    },
    close() {
      handlers.clear();
      ch.close();
    },
  };
}

export function createBrowserStorage(prefix: string): KVStore {
  const key = (k: string) => `${prefix}${k}`;
  return {
    get(k) {
      return window.localStorage.getItem(key(k));
    },
    set(k, v) {
      window.localStorage.setItem(key(k), v);
    },
    onStorage(cb) {
      window.addEventListener('storage', (e: StorageEvent) => {
        if (!e.key || !e.key.startsWith(prefix)) return;
        cb(e.key.slice(prefix.length), e.newValue);
      });
    },
  };
}

export function createBrowserLocks(): LockManagerLike {
  return {
    runExclusive<T>(name: string, work: () => T | Promise<T>): Promise<T> {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return navigator.locks.request(name, () =>
          Promise.resolve(work()),
        ) as unknown as Promise<T>;
      }
      // 兜底（老浏览器）：串行化到微任务队列，不保证跨标签页互斥，
      // 决策本身仍有 CAS 兜底，所以不会出错。
      return Promise.resolve().then(work);
    },
  };
}
