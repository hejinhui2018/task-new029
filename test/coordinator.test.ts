import { describe, expect, it } from 'vitest';
import type { CommandMessage } from '../src/core/protocol';
import {
  flush,
  Harness,
  issue,
  role,
} from './helpers/harness';

const cut = (input: number) => ({ type: 'cut', input }) as const;

async function settled<T>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  await flush();
  return result;
}

describe('选举与租约', () => {
  it('同时启动多个席位时只有一个主控，epoch 从 1 开始', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    const c = h.seat('大屏C');
    await flush();

    const leaders = [a, b, c].filter((s) => role(s) === 'leader');
    expect(leaders).toHaveLength(1);
    const leader = leaders[0];
    expect(leader.coordinator.getSnapshot().lease?.epoch).toBe(1);
    expect([a, b, c].filter((s) => role(s) === 'standby')).toHaveLength(2);
  });

  it('主控续约：TTL 内持续心跳，租约不丢失、epoch 不增长', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    expect(role(a)).toBe('leader');

    for (let i = 0; i < 4; i++) {
      h.advance(1200); // 小于续约间隔的推进，全员 tick
      await flush();
    }
    expect(role(a)).toBe('leader');
    expect(a.coordinator.getSnapshot().lease?.epoch).toBe(1);
    expect(role(b)).toBe('standby');
  });

  it('租约过期接管：主控休眠超过 TTL，备机接管且 epoch +1', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    expect(role(a)).toBe('leader');

    // A 休眠：时间走过整个 TTL，只有 B 在跑节拍。
    h.advance(5200, [b]);
    await flush();

    expect(role(b)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);
    expect(b.coordinator.getSnapshot().lease?.leaderId).toBe(b.id);
  });

  it('多个备机在租约过期瞬间同时抢占，仍只有一个赢家，epoch 只增加一次', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    const c = h.seat('备机C');
    await flush();

    // A 死掉，B/C 在过期后的同一节拍都尝试接管。
    expect(role(a)).toBe('leader');
    h.advance(5200, [b, c]);
    await flush(12);

    const leaders = [b, c].filter((s) => role(s) === 'leader');
    expect(leaders).toHaveLength(1);
    const epoch = b.coordinator.getSnapshot().lease?.epoch;
    expect(epoch).toBe(2);
    expect(c.coordinator.getSnapshot().lease?.epoch).toBe(2);
  });

  it('强制接管：备机无需等待过期，立即赢得主控并把旧主控踢下台', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    expect(role(a)).toBe('leader');

    const won = await settled(b.coordinator.forceTakeover());
    expect(won).toBe(true);
    expect(role(b)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);

    // takeover 消息同步送达 A。
    await flush();
    expect(role(a)).toBe('standby');
  });

  it('正常交接：主控主动让位，目标席位 epoch+1 接任', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    const c = h.seat('大屏C');
    await flush();

    a.coordinator.handoffTo(b.id);
    await flush(8);

    expect(role(a)).toBe('standby');
    expect(role(b)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);
    // C 也通过 takeover 广播看到了新任期。
    expect(c.coordinator.getSnapshot().lease?.epoch).toBe(2);
  });

  it('过期的交接消息（租期已又一次易主）被忽略', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    const c = h.seat('备机C');
    await flush();

    // A 向 B 发起交接，但 B 正处在网络分区中没收到；C 随后强制接管到 epoch 2。
    h.partition(b);
    a.coordinator.handoffTo(b.id);
    await flush(8);
    await settled(c.coordinator.forceTakeover());
    expect(c.coordinator.getSnapshot().lease?.epoch).toBe(2);

    // B 恢复后，那条迟到的 epoch 1 交接才送达，必须被忽略。
    h.heal(b);
    h.inject(b, {
      kind: 'handoff',
      toSeatId: b.id,
      fromLeaderId: a.id,
      epoch: 1,
      at: h.clock.now(),
    });
    await flush(8);

    expect(role(b)).toBe('standby');
    expect(role(c)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);
  });
});

