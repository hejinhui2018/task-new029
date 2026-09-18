/**
 * 确定性测试替身：
 *  - FakeClock：手动推进的毫秒时钟；
 *  - Hub / FakeBus：进程内 BroadcastChannel，默认同步投递，可直接注入乱序消息；
 *  - KVCluster / FakeKV：进程内 localStorage + storage 事件；
 *  - FakeLocks：跨「标签页」共享的 Promise 链式互斥，等价 Web Locks；
 *  - FakeScheduler：只有手动 runDue 时才触发计时器（休眠 = 不 runDue）。
 */
import { Coordinator } from '../../src/core/coordinator';
import type { Bus, Clock, KeyValueStore, LockManager, Scheduler } from '../../src/core/types';
import type { ControlMessage } from '../../src/core/protocol';

export class FakeClock implements Clock {
  private t = 1_000;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}

interface IntervalEntry {
  fn: () => void;
  every: number;
  last: number;
}
interface TimeoutEntry {
  fn: () => void;
  at: number;
}

export class FakeScheduler implements Scheduler {
  private intervals = new Set<IntervalEntry>();
  private timeouts = new Set<TimeoutEntry>();

  constructor(private clock: FakeClock) {}

  setInterval(fn: () => void, every: number): () => void {
    const entry: IntervalEntry = { fn, every, last: this.clock.now() };
    this.intervals.add(entry);
    return () => this.intervals.delete(entry);
  }

  setTimeout(fn: () => void, delay: number): () => void {
    const entry: TimeoutEntry = { fn, at: this.clock.now() + delay };
    this.timeouts.add(entry);
    return () => this.timeouts.delete(entry);
  }

  /** 触发所有到期任务（间隔任务最多补跑一次，避免雪崩）。 */
  runDue(): void {
    const now = this.clock.now();
    for (const entry of this.intervals) {
      if (now - entry.last >= entry.every) {
        entry.fn();
        entry.last = now;
      }
    }
    const due = [...this.timeouts].filter((e) => e.at <= now);
    this.timeouts = new Set([...this.timeouts].filter((e) => e.at > now));
    due.forEach((e) => e.fn());
  }
}

export class FakeBus implements Bus {
  private handlers = new Set<(message: unknown) => void>();
  constructor(private hub: Hub) {}

  post(message: unknown): void {
    this.hub.deliver(this, message);
  }

  on(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
  }

  /** 测试注入：模拟一条延迟 / 乱序 / 重放的入站消息。 */
  emitForTest(message: unknown): void {
    this.deliver(message);
  }

  deliver(message: unknown): void {
    [...this.handlers].forEach((handler) => handler(message));
  }
}

export class Hub {
  private buses = new Set<FakeBus>();
  /** 被网络分区的总线：入站消息直接丢弃（模拟网卡顿）。 */
  private partitioned = new Set<FakeBus>();

  connect(): FakeBus {
    const bus = new FakeBus(this);
    this.buses.add(bus);
    return bus;
  }

  setPartitioned(bus: FakeBus, on: boolean): void {
    if (on) this.partitioned.add(bus);
    else this.partitioned.delete(bus);
  }

  deliver(from: FakeBus, message: unknown): void {
    for (const bus of this.buses) {
      if (bus !== from && !this.partitioned.has(bus)) bus.deliver(message);
    }
  }
}

export class FakeKV implements KeyValueStore {
  /** 休眠时丢弃入站 storage 事件（读仍可用，模拟冻结标签页）。 */
  paused = false;

  constructor(private cluster: KVCluster) {}

  read(key: string): string | null {
    return this.cluster.data.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.cluster.write(this, key, value);
  }

  onStorage(
    key: string,
    handler: (value: string | null, oldValue: string | null) => void,
  ): () => void {
    return this.cluster.subscribe(this, key, (value, oldValue) => {
      if (!this.paused) handler(value, oldValue);
    });
  }
}

interface StorageListener {
  owner: FakeKV;
  key: string;
  handler: (value: string | null, oldValue: string | null) => void;
}

export class KVCluster {
  data = new Map<string, string>();
  private listeners: StorageListener[] = [];

  connect(): FakeKV {
    return new FakeKV(this);
  }

  write(from: FakeKV, key: string, value: string): void {
    const old = this.data.get(key) ?? null;
    this.data.set(key, value);
    for (const listener of this.listeners) {
      if (listener.owner !== from && listener.key === key) {
        listener.handler(value, old);
      }
    }
  }

  subscribe(
    owner: FakeKV,
    key: string,
    handler: (value: string | null, oldValue: string | null) => void,
  ): () => void {
    const entry: StorageListener = { owner, key, handler };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }
}

