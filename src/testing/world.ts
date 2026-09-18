import type { Clock, KVStore, LockManagerLike, MessageBus } from '../core/env';
import { createDelayedBus, createDelayedKV, type LinkConditions } from '../core/pipe';
import { PlayoutCore } from '../core/PlayoutCore';
import type { Seat, WireMessage } from '../core/types';

/* ------------------------------ 手动时钟 ------------------------------ */

interface TimerEntry {
  due: number;
  period: number | null;
  fn: () => void;
}

/** 所有席位共享的手动时钟：advance 按到期顺序触发定时器 */
export class ManualClock implements Clock {
  private t = 0;
  private timers = new Map<number, TimerEntry>();
  private nextId = 1;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.t + Math.max(0, ms), period: null, fn });
    return id;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.t + ms, period: ms, fn });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  clearInterval(handle: number): void {
    this.timers.delete(handle);
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let earliestId = -1;
      let earliestDue = Infinity;
      for (const [id, entry] of this.timers) {
        if (entry.due <= target && entry.due < earliestDue) {
          earliestDue = entry.due;
          earliestId = id;
        }
      }
      if (earliestId === -1) break;
      const entry = this.timers.get(earliestId)!;
      this.t = entry.due;
      if (entry.period != null) {
        entry.due += entry.period;
      } else {
        this.timers.delete(earliestId);
      }
      entry.fn();
    }
    this.t = target;
  }
}

/* --------------------------- BroadcastChannel 替身 --------------------------- */

interface HubMember {
  receive(msg: WireMessage): void;
}

export class MemoryHub {
  private members = new Set<HubMember>();

  join(): MessageBus {
    const me: HubMember = {
      receive: (msg) => {
        handlers.forEach((h) => h(msg));
      },
    };
    const handlers = new Set<(msg: WireMessage) => void>();
    this.members.add(me);
    return {
      post: (msg) => {
        // 不发给自己；异步投递，与 BroadcastChannel / storage 事件的任务语义一致，
        // 这样连续两次同步“同时点击”会先各自捕获旧 epoch，再在锁内 CAS。
        for (const m of this.members) {
          if (m !== me) queueMicrotask(() => m.receive(msg));
        }
      },
      onMessage: (cb) => {
        handlers.add(cb);
      },
      close: () => {
        this.members.delete(me);
        handlers.clear();
      },
    };
  }

  /** 外部探针：以“第三方”身份向所有席位投递一条消息 */
  probe(): { post(msg: WireMessage): void } {
    const bus = this.join();
    return { post: (msg) => bus.post(msg) };
  }
}

/* ----------------------------- localStorage 替身 ----------------------------- */

interface KVListener {
  cb(key: string, value: string | null): void;
}

export class SharedMemoryKV {
  private map = new Map<string, string>();
  private listeners: KVListener[] = [];

  private connect(): KVStore {
    const me: KVListener = { cb: () => {} };
    this.listeners.push(me);
    return {
      get: (k) => this.map.get(k) ?? null,
      set: (k, v) => {
        this.map.set(k, v);
        // storage 事件异步通知“其他”实例（与浏览器 storage 事件一致）
        for (const l of this.listeners) {
          if (l !== me) queueMicrotask(() => l.cb(k, v));
        }
      },
      onStorage: (cb) => {
        me.cb = cb;
      },
    };
  }

  instance(): KVStore {
    return this.connect();
  }

  /** 测试直接读取底层值 */
  raw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

/* ------------------------------ Web Locks 替身 ------------------------------ */

interface Waiter {
  run(): void;
}

/** 全局互斥 + 公平 FIFO 队列，模拟 navigator.locks.request(name, exclusive) */
export class MemoryLocks implements LockManagerLike {
  private queues = new Map<string, Waiter[]>();

  runExclusive<T>(name: string, work: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) ?? [];
      this.queues.set(name, queue);
      const waiter: Waiter = {
        run: () => {
          try {
            Promise.resolve(work()).then(
              (v) => {
                this.release(name, waiter);
                resolve(v);
              },
              (e) => {
                this.release(name, waiter);
                reject(e);
              },
            );
          } catch (e) {
            this.release(name, waiter);
            reject(e as Error);
          }
        },
      };
      queue.push(waiter);
      if (queue.length === 1) waiter.run();
    });
  }

  private release(name: string, waiter: Waiter): void {
    const queue = this.queues.get(name);
    if (!queue) return;
    const idx = queue.indexOf(waiter);
    if (idx >= 0) queue.splice(idx, 1);
    queue[0]?.run();
  }
}