describe('旧主控恢复与 fencing', () => {
  it('休眠的旧主控醒来后立即点切台：锁内复核失败，命令被拒绝并退位', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    await settled(issue(a, cut(1)));

    // A 休眠（入站消息 + storage 事件全部冻结）超过 TTL，B 接管到 epoch 2。
    h.sleep(a);
    h.advance(5200, [b]);
    await flush();
    expect(role(b)).toBe('leader');
    // A 内存里仍以为自己是 leader（尚未跑任何节拍，也没收到任何通知）。
    expect(role(a)).toBe('leader');

    const result = await a.coordinator.issue(cut(2));
    await flush();

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('旧窗口');
    expect(role(a)).toBe('standby');
    // B 的播出状态没有收到任何 epoch 1 的重复切台。
    const bApplied = b.coordinator
      .getSnapshot()
      .results.filter((r) => r.status === 'applied');
    expect(bApplied.map((r) => r.action)).toEqual([cut(1)]);
  });

  it('旧 epoch 的延迟命令在新任期被所有席位拒绝', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    await settled(issue(a, cut(1)));

    // epoch 1 签发的第二条命令被「卡住」，等 B 强制接管后才送达。
    const stale: CommandMessage = {
      kind: 'command',
      id: 'stale-cmd',
      seq: 2,
      leaderId: a.id,
      epoch: 1,
      action: cut(2),
      issuedAt: h.clock.now(),
    };
    await settled(b.coordinator.forceTakeover());
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);

    h.inject(b, stale);
    await flush();

    const staleResult = b.coordinator
      .getSnapshot()
      .results.find((r) => r.id === 'stale-cmd');
    expect(staleResult?.status).toBe('rejected');
    expect(staleResult?.reason).toContain('旧任期');
  });

  it('在途宽限：命令在租期内签发，短延迟到达仍执行；超过一个 TTL 则拒绝', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();

    // t=4000，A 健康续约，租约到期时间 = 9000。
    h.advance(4000);
    await flush();
    const inFlight: CommandMessage = {
      kind: 'command',
      id: 'in-flight',
      seq: 1,
      leaderId: a.id,
      epoch: 1,
      action: cut(3),
      issuedAt: h.clock.now(), // 4000
    };
    // A 停续约，时间走到 9500：租约已过期 500ms，但签发点仍在一个 TTL 窗口内。
    h.elapse(5500);
    h.inject(b, inFlight);
    await flush();
    const r1 = b.coordinator.getSnapshot().results.find((r) => r.id === 'in-flight');
    expect(r1?.status).toBe('applied');

    // 远超 TTL 的迟到命令必须拒绝。
    const ancient: CommandMessage = {
      kind: 'command',
      id: 'ancient',
      seq: 1,
      leaderId: a.id,
      epoch: 1,
      action: cut(4),
      issuedAt: h.clock.now() - 10_000,
    };
    h.inject(b, ancient);
    await flush();
    const r2 = b.coordinator.getSnapshot().results.find((r) => r.id === 'ancient');
    expect(r2?.status).toBe('rejected');
  });

  it('迟到的旧 takeover / lease-update 不能把现任主控踢下台', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    const c = h.seat('大屏C');
    await flush();
    await settled(b.coordinator.forceTakeover());
    await flush();
    expect(role(b)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);

    // 一条延迟很久的 epoch 1 takeover 与 lease-update 迟到。
    h.inject(b, {
      kind: 'takeover',
      newLeaderId: a.id,
      oldEpoch: 0,
      newEpoch: 1,
      at: h.clock.now(),
    });
    h.inject(c, {
      kind: 'lease-update',
      lease: {
        leaderId: a.id,
        epoch: 1,
        expiresAt: h.clock.now() + 5000,
        ttlMs: 5000,
      },
      at: h.clock.now(),
    });
    await flush();

    expect(role(b)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);
    expect(c.coordinator.getSnapshot().lease?.epoch).toBe(2);
  });
});

