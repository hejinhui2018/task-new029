import { useEffect, useReducer, useRef } from 'react';
import {
  BroadcastChannelBus,
  Coordinator,
  DelayedBus,
  LocalStorageStore,
  PausableBus,
  PausableKV,
  realClock,
  RealScheduler,
  WebLockManager,
} from './core';

export interface ConsoleHandles {
  coordinator: Coordinator;
  setSleeping: (sleeping: boolean) => void;
  setDelayMs: (ms: number) => void;
  setDuplicate: (enabled: boolean) => void;
}

/**
 * 装配真实浏览器适配器：
 *
 * BroadcastChannel ── PausableBus（休眠挂起）── DelayedBus（延迟/重复）── Coordinator
 * localStorage      ── PausableKV（休眠挂起 storage 事件）
 *
 * 每个标签页在 sessionStorage 里持有独立 seatId，因此多开标签页即多个席位；
 * F5 刷新 seatId 不变，租约与执行记录从 localStorage 恢复。
 *
 * 模块级注册表按 seatId 复用实例：React StrictMode 的
 * mount→unmount→mount 以及 HMR 重渲染都不会造出第二个协调器。
 */
const registry = new Map<string, ConsoleHandles>();

export function useCoordinator(): {
  snapshot: ReturnType<Coordinator['getSnapshot']>;
  handles: ConsoleHandles;
} {
  const handlesRef = useRef<ConsoleHandles | null>(null);
  if (!handlesRef.current) {
    const seatId = getOrCreateSeatId();
    const existing = registry.get(seatId);
    if (existing) {
      handlesRef.current = existing;
    } else {
      const scheduler = new RealScheduler();
      const channel = new BroadcastChannelBus();
      const pausableBus = new PausableBus(channel);
      const delayedBus = new DelayedBus(pausableBus, scheduler);
      const rawKv = new LocalStorageStore();
      const kv = new PausableKV(rawKv);
      const coordinator = new Coordinator({
        seatId,
        clock: realClock,
        bus: delayedBus,
        kv,
        locks: new WebLockManager(),
        scheduler,
      });

      const handles: ConsoleHandles = {
        coordinator,
        setSleeping: (sleeping: boolean) => {
          if (sleeping) {
            scheduler.freeze();
            pausableBus.pause();
            kv.pause();
          } else {
            scheduler.unfreeze();
            pausableBus.resume();
            kv.resume();
          }
        },
        setDelayMs: (ms: number) => delayedBus.setDelay(ms),
        setDuplicate: (enabled: boolean) => delayedBus.setDuplicate(enabled),
      };
      registry.set(seatId, handles);
      handlesRef.current = handles;
    }
  }

  const handles = handlesRef.current;
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    const unsubscribe = handles.coordinator.subscribe(forceUpdate);
    // 租约倒计时每秒刷新 4 次。
    const timer = window.setInterval(forceUpdate, 250);
    window.addEventListener('online', forceUpdate);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', forceUpdate);
    };
  }, [handles]);

  // 注意：不在卸载时 stop()——页面关闭时浏览器自动回收
  // BroadcastChannel / Web Locks；注册表保证同页只有一个实例。

  return {
    snapshot: handles.coordinator.getSnapshot(),
    handles,
  };
}

function getOrCreateSeatId(): string {
  const KEY = 'pc.seatId';
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `seat-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
}
