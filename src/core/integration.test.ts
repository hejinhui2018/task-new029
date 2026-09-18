import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../core/env';
import { parseLease } from '../core/protocol';
import type { PlayoutCommand } from '../core/types';
import { flush, World, type SeatRuntime } from '../testing/world';

/** 找出某席位日志里某命令 id 的记录 */
function findRecord(rt: SeatRuntime, id: string) {
  return rt.core.snapshot().log.find((r) => r.command.id === id);
}

function countApplied(rt: SeatRuntime): number {
  return rt.core.snapshot().log.filter((r) => r.status === 'applied').length;
}

function makeCommand(
  from: string,
  epoch: number,
  seq: number,
  now: number,
  over: Partial<PlayoutCommand> = {},
): PlayoutCommand {
  return {
    id: `manual-${epoch}-${seq}-${now}-${Math.random().toString(36).slice(2, 6)}`,
    from,
    type: 'switch',
    input: 7,
    epoch,
    seq,
    issuedAt: now,
    ...over,
  };
}

describe('多席位集成场景', () => {
  it('三个席位同时启动：只有一个主控，epoch 从 1 开始', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    const c = w.createSeat('C');
    [a, b, c].forEach((r) => w.start(r));
    await flush();

    const leaders = [a, b, c].filter((r) => r.core.snapshot().role === 'leader');
    expect(leaders).toHaveLength(1);
    const lease = parseLease(w.kv.raw(STORAGE_KEYS.lease));
    expect(lease?.epoch).toBe(1);
    // 所有席位认知一致
    for (const r of [a, b, c]) {
      expect(r.core.snapshot().lease?.holderId).toBe(leaders[0]!.seat.id);
    }
  });

  it('主控命令在全体席位恰好执行一次；备机不能签发', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(50);

    const leader = a.core.snapshot().role === 'leader' ? a : b;
    const standby = leader === a ? b : a;

    const rec = await leader.core.issue('switch', 3);
    expect(rec?.status).toBe('applied');
    await flush();

    expect(leader.core.snapshot().currentInput).toBe(3);
    expect(standby.core.snapshot().currentInput).toBe(3);
    expect(countApplied(leader)).toBe(1);
    expect(countApplied(standby)).toBe(1);

    const rejected = await standby.core.issue('switch', 4);
    expect(rejected?.status).toBe('rejected');
    // 备机签发失败不影响 PGM
    expect(standby.core.snapshot().currentInput).toBe(3);
  });

  it('租约过期接管：主控休眠过 TTL，备机以 epoch+1 接管且唯一', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    expect(a.core.snapshot().role).toBe('leader');

    // A 休眠 5s，远超 TTL=1s；期间 B 收不到任何 A 的消息
    a.core.sleep(5000);
    w.advance(1100); // 到 t=1200，租约在 1000 过期，B 在 tick 接管
    await flush();

    expect(b.core.snapshot().role).toBe('leader');
    expect(b.core.snapshot().lease?.epoch).toBe(2);
    expect(a.core.snapshot().role).toBe('leader'); // 仍在休眠，尚未“醒来”

    w.advance(5000); // A 醒来
    await flush();
    expect(a.core.snapshot().role).toBe('standby');
    expect(a.core.snapshot().lease?.holderId).toBe('B');

    // 只有一个主控
    expect([a, b].filter((r) => r.core.snapshot().role === 'leader')).toHaveLength(1);
  });

  it('旧主控恢复后：它携带旧 epoch 的命令被新主控拒绝，动作不重复执行', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);

    await a.core.issue('switch', 2); // epoch=1 seq=1，两席都执行
    await flush();
    expect(countApplied(b)).toBe(1);

    a.core.sleep(5000);
    w.advance(6100); // B 接管 epoch=2，A 也已醒来
    await flush();
    expect(b.core.snapshot().role).toBe('leader');
    expect(a.core.snapshot().role).toBe('standby');

    // 旧主控窗口“恢复”后又点了一次切台 → 本地直接拒绝签发
    const stale = await a.core.issue('switch', 5);
    expect(stale?.status).toBe('rejected');
    expect(a.core.snapshot().currentInput).toBe(2);

    // 再模拟一条迟到的旧 epoch 命令（seq 更大也没用，epoch 围栏先拦）
    const oldCmd = makeCommand('A', 1, 99, w.clock.now(), { input: 8 });
    w.probePost({ kind: 'command', command: oldCmd });
    await flush();
    const onB = findRecord(b, oldCmd.id);
    expect(onB?.status).toBe('rejected');
    expect(onB?.reason).toContain('旧 epoch');
    // PGM 没有被旧命令改动
    expect(b.core.snapshot().currentInput).toBe(2);
    expect(countApplied(b)).toBe(1);
  });

  it('新主控命令在接管后可以正常执行，seq 从 1 重新计数', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    await a.core.issue('switch', 2);
    a.core.sleep(5000);
    w.advance(6100);
    await flush();

    const rec = await b.core.issue('switch', 4);
    expect(rec?.status).toBe('applied');
    expect(rec?.command.epoch).toBe(2);
    expect(rec?.command.seq).toBe(1);
    await flush();
    expect(a.core.snapshot().currentInput).toBe(4);
  });

  it('重复广播：同一命令投递两次，第二次幂等忽略且不重复执行', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(50);
    const leader = a.core.snapshot().role === 'leader' ? a : b;
    const standby = leader === a ? b : a;

    const rec = await leader.core.issue('switch', 6);
    await flush();
    expect(countApplied(standby)).toBe(1);

    // 网络/页面重发完全相同的消息
    w.probePost({ kind: 'command', command: rec!.command });
    await flush();
    const dup = findRecord(standby, rec!.command.id);
    expect(dup?.status).toBe('duplicate');
    expect(countApplied(standby)).toBe(1); // 仍然只执行一次
  });

  it('乱序 seq：先到 seq=2 被拒绝，seq=1 到达后正常执行', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(50);
    const leader = a.core.snapshot().role === 'leader' ? a : b;
    const standby = leader === a ? b : a;
    const epoch = leader.core.snapshot().lease!.epoch;
    const holder = leader.seat.id;
    const now = w.clock.now();

    const c2 = makeCommand(holder, epoch, 2, now, { input: 2 });
    const c1 = makeCommand(holder, epoch, 1, now, { input: 1 });
    w.probePost({ kind: 'command', command: c2 });
    await flush();
    expect(findRecord(standby, c2.id)?.status).toBe('rejected');
    expect(standby.core.snapshot().currentInput).toBe(1); // 初始值，未被改变

    w.probePost({ kind: 'command', command: c1 });
    await flush();
    expect(findRecord(standby, c1.id)?.status).toBe('applied');
    expect(standby.core.snapshot().currentInput).toBe(1); // CH1 与初始相同，改用录制验证动作
  });

  it('同时强制接管：两个备机同时点击，只有一个成功且 epoch 只跳一次', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    const c = w.createSeat('C');
    w.start(a);
    w.start(b);
    w.start(c);
    await flush();
    w.advance(100);
    expect(a.core.snapshot().role).toBe('leader');
    expect(a.core.snapshot().lease!.epoch).toBe(1);

    // 两次点击之间不 flush，模拟真正同时进入锁队列
    b.core.forceTakeover();
    c.core.forceTakeover();
    await flush();

    const leaders = [a, b, c].filter((r) => r.core.snapshot().role === 'leader');
    expect(leaders).toHaveLength(1);
    const winner = leaders[0]!;
    expect(['B', 'C']).toContain(winner.seat.id);
    const lease = parseLease(w.kv.raw(STORAGE_KEYS.lease));
    expect(lease?.epoch).toBe(2);
    expect(lease?.holderId).toBe(winner.seat.id);

    // 旧主控 A 已下台
    expect(a.core.snapshot().role).toBe('standby');
  });

  it('强制接管后：旧主控任何在途/补发命令被拒，新主控命令生效', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    await a.core.issue('switch', 2);

    b.core.forceTakeover();
    await flush();
    expect(b.core.snapshot().role).toBe('leader');
    expect(b.core.snapshot().lease!.epoch).toBe(2);

    // 旧主控的“在途”旧 epoch 命令
    const stale = makeCommand('A', 1, 2, w.clock.now(), { input: 8 });
    w.probePost({ kind: 'command', command: stale });
    await flush();
    expect(findRecord(b, stale.id)?.status).toBe('rejected');
    expect(b.core.snapshot().currentInput).toBe(2);

    const rec = await b.core.issue('switch', 5);
    expect(rec?.command.epoch).toBe(2);
    await flush();
    expect(a.core.snapshot().currentInput).toBe(5);
  });

  it('正常交接：主控主动释放，备机以新 epoch 平稳接管', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    expect(a.core.snapshot().role).toBe('leader');

    a.core.handover();
    await flush();
    w.advance(250); // B 在下一个 tick 接管，A 处于回避期
    await flush();

    expect(b.core.snapshot().role).toBe('leader');
    expect(b.core.snapshot().lease?.epoch).toBe(2);
    expect(a.core.snapshot().role).toBe('standby');

    const rec = await b.core.issue('switch', 3);
    expect(rec?.command.epoch).toBe(2);
    await flush();
    expect(a.core.snapshot().currentInput).toBe(3);

    // A 的回避期过后仍不会抢回（B 的租约有效）
    w.advance(500);
    await flush();
    expect(b.core.snapshot().role).toBe('leader');
    expect(a.core.snapshot().role).toBe('standby');
  });

  it('刷新恢复：主控在租约内刷新，恢复身份且业务状态/epoch 不丢', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    await a.core.issue('switch', 5);
    await a.core.issue('rec', null);
    await flush();
    const epochBefore = a.core.snapshot().lease!.epoch;

    // A 在租约有效期内刷新
    const a2 = w.reload(a);
    await flush();
    expect(a2.core.snapshot().role).toBe('leader');
    expect(a2.core.snapshot().lease!.epoch).toBe(epochBefore);
    expect(a2.core.snapshot().currentInput).toBe(5);
    expect(a2.core.snapshot().recording).toBe(true);

    // 续期继续正常，B 仍承认 A
    w.advance(400);
    await flush();
    expect(a2.core.snapshot().role).toBe('leader');
    expect(b.core.snapshot().lease?.holderId).toBe('A');

    // 恢复后还能继续发命令，seq 接着增长
    const rec = await a2.core.issue('stop', null);
    expect(rec?.command.seq).toBe(3);
  });

  it('刷新恢复：备机刷新后从 storage 恢复业务视图', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    await a.core.issue('switch', 4);
    await flush();

    const b2 = w.reload(b);
    await flush();
    expect(b2.core.snapshot().role).toBe('standby');
    expect(b2.core.snapshot().currentInput).toBe(4);
    expect(b2.core.snapshot().maxEpoch).toBe(1);
  });

  it('入站长延迟：超过命令寿命的迟到命令被拒绝（storage 状态另路对账）', async () => {
    // 长 TTL：本测试只验证命令新鲜度，排除心跳也被延迟导致的接管干扰
    const w = new World({ delayed: true, leaseTtlMs: 10_000, maxCommandAgeMs: 2000 });
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    expect(a.core.snapshot().role).toBe('leader');

    // 仅给 B 的入站链路加 3s 延迟（命令寿命 2s）
    b.link.delayMs = 3000;
    const rec = await a.core.issue('switch', 3);
    await flush();
    w.advance(3000);
    await flush();

    const onB = findRecord(b, rec!.command.id);
    expect(onB?.status).toBe('rejected');
    expect(onB?.reason).toContain('过期');
  });

  it('迟到的旧 epoch heartbeat 不能让旧主控复活、也不能让新主控下台', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(100);
    expect(a.core.snapshot().role).toBe('leader');

    b.core.forceTakeover();
    await flush();
    expect(b.core.snapshot().role).toBe('leader');
    expect(a.core.snapshot().role).toBe('standby');

    // 网络里一条来自 A 的旧 epoch=1 heartbeat 延迟到达（且尚未按其自身时间过期）
    const oldLease = {
      holderId: 'A',
      epoch: 1,
      acquiredAt: 0,
      expiresAt: w.clock.now() + 5000,
      reason: 'handover' as const,
    };
    w.probePost({ kind: 'heartbeat', lease: oldLease });
    await flush();

    expect(b.core.snapshot().role).toBe('leader');
    expect(a.core.snapshot().role).toBe('standby');
    expect([a, b].filter((r) => r.core.snapshot().role === 'leader')).toHaveLength(1);
  });

  it('租约持续续约：主控不过 TTL 休眠时一直保持主控', async () => {
    const w = new World();
    const a = w.createSeat('A');
    const b = w.createSeat('B');
    w.start(a);
    w.start(b);
    await flush();
    w.advance(5000); // 远超 5 个 TTL，靠每 300ms 续期维持
    await flush();
    expect(a.core.snapshot().role).toBe('leader');
    expect(b.core.snapshot().role).toBe('standby');
    expect(a.core.snapshot().lease!.epoch).toBe(1);
  });
});