describe('幂等、乱序与补缺', () => {
  it('重复命令只执行一次，第二次回放为 duplicate', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();

    const first = await settled(issue(a, cut(1)));
    expect(first.status).toBe('applied');
    await flush();

    // 重传：把同一条命令再投递给 B 两次。
    const cmd = h.lastCommand();
    h.inject(b, cmd);
    await flush();
    h.inject(b, cmd);
    await flush();

    const bResults = b.coordinator.getSnapshot().results;
    const applied = bResults.filter((r) => r.status === 'applied');
    const duplicates = bResults.filter((r) => r.status === 'duplicate');
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe(cmd.id);
    expect(duplicates).toHaveLength(2);
  });

  it('乱序跳号且无法补缺时拒绝，后续正常命令不受影响', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();

    const jump: CommandMessage = {
      kind: 'command',
      id: 'jump',
      seq: 5,
      leaderId: a.id,
      epoch: 1,
      action: cut(5),
      issuedAt: h.clock.now(),
    };
    h.inject(b, jump);
    await flush();
    expect(
      b.coordinator.getSnapshot().results.find((r) => r.id === 'jump')?.status,
    ).toBe('rejected');

    // 日志里没有 seq1-4，无法补缺；水位仍是 0，正常的 #1 可以执行。
    await settled(issue(a, cut(1)));
    const appliedResults = b.coordinator
      .getSnapshot()
      .results.filter((r) => r.status === 'applied');
    expect(appliedResults.map((r) => r.seq)).toEqual([1]);
    expect(appliedResults[0].action).toEqual(cut(1));
  });

  it('分区恢复：漏掉的命令通过共享日志按序补齐，再执行新命令', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    const c = h.seat('大屏C');
    await flush();

    // C 被网络分区，A 的 #1 #2 全部漏掉。
    h.partition(c);
    await settled(issue(a, cut(1)));
    await settled(issue(a, cut(2)));
    expect(c.coordinator.getSnapshot().results).toHaveLength(0);

    // 恢复后 A 再发 #3：C 收到时应先补 #1 #2 再执行 #3。
    h.heal(c);
    await settled(issue(a, cut(3)));

    const cApplied = c.coordinator
      .getSnapshot()
      .results.filter((r) => r.status === 'applied');
    expect(cApplied.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(cApplied.map((r) => r.action)).toEqual([cut(1), cut(2), cut(3)]);
    expect(cApplied[0].recovered).toBe(true);
    expect(cApplied[1].recovered).toBe(true);
    expect(cApplied[2].recovered).toBeUndefined();
    // 在线的 B 始终正常。
    const bApplied = b.coordinator
      .getSnapshot()
      .results.filter((r) => r.status === 'applied');
    expect(bApplied.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('序列号回溯（旧消息重放）被拒绝', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();

    const c1 = await settled(issue(a, cut(1)));
    const c2 = await settled(issue(a, cut(2)));
    expect(c1.status).toBe('applied');
    expect(c2.status).toBe('applied');

    // 重放 #1（新 ID 伪装不行，这里直接构造同 seq 不同 id 的回溯消息）。
    const replay: CommandMessage = {
      kind: 'command',
      id: 'replay-old-seq',
      seq: 1,
      leaderId: a.id,
      epoch: 1,
      action: cut(1),
      issuedAt: h.clock.now(),
    };
    h.inject(b, replay);
    await flush();
    expect(
      b.coordinator.getSnapshot().results.find((r) => r.id === 'replay-old-seq')
        ?.status,
    ).toBe('rejected');
  });
});

describe('刷新恢复', () => {
  it('主控刷新：同 seatId 恢复为 leader，租约与 epoch 延续', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    await settled(issue(a, cut(1)));
    await settled(issue(a, cut(2)));

    const a2 = h.refresh(a);
    await flush();
    expect(role(a2)).toBe('leader');
    expect(a2.coordinator.getSnapshot().lease?.epoch).toBe(1);
    expect(a2.coordinator.getSnapshot().appliedSeq).toBe(2);

    // 续约正常，刷新后发出的 #3 继续递增。
    h.advance(1000);
    await flush();
    const r3 = await a2.coordinator.issue(cut(3));
    expect(r3.status).toBe('applied');
    expect(r3.seq).toBe(3);
    // B 收到 #3 也正常。
    await flush();
    const bSeq = b.coordinator
      .getSnapshot()
      .results.filter((r) => r.status === 'applied')
      .map((r) => r.seq);
    expect(bSeq).toEqual([1, 2, 3]);
  });

  it('备机刷新：恢复已执行水位，刷新期间漏掉的命令走补缺', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();
    await settled(issue(a, cut(1)));

    // B 刷新，期间 A 又发了 #2。
    const b2 = h.refresh(b);
    await flush();
    await settled(issue(a, cut(2)));
    await settled(issue(a, cut(3)));

    const applied = b2.coordinator
      .getSnapshot()
      .results.filter((r) => r.status === 'applied');
    expect(applied.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('刷新期间集群已易主：旧主控刷新后以备机身份加入，不再发令', async () => {
    const h = new Harness();
    const a = h.seat('导播A');
    const b = h.seat('备机B');
    await flush();

    // A「刷新」（关闭窗口），B 等租约过期接管。
    h.advance(5200, [b]);
    await flush();
    expect(role(b)).toBe('leader');
    expect(b.coordinator.getSnapshot().lease?.epoch).toBe(2);

    const a2 = h.refresh(a);
    await flush();
    expect(role(a2)).toBe('standby');
    const result = await a2.coordinator.issue(cut(9));
    expect(result.status).toBe('rejected');
  });
});
