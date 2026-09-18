import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  decideClaim,
  rememberApplied,
  validateCommand,
} from './protocol';
import type { Lease, PlayoutCommand } from './types';

const NOW = 10_000;

function lease(over: Partial<Lease> = {}): Lease {
  return {
    holderId: 'A',
    epoch: 3,
    acquiredAt: NOW - 1000,
    expiresAt: NOW + 5000,
    reason: 'initial',
    ...over,
  };
}

function cmd(over: Partial<PlayoutCommand> = {}): PlayoutCommand {
  return {
    id: 'c1',
    from: 'A',
    type: 'switch',
    input: 2,
    epoch: 3,
    seq: 1,
    issuedAt: NOW,
    ...over,
  };
}

function ctx(state = createInitialState(NOW), active: Lease | null = lease()) {
  return {
    state,
    activeLease: active,
    now: NOW,
    selfId: 'B',
    maxCommandAgeMs: 2000,
    expectedEpoch: active?.epoch ?? 3,
  };
}

describe('decideClaim — 竞争写入决策', () => {
  it('租约有效时不能抢占', () => {
    expect(
      decideClaim({ selfId: 'B', current: lease(), now: NOW, ttl: 6000, reason: 'initial' }),
    ).toBeNull();
  });

  it('过期接管：epoch 在旧值上 +1', () => {
    const d = decideClaim({
      selfId: 'B',
      current: lease({ expiresAt: NOW - 1 }),
      now: NOW,
      ttl: 6000,
      reason: 'expiry',
    });
    expect(d?.epoch).toBe(4);
    expect(d?.holderId).toBe('B');
    expect(d?.reason).toBe('expiry');
  });

  it('强制接管：未过期也可夺取，epoch +1', () => {
    const d = decideClaim({
      selfId: 'B',
      current: lease(),
      now: NOW,
      ttl: 6000,
      reason: 'force',
      forceTargetEpoch: 3,
    });
    expect(d?.epoch).toBe(4);
  });

  it('同时强制接管：锁内发现 epoch 已被并发者抬升则放弃', () => {
    // B 点击时针对 epoch=3，但锁内当前已是 C 写入的 epoch=4
    const d = decideClaim({
      selfId: 'B',
      current: lease({ holderId: 'C', epoch: 4 }),
      now: NOW,
      ttl: 6000,
      reason: 'force',
      forceTargetEpoch: 3,
    });
    expect(d).toBeNull();
  });

  it('epoch 不倒退：自己见过更大 epoch 时以其为底', () => {
    const d = decideClaim({
      selfId: 'B',
      current: null,
      now: NOW,
      ttl: 6000,
      reason: 'initial',
      ownEpoch: 9,
    });
    expect(d?.epoch).toBe(10);
  });

  it('handover 续期只有持有者本人可做', () => {
    expect(
      decideClaim({ selfId: 'B', current: lease(), now: NOW, ttl: 6000, reason: 'handover' }),
    ).toBeNull();
    const d = decideClaim({
      selfId: 'A',
      current: lease(),
      now: NOW,
      ttl: 6000,
      reason: 'handover',
    });
    expect(d?.epoch).toBe(3);
    expect(d?.expiresAt).toBe(NOW + 6000);
  });
});

describe('validateCommand — 围栏 / seq / 幂等 / 新鲜度', () => {
  it('合法命令通过', () => {
    expect(validateCommand(cmd(), ctx()).status).toBe('applied');
  });

  it('重复 id 幂等：duplicate 而非再次执行', () => {
    let s = createInitialState(NOW);
    s = rememberApplied(s, cmd(), NOW);
    const v = validateCommand(cmd(), ctx(s));
    expect(v.status).toBe('duplicate');
  });

  it('旧 epoch（旧主控残留）拒绝', () => {
    const v = validateCommand(cmd({ epoch: 2 }), ctx());
    expect(v.status).toBe('rejected');
    expect(v.reason).toContain('旧 epoch');
  });

  it('未来 epoch（来源未知/本席落后）拒绝', () => {
    const v = validateCommand(cmd({ epoch: 4 }), ctx());
    expect(v.status).toBe('rejected');
    expect(v.reason).toContain('> 当前');
  });

  it('发送者不是该 epoch 持有者：拒绝', () => {
    const v = validateCommand(cmd({ from: 'X' }), ctx());
    expect(v.status).toBe('rejected');
    expect(v.reason).toContain('并非');
  });

  it('无活跃租约：拒绝', () => {
    const v = validateCommand(cmd(), ctx(createInitialState(NOW), null));
    expect(v.status).toBe('rejected');
  });

  it('命令到达时租约刚好已过期（迟到的同 epoch 消息）：拒绝', () => {
    const v = validateCommand(
      cmd(),
      ctx(createInitialState(NOW), lease({ expiresAt: NOW })),
    );
    // ctx 的 now 为 NOW，expiresAt=NOW 不算 alive
    expect(v.status).toBe('rejected');
    expect(v.reason).toContain('租约已过期');
  });

  it('乱序 seq（跳号）拒绝', () => {
    let s = createInitialState(NOW);
    s = rememberApplied(s, cmd({ seq: 1 }), NOW);
    const v = validateCommand(cmd({ id: 'c3', seq: 3 }), ctx(s));
    expect(v.status).toBe('rejected');
    expect(v.reason).toContain('乱序');
  });

  it('重放 seq（小于等于已见）拒绝', () => {
    let s = createInitialState(NOW);
    s = rememberApplied(s, cmd({ seq: 1, id: 'c1' }), NOW);
    s = rememberApplied(s, cmd({ seq: 2, id: 'c2' }), NOW);
    const v = validateCommand(cmd({ id: 'old', seq: 1 }), ctx(s));
    expect(v.status).toBe('rejected');
  });

  it('严格连续 seq 通过', () => {
    let s = createInitialState(NOW);
    s = rememberApplied(s, cmd({ seq: 1, id: 'c1' }), NOW);
    expect(validateCommand(cmd({ id: 'c2', seq: 2 }), ctx(s)).status).toBe('applied');
  });

  it('命令过旧（延迟/休眠回放）拒绝', () => {
    const v = validateCommand(cmd({ issuedAt: NOW - 5000 }), ctx());
    expect(v.status).toBe('rejected');
    expect(v.reason).toContain('过期');
  });

  it('时间戳来自未来：拒绝', () => {
    const v = validateCommand(cmd({ issuedAt: NOW + 999_999 }), ctx());
    expect(v.status).toBe('rejected');
  });

  it('非法通道号拒绝', () => {
    expect(validateCommand(cmd({ input: 9 }), ctx()).status).toBe('rejected');
    expect(validateCommand(cmd({ input: null }), ctx()).status).toBe('rejected');
  });
});
