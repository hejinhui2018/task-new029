import { useEffect, useRef, useState } from 'react';
import {
  createBrowserBus,
  createBrowserClock,
  createBrowserLocks,
  createBrowserStorage,
} from '../core/env';
import { createDelayedBus, createDelayedKV, createLinkConditions } from '../core/pipe';
import { PlayoutCore } from '../core/PlayoutCore';
import type { PlayoutSnapshot, Seat } from '../core/types';

const CHANNEL_NAME = 'pocc.channel.v1';

export function usePlayoutCore(seat: Seat): { core: PlayoutCore; link: ReturnType<typeof createLinkConditions> } {
  const ref = useRef<{ core: PlayoutCore; link: ReturnType<typeof createLinkConditions> } | null>(null);
  if (!ref.current) {
    const clock = createBrowserClock();
    const link = createLinkConditions();
    // 入站（BroadcastChannel + storage 事件）统一经过延迟/抖动/休眠管道
    const bus = createDelayedBus(createBrowserBus(CHANNEL_NAME), clock, link);
    const storage = createDelayedKV(createBrowserStorage(''), clock, link);
    const core = new PlayoutCore({
      self: seat,
      clock,
      bus,
      storage,
      locks: createBrowserLocks(),
      link,
    });
    ref.current = { core, link };
  }
  return ref.current;
}

/** 订阅引擎快照并管理生命周期 */
export function useSnapshot(core: PlayoutCore): PlayoutSnapshot {
  const [snap, setSnap] = useState<PlayoutSnapshot>(() => core.snapshot());
  useEffect(() => {
    const unsubscribe = core.setSnapshotListener((s) => setSnap(s));
    core.start();
    setSnap(core.snapshot());
    return () => {
      unsubscribe();
      core.close();
    };
  }, [core]);
  return snap;
}