/** 跨「标签页」共享的假 Web Locks：同名锁 Promise 链串行化。 */
export class FakeLocks implements LockManager {
  private chains = new Map<string, Promise<unknown>>();

  runExclusive<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.chains.get(name) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    this.chains.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}

export interface Seat {
  id: string;
  name: string;
  coordinator: Coordinator;
  bus: FakeBus;
  kv: FakeKV;
  scheduler: FakeScheduler;
}

/** 完整的多席位「浏览器」环境，全部组件共享同一个时钟/总线/KV/锁集群。 */
export class Harness {
  readonly clock = new FakeClock();
  readonly hub = new Hub();
  readonly kvCluster = new KVCluster();
  readonly locks = new FakeLocks();
  readonly seats = new Map<string, Seat>();

  /** 嗅探总线上的全部消息。 */
  readonly sniffer = this.hub.connect();
  readonly messages: ControlMessage[] = [];

  constructor() {
    this.sniffer.on((message) => {
      this.messages.push(message as ControlMessage);
    });
  }

  seat(name: string, ttlMs = 5000): Seat {
    const id = `seat-${name}`;
    const scheduler = new FakeScheduler(this.clock);
    const bus = this.hub.connect();
    const kv = this.kvCluster.connect();
    const coordinator = new Coordinator({
      seatId: id,
      clock: this.clock,
      bus,
      kv,
      locks: this.locks,
      scheduler,
      ttlMs,
      renewIntervalMs: 1500,
    });
    coordinator.setSeatName(name);
    const seat: Seat = { id, name, coordinator, bus, kv, scheduler };
    this.seats.set(id, seat);
    return seat;
  }

  /** 模拟刷新：旧实例销毁，用同一 seatId 新建 Coordinator（共享存储）。 */
  refresh(seat: Seat): Seat {
    seat.coordinator.stop();
    const scheduler = new FakeScheduler(this.clock);
    const bus = this.hub.connect();
    const kv = this.kvCluster.connect();
    const coordinator = new Coordinator({
      seatId: seat.id,
      clock: this.clock,
      bus,
      kv,
      locks: this.locks,
      scheduler,
      ttlMs: 5000,
      renewIntervalMs: 1500,
    });
    const refreshed: Seat = { ...seat, coordinator, bus, kv, scheduler };
    this.seats.set(seat.id, refreshed);
    return refreshed;
  }

  /** 推进时钟并驱动指定席位的计时器（不指定 = 时间流逝但全员休眠）。 */
  advance(ms: number, seats?: Seat[]): void {
    this.clock.advance(ms);
    (seats ?? [...this.seats.values()]).forEach((s) => s.scheduler.runDue());
  }

  /** 只推进时钟，不触发任何人的计时器（模拟全员卡住）。 */
  elapse(ms: number): void {
    this.clock.advance(ms);
  }

  tick(seat: Seat): void {
    seat.scheduler.runDue();
  }

  /** 隔离席位的入站消息（模拟该窗口网卡顿 / 休眠）。 */
  partition(seat: Seat): void {
    this.hub.setPartitioned(seat.bus, true);
  }

  heal(seat: Seat): void {
    this.hub.setPartitioned(seat.bus, false);
  }

  /** 模拟标签页休眠：入站消息与 storage 事件全部丢弃，但本地读写照常。 */
  sleep(seat: Seat): void {
    this.partition(seat);
    seat.kv.paused = true;
  }

  wake(seat: Seat): void {
    this.heal(seat);
    seat.kv.paused = false;
  }

  /** 向某席位注入一条任意消息（模拟延迟 / 乱序 / 重放）。 */
  inject(seat: Seat, message: ControlMessage): void {
    seat.bus.emitForTest(message);
  }

  lastCommand(): Extract<ControlMessage, { kind: 'command' }> {
    const found = [...this.messages].reverse().find((m) => m.kind === 'command');
    if (!found || found.kind !== 'command') throw new Error('no command seen');
    return found;
  }
}

/** 排空 Coordinator 内部的 Promise 链（锁 / 状态读改写 / 消息处理）。 */
export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function issue(
  seat: Seat,
  action: { type: 'cut'; input: number } | { type: 'black' } | { type: 'freeze' },
) {
  const result = await seat.coordinator.issue(action);
  await flush();
  return result;
}

export function role(seat: Seat): 'leader' | 'standby' | 'idle' {
  return seat.coordinator.getSnapshot().role;
}

export function applied(seat: Seat) {
  return seat.coordinator.getSnapshot().results.filter((r) => r.status === 'applied');
}
