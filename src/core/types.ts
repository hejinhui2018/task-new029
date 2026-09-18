// 核心类型定义：席位、租约、命令、执行记录、线协议消息

export type SeatKind = 'director' | 'backup' | 'screen';

export const SEAT_KIND_LABEL: Record<SeatKind, string> = {
  director: '导播主机',
  backup: '备机',
  screen: '现场大屏',
};

export interface Seat {
  /** 标签页唯一标识（每个标签页一个独立席位，存 sessionStorage） */
  id: string;
  kind: SeatKind;
  label: string;
}

/**
 * 主控租约。
 * epoch 是单调递增的围栏令牌（fencing token）：
 * 每次产生新主控（过期接管 / 强制接管 / 正常交接）都 +1，
 * 旧主控即使恢复，也只能携带更小的 epoch，其命令会被拒绝。
 */
export interface Lease {
  holderId: string;
  epoch: number;
  acquiredAt: number;
  /** 绝对过期时间（注入时钟的毫秒时间戳） */
  expiresAt: number;
  reason: AcquireReason;
}

export type AcquireReason = 'initial' | 'expiry' | 'force' | 'handover';

export type CommandType = 'switch' | 'rec' | 'stop';

export interface PlayoutCommand {
  /** 逻辑动作唯一 ID，幂等去重的主键 */
  id: string;
  from: string;
  type: CommandType;
  /** switch 目标通道 1..8 */
  input: number | null;
  /** 签发时主控的 epoch（围栏） */
  epoch: number;
  /** 同一 epoch 内严格递增的序号 */
  seq: number;
  issuedAt: number;
}

export type CommandStatus = 'applied' | 'duplicate' | 'rejected';

export interface CommandRecord {
  command: PlayoutCommand;
  status: CommandStatus;
  /** applied 为 null；duplicate/rejected 给出原因 */
  reason: string | null;
  at: number;
  /** 在哪个席位上得出的执行结果 */
  seatId: string;
}

/** 持久化到 localStorage 的状态快照（仅主控写入） */
export interface PersistedState {
  version: 1;
  /** 快照对应的主控 epoch */
  epoch: number;
  /** 该 epoch 内最后一个已应用命令的 seq（0 表示尚无命令） */
  seq: number;
  currentInput: number;
  recording: boolean;
  /** 最近应用过的命令 id，用于刷新后继续去重 */
  appliedIds: string[];
  /** 最近各 epoch 的 seq，越界防御 */
  epochSeq: Array<{ epoch: number; seq: number }>;
  /** 历史上见过的最大 epoch */
  maxEpoch: number;
  log: CommandRecord[];
  updatedAt: number;
}

export type ClaimReason = AcquireReason;

/** BroadcastChannel 线协议 */
export type WireMessage =
  | { kind: 'hello'; seat: Seat }
  | { kind: 'claim'; lease: Lease }
  | { kind: 'heartbeat'; lease: Lease }
  | {
      kind: 'command';
      command: PlayoutCommand;
    }
  | { kind: 'release'; holderId: string; epoch: number };

export type EventKind = 'system' | 'gain' | 'lose' | 'info' | 'reject';

export interface ElectionEvent {
  id: number;
  at: number;
  kind: EventKind;
  text: string;
}

export interface SeatInfo {
  seat: Seat;
  lastSeenAt: number;
  isSelf: boolean;
}

export interface PlayoutSnapshot {
  self: Seat;
  role: 'leader' | 'standby';
  lease: Lease | null;
  /** 毫秒；null 表示无租约 */
  remainingMs: number | null;
  maxEpoch: number;
  /** 主控实际签发命令使用的围栏 epoch */
  commandEpoch: number;
  /** 当前 epoch 下一条命令将使用的 seq（备机为 0） */
  nextSeq: number;
  currentInput: number;
  recording: boolean;
  log: CommandRecord[];
  events: ElectionEvent[];
  seats: SeatInfo[];
  sleeping: boolean;
  sleepUntil: number | null;
  inboundDelayMs: number;
  inboundJitter: boolean;
  now: number;
}

export const SWITCH_INPUTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
