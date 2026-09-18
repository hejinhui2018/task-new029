import type { Clock, KVStore, MessageBus } from './env';
import type { WireMessage } from './types';

/**
 * 入站链路条件：引擎休眠时 sleeping=true，管道据此丢弃入站消息
 * （BroadcastChannel 不缓存标签页挂起期间的消息，这里如实模拟）。
 * delayMs / jitter 可在运行时由界面实时调整。
 */
export interface LinkConditions {
  delayMs: number;
  jitter: boolean;
  sleeping: boolean;
}

export function createLinkConditions(): LinkConditions {
  return { delayMs: 0, jitter: false, sleeping: false };
}

export interface RandomSource {
  random(): number;
}

function scheduleDeliver<T>(
  clock: Clock,
  cond: LinkConditions,
  rng: RandomSource,
  deliver: (payload: T) => void,
  payload: T,
): void {
  if (cond.sleeping) return;
  const wait = cond.delayMs + (cond.jitter ? Math.floor(rng.random() * cond.delayMs) : 0);
  clock.setTimeout(() => {
    // 等待期间进入休眠也丢弃
    if (cond.sleeping) return;
    deliver(payload);
  }, wait);
}

/**
 * 给任意 MessageBus 包一层入站延迟 / 抖动乱序 / 休眠丢弃。
 * 只影响本席“收到”消息的时刻；出站立即发送。
 */
export function createDelayedBus(
  inner: MessageBus,
  clock: Clock,
  cond: LinkConditions,
  rng: RandomSource = Math,
): MessageBus {
  const handlers = new Set<(msg: WireMessage) => void>();
  inner.onMessage((msg) => {
    scheduleDeliver(clock, cond, rng, (m) => handlers.forEach((h) => h(m)), msg);
  });
  return {
    post: (msg) => inner.post(msg),
    onMessage: (cb) => {
      handlers.add(cb);
    },
    close() {
      handlers.clear();
      inner.close();
    },
  };
}

/** storage 事件走同一套延迟/丢弃管道，保证两条同步路径都能被现场演习 */
export function createDelayedKV(
  inner: KVStore,
  clock: Clock,
  cond: LinkConditions,
  rng: RandomSource = Math,
): KVStore {
  const handlers = new Set<(key: string, value: string | null) => void>();
  inner.onStorage((key, value) => {
    scheduleDeliver(clock, cond, rng, (p) => handlers.forEach((h) => h(p[0], p[1])), [
      key,
      value,
    ] as const);
  });
  return {
    get: (k) => inner.get(k),
    set: (k, v) => inner.set(k, v),
    onStorage: (cb) => {
      handlers.add(cb);
    },
  };
}