/* ------------------------------ 测试世界 ------------------------------ */

export interface SeatRuntime {
  seat: Seat;
  core: PlayoutCore;
  link: LinkConditions;
}

export interface WorldOptions {
  /** 给入站消息套延迟/抖动管道（默认 false：即时投递） */
  delayed?: boolean;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  tickIntervalMs?: number;
  maxCommandAgeMs?: number;
  handoverBackoffMs?: number;
  /** 抖动随机数序列（每个席位独立） */
  rng?: () => number;
}

export const DEFAULT_TIMING = {
  leaseTtlMs: 1000,
  renewIntervalMs: 300,
  tickIntervalMs: 100,
  maxCommandAgeMs: 2000,
  handoverBackoffMs: 200,
};

export class World {
  readonly clock = new ManualClock();
  readonly hub = new MemoryHub();
  readonly kv = new SharedMemoryKV();
  readonly locks = new MemoryLocks();
  private readonly opts: Required<Omit<WorldOptions, 'delayed' | 'rng'>> & {
    delayed: boolean;
    rng?: () => number;
  };
  readonly runtimes: SeatRuntime[] = [];

  constructor(opts: WorldOptions = {}) {
    this.opts = { ...DEFAULT_TIMING, delayed: false, ...opts } as World['opts'];
  }

  createSeat(id: string, kind: Seat['kind'] = 'backup'): SeatRuntime {
    const seat: Seat = { id, kind, label: id };
    const link: LinkConditions = { delayMs: 0, jitter: false, sleeping: false };
    const rawBus = this.hub.join();
    const rawKV = this.kv.instance();
    const bus = this.opts.delayed
      ? createDelayedBus(rawBus, this.clock, link, { random: this.opts.rng ?? Math.random })
      : rawBus;
    const storage = this.opts.delayed
      ? createDelayedKV(rawKV, this.clock, link, { random: this.opts.rng ?? Math.random })
      : rawKV;
    const core = new PlayoutCore({
      self: seat,
      clock: this.clock,
      bus,
      storage,
      locks: this.locks,
      link,
      leaseTtlMs: this.opts.leaseTtlMs,
      renewIntervalMs: this.opts.renewIntervalMs,
      tickIntervalMs: this.opts.tickIntervalMs,
      maxCommandAgeMs: this.opts.maxCommandAgeMs,
      handoverBackoffMs: this.opts.handoverBackoffMs,
    });
    const rt = { seat, core, link };
    this.runtimes.push(rt);
    return rt;
  }

  start(rt: SeatRuntime): void {
    rt.core.start();
  }

  /** 模拟刷新：用同一席位身份重建引擎（旧实例关闭） */
  reload(rt: SeatRuntime): SeatRuntime {
    rt.core.close();
    const seat: Seat = { ...rt.seat };
    const link: LinkConditions = { delayMs: 0, jitter: false, sleeping: false };
    const core = new PlayoutCore({
      self: seat,
      clock: this.clock,
      bus: this.hub.join(),
      storage: this.kv.instance(),
      locks: this.locks,
      link,
      leaseTtlMs: this.opts.leaseTtlMs,
      renewIntervalMs: this.opts.renewIntervalMs,
      tickIntervalMs: this.opts.tickIntervalMs,
      maxCommandAgeMs: this.opts.maxCommandAgeMs,
      handoverBackoffMs: this.opts.handoverBackoffMs,
    });
    const next = { seat, core, link };
    const idx = this.runtimes.indexOf(rt);
    if (idx >= 0) this.runtimes[idx] = next;
    core.start();
    return next;
  }

  advance(ms: number): void {
    this.clock.advance(ms);
  }

  probePost(msg: WireMessage): void {
    this.hub.probe().post(msg);
  }

  get(id: string): SeatRuntime {
    const rt = this.runtimes.find((r) => r.seat.id === id);
    if (!rt) throw new Error(`unknown seat ${id}`);
    return rt;
  }
}

/** 清空核心内部通过微任务合并的快照推送 */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
