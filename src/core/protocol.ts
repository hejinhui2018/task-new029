/**
 * 协议与持久化结构定义。
 *
 * 防双执行的两道闸门：
 *  1. fencing token：每条命令携带签发时的 leaderId + epoch，
 *     执行器只认「当前仍在任、且 epoch 相同」的主控；
 *  2. 命令序列号 + 去重集合：乱序命令丢弃，重复命令幂等回放上次结果。
 */

export const STORAGE_KEYS = {
  lease: 'pc.lease.v1',
  state: 'pc.state.v1',
} as const;

export const LOCK_NAME = 'pc-lease-v1';
export const CHANNEL_NAME = 'pc-control-v1';

/** 默认租约 TTL 与续约节奏。 */
export const DEFAULT_LEASE_TTL_MS = 5000;
export const DEFAULT_RENEW_INTERVAL_MS = 1500;

export type SeatRole = 'leader' | 'standby' | 'idle';

/** localStorage 中的租约记录。 */
export interface LeaseRecord {
  /** 当前主控席位 ID。 */
  leaderId: string;
  /** 单调递增的任期号，每次易主 +1。 */
  epoch: number;
  /** 租约到期的绝对时钟时间（毫秒）。 */
  expiresAt: number;
  /** 租约 TTL，方便接管方沿用。 */
  ttlMs: number;
}

/** 播控台支持的动作（示意：切台 / 黑场 / 应急静帧）。 */
export type CommandAction =
  | { type: 'cut'; input: number }
  | { type: 'black' }
  | { type: 'freeze' };

/** 主控广播给所有席位执行的命令。 */
export interface CommandMessage {
  kind: 'command';
  /** 全局唯一命令 ID（去重键）。 */
  id: string;
  /** 主控端单调序列号（乱序检测）。 */
  seq: number;
  /** 签发时的 fencing token。 */
  leaderId: string;
  epoch: number;
  action: CommandAction;
  issuedAt: number;
}

/** 主控向备机的正常交接。 */
export interface HandoffMessage {
  kind: 'handoff';
  toSeatId: string;
  fromLeaderId: string;
  epoch: number;
  at: number;
}

/** 席位声明「我还活着」，用于刷新后补全席位名录。 */
export interface HelloMessage {
  kind: 'hello';
  seatId: string;
  name?: string;
  at: number;
}

/** 主控租约被我强制接管的声明（旧主控据此立刻退位）。 */
export interface TakeoverNotice {
  kind: 'takeover';
  newLeaderId: string;
  oldEpoch: number;
  newEpoch: number;
  at: number;
}

/** 租约被写入 localStorage（续约 / 易主），storage 事件不可靠时的冗余通道。 */
export interface LeaseUpdateMessage {
  kind: 'lease-update';
  lease: LeaseRecord;
  at: number;
}

export type ControlMessage =
  | CommandMessage
  | HandoffMessage
  | HelloMessage
  | TakeoverNotice
  | LeaseUpdateMessage;

/** 单条命令在某个席位上的执行结果。 */
export interface CommandResult {
  id: string;
  seq: number;
  epoch: number;
  action: CommandAction;
  status: 'applied' | 'duplicate' | 'rejected';
  /** rejected / duplicate 时给出原因，界面直接展示。 */
  reason?: string;
  /** applied：是否为分区恢复后从共享日志补执行。 */
  recovered?: boolean;
  at: number;
}

/** 每个席位的瞬时视图（内存态 + localStorage 镜像）。 */
export interface SeatInfo {
  id: string;
  name: string;
  role: SeatRole;
  epoch: number | null;
  /** 最近一次 hello/心跳时间，用于判断席位是否在线。 */
  lastSeenAt: number;
  /** 该席位已执行到的命令序列号。 */
  appliedSeq: number;
  online: boolean;
}

/** localStorage 中持久化的集群状态（刷新后恢复）。 */
export interface PersistedState {
  /** 各席位已应用的命令结果（含 duplicate/rejected 留痕），key = seatId。 */
  results: Record<string, CommandResult[]>;
  /** 各席位最近观测时间，key = seatId。 */
  presence: Record<string, number>;
  /** 席位自定义名称，key = seatId。 */
  names: Record<string, string>;
  /** 主控端的命令序列号水位（每个 epoch 从 1 重新计数）。 */
  lastSeq: number;
  /** lastSeq 对应的任期号。 */
  lastSeqEpoch: number;
  /** 主控签发过的命令日志（供分区恢复的席位连续补执行），新主控写、全员读。 */
  log: CommandMessage[];
  /** 最近动作摘要，大屏 / 新标签页打开时即可看到。 */
  lastCommand: CommandMessage | null;
}

export function emptyPersistedState(): PersistedState {
  return {
    results: {},
    presence: {},
    names: {},
    lastSeq: 0,
    lastSeqEpoch: 0,
    log: [],
    lastCommand: null,
  };
}

/** 描述动作的中文短标签，界面与日志共用。 */
export function describeAction(action: CommandAction): string {
  switch (action.type) {
    case 'cut':
      return `切到 ${action.input} 号机`;
    case 'black':
      return '黑场';
    case 'freeze':
      return '应急静帧';
  }
}
