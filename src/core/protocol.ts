import type {
  CommandRecord,
  Lease,
  PersistedState,
  PlayoutCommand,
} from './types';

export const DEFAULT_LEASE_TTL_MS = 6000;
export const RENEW_INTERVAL_MS = 2000;
export const TICK_INTERVAL_MS = 250;
/** 持久化状态里最多保留多少条已应用命令 id（环形去重窗口） */
export const APPLIED_ID_WINDOW = 200;
export const LOG_LIMIT = 60;

/* ------------------------------ 租约决策 ------------------------------ */

export function parseLease(raw: string | null): Lease | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Lease;
    if (
      typeof v.holderId !== 'string' ||
      typeof v.epoch !== 'number' ||
      typeof v.expiresAt !== 'number'
    ) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function leaseAlive(lease: Lease | null, now: number): boolean {
  return !!lease && lease.expiresAt > now;
}

/**
 * 刷新恢复后，主控把自己的命令围栏 epoch 对齐到“全体已见过的最大 epoch”。
 * 租约对象的 epoch 是 leadership 代数，而持久化状态里可能记录了更新代数
 * 下的命令（例如旧主控刷新前 storage 已被新主控写入）；取两者最大值，
 * 保证恢复后绝不用偏小的 epoch 签发命令。
 */
export function fenceFromLease(lease: Lease, state: PersistedState): number {
  return Math.max(lease.epoch, state.maxEpoch);
}

export interface ClaimInput {
  selfId: string;
  current: Lease | null;
  now: number;
  ttl: number;
  reason: Lease['reason'];
  /** 自己当前持有的 epoch（恢复时防自降） */
  ownEpoch?: number;
  /**
   * 强制接管时，调用方发起动作那一刻所针对的 epoch。
   * 进入锁后若发现租约已被别人（并发的另一个强制接管者）更新到更大 epoch，
   * 本次接管放弃——保证同时强制接管只有一个赢家、epoch 只跳一次。
   */
  forceTargetEpoch?: number;
}

/**
 * 统一的竞争写入决策（在 Web Lock 内、对 storage 当前值执行）。
 *
 * 规则：
 * - 现有租约仍然有效，且不是强制接管 → 不能抢占（避免脑裂）；
 * - 正常交接：只有现持有者自己可以续期/更新（release 后他人 initial 接管 epoch+1）；
 * - 过期接管 / 强制接管：新 epoch = max(旧 epoch, 自己见过的最大 epoch) + 1；
 * - 初始获取：沿用存储中见过的最大 epoch +1，epoch 绝不倒退。
 */
export function decideClaim(input: ClaimInput): Lease | null {
  const { selfId, current, now, ttl, reason, forceTargetEpoch } = input;
  const ownEpoch = input.ownEpoch ?? 0;
  const base = Math.max(current?.epoch ?? 0, ownEpoch);

  if (reason === 'handover') {
    // 续期或交接更新：必须是现持有者本人
    if (current && current.holderId !== selfId) return null;
    return {
      holderId: selfId,
      epoch: current ? current.epoch : base + 1,
      acquiredAt: current ? current.acquiredAt : now,
      expiresAt: now + ttl,
      reason: 'handover',
    };
  }

  if (leaseAlive(current, now) && reason !== 'force') {
    return null;
  }

  if (reason === 'force') {
    // 强制接管无需等待过期，但同样必须抬升 epoch；
    // 并发强制接管时，只允许针对“当前 epoch”的第一个请求成功。
    if (forceTargetEpoch != null && current && current.epoch > forceTargetEpoch) {
      return null;
    }
    if (current && current.holderId === selfId) {
      return { ...current, expiresAt: now + ttl };
    }
  }

  return {
    holderId: selfId,
    epoch: base + 1,
    acquiredAt: now,
    expiresAt: now + ttl,
    reason,
  };
}

/* ------------------------------ 持久化状态 ------------------------------ */

export function createInitialState(now: number): PersistedState {
  return {
    version: 1,
    epoch: 0,
    seq: 0,
    currentInput: 1,
    recording: false,
    appliedIds: [],
    epochSeq: [],
    maxEpoch: 0,
    log: [],
    updatedAt: now,
  };
}

export function parseState(raw: string | null, now: number): PersistedState {
  if (raw) {
    try {
      const v = JSON.parse(raw) as PersistedState;
      if (v.version === 1 && typeof v.epoch === 'number') return v;
    } catch {
      /* 损坏则重建 */
    }
  }
  return createInitialState(now);
}

export function rememberApplied(
  state: PersistedState,
  cmd: PlayoutCommand,
  at: number,
): PersistedState {
  const ids = [...state.appliedIds, cmd.id];
  if (ids.length > APPLIED_ID_WINDOW) ids.splice(0, ids.length - APPLIED_ID_WINDOW);
  return {
    ...state,
    epoch: cmd.epoch,
    seq: cmd.seq,
    currentInput: nextInput(state.currentInput, cmd),
    recording: nextRecording(state.recording, cmd),
    appliedIds: ids,
    epochSeq: bumpEpochSeq(state.epochSeq, cmd.epoch, cmd.seq),
    maxEpoch: Math.max(state.maxEpoch, cmd.epoch),
    updatedAt: at,
  };
}

export function bumpEpochSeq(
  list: Array<{ epoch: number; seq: number }>,
  epoch: number,
  seq: number,
): Array<{ epoch: number; seq: number }> {
  const out = list.filter((e) => e.epoch !== epoch);
  out.push({ epoch, seq });
  // 只保留最近 10 个 epoch
  out.sort((a, b) => a.epoch - b.epoch);
  if (out.length > 10) out.splice(0, out.length - 10);
  return out;
}

