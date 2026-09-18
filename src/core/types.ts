/**
 * 可注入的基础设施抽象。
 *
 * 真实浏览器适配器见 ./real，测试里的手动假实现见 test/helpers。
 * 租约与消息逻辑只依赖这些接口，因此可以在不依赖真实计时器 /
 * BroadcastChannel / localStorage 的情况下做确定性并发测试。
 */

/** 单调毫秒时钟（Date.now 在休眠/假时钟下都可控）。 */
export interface Clock {
  now(): number;
}

/**
 * 消息总线，等价于 BroadcastChannel：
 * postMessage 绝不同步投递给自己，且不保证跨席位投递顺序。
 */
export interface Bus {
  post(message: unknown): void;
  on(handler: (message: unknown) => void): () => void;
  close(): void;
}

/** 等价于 localStorage + storage 事件（本机不收到自己写的事件）。 */
export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  onStorage(
    key: string,
    handler: (value: string | null, oldValue: string | null) => void,
  ): () => void;
}

/**
 * 等价于 navigator.locks.request(name, exclusive, fn)：
 * 同名锁互斥，回调 resolve 后释放；调用方可选感知「抢到锁」的时机。
 */
export interface LockManager {
  runExclusive<T>(
    name: string,
    fn: () => Promise<T> | T,
  ): Promise<T>;
}

/** 周期性定时器（测试中用手动时钟驱动）。 */
export interface Scheduler {
  setInterval(fn: () => void, intervalMs: number): () => void;
  setTimeout(fn: () => void, delayMs: number): () => void;
}