export function lastSeqForEpoch(
  state: PersistedState,
  epoch: number,
): number {
  if (state.epoch === epoch) return state.seq;
  const hit = state.epochSeq.find((e) => e.epoch === epoch);
  return hit ? hit.seq : 0;
}

/* ------------------------------ 命令校验 ------------------------------ */

export type ValidationVerdict =
  | { ok: true; status: 'applied'; reason: null }
  | { ok: false; status: 'duplicate' | 'rejected'; reason: string };

export interface ValidateContext {
  state: PersistedState;
  /** 当前活跃租约（广播到达时刻） */
  activeLease: Lease | null;
  now: number;
  selfId: string;
  /** 消息可被接受的最大延迟（签发时间过旧则拒绝，防止休眠后回放） */
  maxCommandAgeMs: number;
  /**
   * 期望的命令 epoch（命令围栏）。
   * 主控用自己的 commandEpoch；备机取 max(租约 epoch, 持久化 maxEpoch)，
   * 以容忍 lease 广播与 state storage 事件的到达顺序差。
   */
  expectedEpoch: number;
}

/**
 * 判定一条收到的命令是 applied / duplicate / rejected。
 * 任意一条不满足即拒绝；重复命令幂等返回 duplicate（不重复执行动作）。
 */
export function validateCommand(
  cmd: PlayoutCommand,
  ctx: ValidateContext,
): ValidationVerdict {
  const { state, activeLease, now } = ctx;

  if (state.appliedIds.includes(cmd.id)) {
    return { ok: false, status: 'duplicate', reason: '重复命令（idempotency-key 命中，已执行过）' };
  }

  // 1) 新鲜度：签发时间不能来自遥远的过去（休眠恢复 / 延迟回放）
  const age = now - cmd.issuedAt;
  if (age > ctx.maxCommandAgeMs) {
    return { ok: false, status: 'rejected', reason: `命令过期（延迟 ${age}ms > ${ctx.maxCommandAgeMs}ms）` };
  }
  if (age < -30_000) {
    return { ok: false, status: 'rejected', reason: '命令时间戳异常（来自未来）' };
  }

  // 2) epoch 围栏：
  //    命令 epoch 必须等于本席当前期望的主控围栏；
  //    更小 = 旧主控残留（或旧命令延迟到达），更大 = 本席状态落后/来源未知。
  if (cmd.epoch < ctx.expectedEpoch) {
    return {
      ok: false,
      status: 'rejected',
      reason: `旧 epoch ${cmd.epoch} < 当前 ${ctx.expectedEpoch}（旧主控残留/延迟回放，拒绝）`,
    };
  }
  if (cmd.epoch > ctx.expectedEpoch) {
    return {
      ok: false,
      status: 'rejected',
      reason: `命令 epoch ${cmd.epoch} > 当前 ${ctx.expectedEpoch}（来源未知或本席落后，拒绝）`,
    };
  }
  if (!activeLease) {
    return { ok: false, status: 'rejected', reason: `当前无活跃主控租约（命令 epoch ${cmd.epoch}）` };
  }
  if (!leaseAlive(activeLease, now)) {
    return {
      ok: false,
      status: 'rejected',
      reason: `命令到达时 epoch ${cmd.epoch} 的租约已过期（迟到消息，拒绝）`,
    };
  }
  if (activeLease.holderId !== cmd.from) {
    return {
      ok: false,
      status: 'rejected',
      reason: `发送者 ${cmd.from} 并非 epoch ${cmd.epoch} 的持有者 ${activeLease.holderId}`,
    };
  }

  // 3) seq：同一 epoch 内必须严格连续；乱序 / 重放都拒绝（id 重复走 duplicate）
  const lastSeq = lastSeqForEpoch(state, cmd.epoch);
  if (cmd.seq <= lastSeq) {
    return {
      ok: false,
      status: 'rejected',
      reason: `seq ${cmd.seq} 已过期（该 epoch 已到 ${lastSeq}，乱序/重放）`,
    };
  }
  if (cmd.seq !== lastSeq + 1) {
    return {
      ok: false,
      status: 'rejected',
      reason: `seq 乱序：收到 ${cmd.seq}，期望 ${lastSeq + 1}`,
    };
  }

  // 4) 载荷校验
  if (cmd.type === 'switch' && (cmd.input == null || cmd.input < 1 || cmd.input > 8)) {
    return { ok: false, status: 'rejected', reason: 'switch 缺少合法通道号 1..8' };
  }

  return { ok: true, status: 'applied', reason: null };
}

export function buildRecord(
  cmd: PlayoutCommand,
  verdict: ValidationVerdict,
  at: number,
  seatId: string,
): CommandRecord {
  return {
    command: cmd,
    status: verdict.status,
    reason: verdict.reason,
    at,
    seatId,
  };
}

export function appendLog(state: PersistedState, rec: CommandRecord): PersistedState {
  const log = [...state.log, rec];
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  return { ...state, log };
}

/* ------------------------------ 状态机动作 ------------------------------ */

function nextInput(current: number, cmd: PlayoutCommand): number {
  if (cmd.type === 'switch' && cmd.input != null) return cmd.input;
  return current;
}

function nextRecording(current: boolean, cmd: PlayoutCommand): boolean {
  if (cmd.type === 'rec') return true;
  if (cmd.type === 'stop') return false;
  return current;
}
