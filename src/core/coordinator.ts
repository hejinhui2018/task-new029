/**
 * Coordinator：每个席位一个，承载全部租约 / 选举 / 命令裁决逻辑。
 *
 * 正确性要点：
 *
 * 1. 租约 + epoch（fencing token）
 *    - 租约是 localStorage 里的一条记录 {leaderId, epoch, expiresAt}，TTL 5s，
 *      主控每 1.5s 在 Web Lock 内续约；
 *    - 每次易主（过期接管 / 强制接管 / 交接）epoch 严格 +1；
 *    - 命令携带签发时的 (leaderId, epoch)。执行前与当前租约比对，
 *      任何旧 epoch 的命令一律 rejected —— 休眠醒来的旧主控发出的切台，
 *      在它自己这里和所有备机这里都会被拦下。
 *
 * 2. 主控签发前的锁内复核
 *    旧主控醒来时内存里仍以为自己是 leader。任何切台命令在签发前都要在
 *    Web Lock 内重新读租约：已易主则立刻退位并拒绝；只有「租约仍记录自己、
 *    且未过期（或在锁内率先完成续约）」时才能签发。
 *
 * 3. 序列号 + 命令 ID 幂等
 *    - seq 主控端严格递增，执行端只接受 appliedSeq + 1，乱序（缺口 / 回溯）拒绝；
 *    - 同一命令 ID 重复投递（重传 / 重复广播）不重复执行，回放为 duplicate。
 *
 * 4. 冗余的退位通知：storage 事件 + BroadcastChannel(takeover/lease-update)
 *    + 续约时锁内对账，任一通道存活旧主控都会退位。
 */
import type {
  Bus,
  Clock,
  KeyValueStore,
  LockManager,
  Scheduler,
} from './types';
import {
  CHANNEL_NAME,
  CommandAction,
  CommandMessage,
  CommandResult,
  ControlMessage,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RENEW_INTERVAL_MS,
  emptyPersistedState,
  LeaseRecord,
  LOCK_NAME,
  PersistedState,
  SeatInfo,
  SeatRole,
  STORAGE_KEYS,
} from './protocol';

const STATE_LOCK_NAME = 'pc-state-v1';
const HELLO_INTERVAL_MS = 2500;
const ONLINE_TIMEOUT_MS = 8000;
const RESULTS_PER_SEAT_CAP = 40;
const COMMAND_LOG_CAP = 200;

export interface CoordinatorOptions {
  seatId: string;
  clock: Clock;
  bus: Bus;
  kv: KeyValueStore;
  locks: LockManager;
  scheduler: Scheduler;
  ttlMs?: number;
  renewIntervalMs?: number;
}

export interface CoordinatorSnapshot {
  now: number;
  seatId: string;
  role: SeatRole;
  /** 当前集群租约（可能属于别的席位）。 */
  lease: LeaseRecord | null;
  /** 当前租约剩余毫秒（按注入时钟实时计算）。 */
  remainingMs: number;
  /** 本席位已执行到的 seq。 */
  appliedSeq: number;
  /** 本席位最近的命令执行结果（含拒绝 / 去重留痕）。 */
  results: CommandResult[];
  /** 全部席位的结果表（来自 localStorage 镜像）。 */
  allResults: Record<string, CommandResult[]>;
  seats: SeatInfo[];
  lastCommand: CommandMessage | null;
  lastSeq: number;
}

export class Coordinator {
  private readonly seatId: string;
  private readonly clock: Clock;
  private readonly bus: Bus;
  private readonly kv: KeyValueStore;
  private readonly locks: LockManager;
  private readonly scheduler: Scheduler;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;

  private role: SeatRole = 'idle';
  private lease: LeaseRecord | null = null;
  private state: PersistedState = emptyPersistedState();
  private appliedSeq = 0;
  /** appliedSeq 对应的任期；收到新任期命令时水位从 0 重新计。 */
  private appliedEpoch = 0;
  /** 命令 ID -> 首次执行结果，用于重复投递幂等回放。 */
  private seenCommands = new Map<string, CommandResult>();
  /** 防止自己收到自己广播造成的回声。 */
  private lastHelloAt = 0;

  private listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];
  private stopped = false;

  constructor(options: CoordinatorOptions) {
    this.seatId = options.seatId;
    this.clock = options.clock;
    this.bus = options.bus;
    this.kv = options.kv;
    this.locks = options.locks;
    this.scheduler = options.scheduler;
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;

    this.bootstrap();
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  get id(): string {
    return this.seatId;
  }

  /** 刷新恢复：直接从 localStorage 读取租约与集群状态。 */
  private bootstrap(): void {
    this.state = this.readState();
    this.lease = this.readLease();
    this.seatName = this.state.names[this.seatId] ?? this.seatId.slice(0, 6);

    const ownResults = this.state.results[this.seatId] ?? [];
    // 水位只认真正执行过的 applied 记录，且只取当前租约任期；
    // rejected 的乱序 seq 不能抬高水位，否则刷新后合法补缺命令会被误判回溯。
    const leaseEpoch = this.lease?.epoch ?? 0;
    this.appliedEpoch = leaseEpoch;
    this.appliedSeq = ownResults
      .filter((r) => r.status === 'applied' && r.epoch === leaseEpoch)
      .reduce((max, r) => Math.max(max, r.seq), 0);
    for (const result of ownResults) {
      // 去重表只恢复 applied；拒绝/重复记录只用于审计留痕。
      if (result.status === 'applied') {
        this.seenCommands.set(result.id, result);
      }
    }

    if (this.lease && this.lease.leaderId === this.seatId) {
      if (this.lease.expiresAt > this.clock.now()) {
        this.role = 'leader';
      } else {
        // 自己的租约已过期：先以备机身份启动，由 tick 走锁内接管/让位裁决。
        this.role = 'standby';
      }
    } else if (this.lease) {
      this.role = 'standby';
    }

    const offMsg = this.bus.on((message) => this.handleMessage(message));
    this.disposers.push(offMsg);

    const offLeaseStorage = this.kv.onStorage(STORAGE_KEYS.lease, () => {
      this.observeLease(this.readLease(), 'storage');
    });
    const offStateStorage = this.kv.onStorage(STORAGE_KEYS.state, () => {
      this.state = this.readState();
      this.emitChange();
    });
    this.disposers.push(offLeaseStorage, offStateStorage);

    // 租约维护与抢占尝试共用一个节拍；休眠冻结期间它一并停摆。
    const offTick = this.scheduler.setInterval(() => {
      void this.tick();
    }, this.renewIntervalMs);
    const offHello = this.scheduler.setInterval(() => {
      this.sayHello();
    }, HELLO_INTERVAL_MS);
    this.disposers.push(offTick, offHello);

    this.sayHello();
    void this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.disposers.forEach((dispose) => dispose());
    this.disposers = [];
    this.listeners.clear();
    try {
      this.bus.close();
    } catch {
      /* 已关闭 */
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    this.listeners.forEach((listener) => listener());
  }

  // ── 快照（React useSyncExternalStore 使用） ──────────────────────────

  getSnapshot(): CoordinatorSnapshot {
    const now = this.clock.now();
    return {
      now,
      seatId: this.seatId,
      role: this.role,
      lease: this.lease,
      remainingMs: this.lease ? Math.max(0, this.lease.expiresAt - now) : 0,
      appliedSeq: this.appliedSeq,
      results: this.state.results[this.seatId] ?? [],
      allResults: this.state.results,
      seats: this.buildSeatInfos(now),
      lastCommand: this.state.lastCommand,
      lastSeq: this.state.lastSeq,
    };
  }

  private buildSeatInfos(now: number): SeatInfo[] {
    const ids = new Set<string>([
      this.seatId,
      ...Object.keys(this.state.presence),
      ...Object.keys(this.state.results),
    ]);
    if (this.lease) ids.add(this.lease.leaderId);

    const seats: SeatInfo[] = [];
    for (const id of ids) {
      const lastSeenAt =
        id === this.seatId
          ? Math.max(now, this.state.presence[id] ?? 0)
          : this.state.presence[id] ?? 0;
      const online =
        id === this.seatId || now - lastSeenAt <= ONLINE_TIMEOUT_MS;
      const isLeader =
        !!this.lease &&
        this.lease.leaderId === id &&
        this.lease.expiresAt > now;
      const results = this.state.results[id] ?? [];
      seats.push({
        id,
        name: this.state.names[id] ?? id.slice(0, 6),
        role: isLeader ? 'leader' : online ? 'standby' : 'idle',
        epoch: this.lease?.epoch ?? null,
        lastSeenAt,
        appliedSeq: results.reduce((max, r) => Math.max(max, r.seq), 0),
        online,
      });
    }
    return seats.sort((a, b) => {
      if (a.role === 'leader') return -1;
      if (b.role === 'leader') return 1;
      return a.id.localeCompare(b.id);
    });
  }

  // ── 租约读取 / 写入 ──────────────────────────────────────────────────

  private readLease(): LeaseRecord | null {
    const raw = this.kv.read(STORAGE_KEYS.lease);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as LeaseRecord;
      if (
        typeof parsed.leaderId !== 'string' ||
        typeof parsed.epoch !== 'number' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private writeLease(lease: LeaseRecord): void {
    this.kv.write(STORAGE_KEYS.lease, JSON.stringify(lease));
  }

  private readState(): PersistedState {
    const raw = this.kv.read(STORAGE_KEYS.state);
    if (!raw) return emptyPersistedState();
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      return {
        results: parsed.results ?? {},
        presence: parsed.presence ?? {},
        names: parsed.names ?? {},
        lastSeq: parsed.lastSeq ?? 0,
        lastSeqEpoch: parsed.lastSeqEpoch ?? 0,
        log: Array.isArray(parsed.log) ? parsed.log : [],
        lastCommand: parsed.lastCommand ?? null,
      };
    } catch {
      return emptyPersistedState();
    }
  }

  /** 跨标签页的共享状态读改写统一走 Web Lock，避免互相覆盖。 */
  private mutateState(
    fn: (state: PersistedState) => void,
  ): Promise<PersistedState> {
    return this.locks.runExclusive(STATE_LOCK_NAME, () => {
      const fresh = this.readState();
      fn(fresh);
      this.kv.write(STORAGE_KEYS.state, JSON.stringify(fresh));
      // storage 事件不会投递给本标签页，直接更新本地镜像。
      this.state = fresh;
      return fresh;
    });
  }

  // ── 主节拍：主控续约 / 备机接管 ───────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.role === 'leader') {
      await this.renewUnderLock();
    } else {
      await this.maybeAcquire(false);
    }
    this.sayHello();
  }

  /**
   * 主控续约（锁内）：
   *  - 租约仍记录自己且 epoch 相同 -> 续期（即便刚过期，只要锁内观察到
   *    记录未被改写，就说明备机还没完成接管，续约合法）；
   *  - 记录已易主 / epoch 更新 -> 立刻退位。
   */
  private async renewUnderLock(): Promise<void> {
    const renewed = await this.locks.runExclusive(LOCK_NAME, () => {
      const now = this.clock.now();
      const current = this.readLease();
      const mine =
        current &&
        current.leaderId === this.seatId &&
        current.epoch === this.lease?.epoch;
      if (!mine || !current) {
        return { ok: false as const, current };
      }
      const next: LeaseRecord = {
        ...current,
        expiresAt: now + this.ttlMs,
      };
      this.writeLease(next);
      return { ok: true as const, lease: next };
    });

    if (renewed.ok) {
      this.lease = renewed.lease;
      this.postMessage({
        kind: 'lease-update',
        lease: renewed.lease,
        at: this.clock.now(),
      });
      this.emitChange();
    } else {
      this.observeLease(renewed.current ?? this.readLease(), 'renew-miss');
    }
  }

  /**
   * 备机尝试接管。force=true 用于「强制接管」（不等租约过期）。
   * 同时抢占时，Web Lock 把竞争者串行化：后进入者读到更高的 epoch，
   * 提交后立即复读发现 leader 不是自己 -> 主动退位。
   */
  private async maybeAcquire(force: boolean): Promise<boolean> {
    const now = this.clock.now();
    const before = this.readLease();
    const expired = !before || before.expiresAt <= now;
    if (!force && !expired) {
      this.observeLease(before, 'observe');
      return false;
    }

    const committed = await this.locks.runExclusive(LOCK_NAME, () => {
      const current = this.readLease();
      const canTake =
        force || !current || current.expiresAt <= this.clock.now();
      if (!canTake) return null;

      const lease: LeaseRecord = {
        leaderId: this.seatId,
        epoch: (current?.epoch ?? 0) + 1,
        expiresAt: this.clock.now() + this.ttlMs,
        ttlMs: this.ttlMs,
      };
      this.writeLease(lease);
      return { lease, previous: current };
    });

    if (!committed) {
      this.observeLease(this.readLease(), 'acquire-lost');
      return false;
    }

    // 提交后立刻复读：若在锁释放到读到之间（或同一临界区后排队的
    // 强制接管者）已经改写，唯一合法的 leader 以最新记录为准。
    const stored = this.readLease();
    if (
      !stored ||
      stored.leaderId !== this.seatId ||
      stored.epoch !== committed.lease.epoch
    ) {
      this.observeLease(stored, 'acquire-overtaken');
      return false;
    }

    this.lease = committed.lease;
    this.role = 'leader';
    if (
      committed.previous &&
      committed.previous.leaderId !== this.seatId &&
      committed.previous.epoch < committed.lease.epoch
    ) {
      this.postMessage({
        kind: 'takeover',
        newLeaderId: this.seatId,
        oldEpoch: committed.previous.epoch,
        newEpoch: committed.lease.epoch,
        at: this.clock.now(),
      });
    }
    this.postMessage({
      kind: 'lease-update',
      lease: committed.lease,
      at: this.clock.now(),
    });
    this.emitChange();
    return true;
  }

  /**
   * 观测到一份（可能更新的）租约记录，必要时退位。
   * 严格只接受「更新」的信息：epoch 更小（迟到的旧 takeover/lease-update）、
   * 同 epoch 但 expiresAt 更早的记录一律忽略——它们可能来自延迟或乱序消息，
   * 绝不能把现任主控错误踢下台。
   */
  private observeLease(current: LeaseRecord | null, _source: string): void {
    const previous = this.lease;
    if (!current) {
      // 不会主动删除租约；null 事件（异常 storage）忽略，不影响在任主控。
      this.emitChange();
      return;
    }

    const isNewer =
      !previous ||
      current.epoch > previous.epoch ||
      (current.epoch === previous.epoch &&
        current.expiresAt > previous.expiresAt);
    if (isNewer) {
      this.lease = current;
    } else if (current.epoch < previous!.epoch) {
      // 迟到的旧任期通知：忽略。
      this.emitChange();
      return;
    }

    // 以最新接受的租约为准判断自己是否还在任。
    const known = this.lease;
    if (!known) {
      this.emitChange();
      return;
    }
    if (this.role === 'leader' && known.leaderId !== this.seatId) {
      // 旧主控发现集群已进入更新的任期：立刻退位，此后签发的任何命令
      // 都会因 fencing 不匹配被拒绝。
      this.role = 'standby';
    } else if (this.role !== 'leader') {
      this.role = 'standby';
    }
    this.emitChange();
  }

  // ── 消息处理 ─────────────────────────────────────────────────────────

  private postMessage(message: ControlMessage): void {
    try {
      this.bus.post(message);
    } catch {
      /* 通道关闭中 */
    }
  }

  private handleMessage(raw: unknown): void {
    const message = raw as ControlMessage;
    if (!message || typeof message !== 'object') return;

    switch (message.kind) {
      case 'hello':
        void this.recordPresence(message.seatId, message.at, message.name);
        break;
      case 'takeover':
        this.observeLease(
          {
            leaderId: message.newLeaderId,
            epoch: message.newEpoch,
            expiresAt: message.at + this.ttlMs,
            ttlMs: this.ttlMs,
          },
          'takeover-msg',
        );
        break;
      case 'lease-update':
        this.observeLease(message.lease, 'lease-msg');
        break;
      case 'handoff':
        void this.handleHandoff(message);
        break;
      case 'command':
        void this.handleCommand(message);
        break;
    }
  }

  private async recordPresence(
    seatId: string,
    at: number,
    name?: string,
  ): Promise<void> {
    if (seatId === this.seatId) return;
    await this.mutateState((state) => {
      state.presence[seatId] = Math.max(state.presence[seatId] ?? 0, at);
      if (name) state.names[seatId] = name;
    });
    this.emitChange();
  }

  private sayHello(): void {
    const now = this.clock.now();
    // 节流：测试里手动快进时可能出现补跑。
    if (now - this.lastHelloAt < 500 && this.lastHelloAt > 0) return;
    this.lastHelloAt = now;
    const name = this.seatName;
    void this.mutateState((state) => {
      state.presence[this.seatId] = now;
      state.names[this.seatId] = name;
    });
    this.postMessage({ kind: 'hello', seatId: this.seatId, name, at: now });
    this.emitChange();
  }

  /** 席位显示名（localStorage 中可修改，跨标签页共享）。 */
  private seatName: string = '';

  setSeatName(name: string): void {
    this.seatName = name.trim() || this.seatId.slice(0, 6);
    this.lastHelloAt = 0;
    this.sayHello();
  }

  getSeatName(): string {
    const fallback = this.seatName || this.seatId.slice(0, 6);
    return this.state.names[this.seatId] ?? fallback;
  }

  // ── 正常交接 ─────────────────────────────────────────────────────────

  /** 主控调用：把主控权正常交给指定席位（epoch +1）。 */
  handoffTo(targetSeatId: string): void {
    if (this.role !== 'leader' || !this.lease) return;
    const epoch = this.lease.epoch;
    // 立刻退位：交接消息即使延迟/丢失，本窗口也不会再以旧 epoch 发令；
    // 目标席位若错过消息，租约会照常走过期接管。
    this.role = 'standby';
    this.postMessage({
      kind: 'handoff',
      toSeatId: targetSeatId,
      fromLeaderId: this.seatId,
      epoch,
      at: this.clock.now(),
    });
    this.emitChange();
  }

  private async handleHandoff(message: Extract<ControlMessage, {
    kind: 'handoff';
  }>): Promise<void> {
    if (message.toSeatId !== this.seatId) return;

    const committed = await this.locks.runExclusive(LOCK_NAME, () => {
      const current = this.readLease();
      if (
        !current ||
        current.leaderId !== message.fromLeaderId ||
        current.epoch !== message.epoch
      ) {
        return null; // 租期已变（过期接管 / 又一次强制接管），忽略过期交接。
      }
      const lease: LeaseRecord = {
        leaderId: this.seatId,
        epoch: current.epoch + 1,
        expiresAt: this.clock.now() + this.ttlMs,
        ttlMs: this.ttlMs,
      };
      this.writeLease(lease);
      return lease;
    });

    if (!committed) {
      this.observeLease(this.readLease(), 'handoff-stale');
      return;
    }
    this.lease = committed;
    this.role = 'leader';
    this.postMessage({
      kind: 'takeover',
      newLeaderId: this.seatId,
      oldEpoch: message.epoch,
      newEpoch: committed.epoch,
      at: this.clock.now(),
    });
    this.postMessage({
      kind: 'lease-update',
      lease: committed,
      at: this.clock.now(),
    });
    this.emitChange();
  }

  // ── 强制接管 ─────────────────────────────────────────────────────────

  forceTakeover(): Promise<boolean> {
    return this.maybeAcquire(true);
  }

  // ── 命令签发与裁决 ───────────────────────────────────────────────────

  isLeader(): boolean {
    return this.role === 'leader';
  }

  /**
   * 主控签发命令。先在锁内复核领导权并保证租约未过期：
   * 这是「休眠醒来的旧窗口点切台」场景的最后一道本地闸门。
   * 返回本席位的执行结果（applied 或 rejected）。
   */
  async issue(action: CommandAction): Promise<CommandResult> {
    if (this.role !== 'leader' || !this.lease) {
      return this.rejectLocal(action, 0, 'not-leader', '当前不是主控，命令被拒绝');
    }

    const validated = await this.locks.runExclusive(LOCK_NAME, () => {
      const current = this.readLease();
      if (
        !current ||
        current.leaderId !== this.seatId ||
        current.epoch !== this.lease!.epoch
      ) {
        return { kind: 'lost' as const, current };
      }
      if (current.expiresAt <= this.clock.now()) {
        // 租约已过期：在锁内尝试连续性续约；若记录已被备机改写则输掉。
        const renewed: LeaseRecord = {
          ...current,
          expiresAt: this.clock.now() + this.ttlMs,
        };
        this.writeLease(renewed);
        return { kind: 'renewed' as const, lease: renewed };
      }
      return { kind: 'fresh' as const, lease: current };
    });

    if (validated.kind === 'lost') {
      this.observeLease(validated.current, 'issue-lost');
      return this.rejectLocal(action, 0, 'stale-epoch', '主控已易主，旧窗口命令被拒绝');
    }

    this.lease = validated.lease;
    this.role = 'leader';
    if (validated.kind === 'renewed') {
      // 命令时刻的救急性续约：通知备机新的到期时间，避免无意义抢占。
      this.postMessage({
        kind: 'lease-update',
        lease: validated.lease,
        at: this.clock.now(),
      });
    }

    const command = await this.allocateCommand(
      validated.lease.epoch,
      action,
    );

    // BroadcastChannel 不会回投自己，本地走同一条裁决管线，
    // 保证「自己执行」与「别人执行」的判定完全一致。
    const result = await this.acceptCommand(command);
    if (result.status === 'applied') {
      this.postMessage(command);
    }
    return result;
  }

  /** 在状态锁内分配序列号并写入命令日志，保证序号与日志原子一致。 */
  private async allocateCommand(
    epoch: number,
    action: CommandAction,
  ): Promise<CommandMessage> {
    let issued: CommandMessage | null = null;
    await this.mutateState((draft) => {
      // 序列号每个任期重新计数。
      if (draft.lastSeqEpoch !== epoch) {
        draft.lastSeqEpoch = epoch;
        draft.lastSeq = 0;
        // 旧任期日志不再用于补缺，直接丢弃。
        draft.log = [];
      }
      draft.lastSeq += 1;
      issued = {
        kind: 'command',
        id: makeCommandId(),
        seq: draft.lastSeq,
        leaderId: this.seatId,
        epoch,
        action,
        issuedAt: this.clock.now(),
      };
      draft.log.push(issued);
      if (draft.log.length > COMMAND_LOG_CAP) {
        draft.log = draft.log.slice(-COMMAND_LOG_CAP);
      }
      draft.lastCommand = issued;
    });
    return issued!;
  }

  private rejectLocal(
    action: CommandAction,
    seq: number,
    reason: string,
    reasonText: string,
  ): Promise<CommandResult> {
    const result: CommandResult = {
      id: `local-rejected-${this.clock.now()}-${localRejectCounter++}-${reason}`,
      seq,
      epoch: this.lease?.epoch ?? 0,
      action,
      status: 'rejected',
      reason: reasonText,
      at: this.clock.now(),
    };
    return this.appendResult(result).then(() => result);
  }

  /** 接收到（或本地签发的）命令：fencing -> 补缺 -> 去重 -> 序列号 -> 执行。 */
  private async handleCommand(message: CommandMessage): Promise<CommandResult> {
    return this.acceptCommand(message);
  }

  private async acceptCommand(message: CommandMessage): Promise<CommandResult> {
    const now = this.clock.now();

    // 闸门 1：fencing token 必须与当前租约完全一致（在途宽限见 issuedAt 判定）。
    const lease = this.readLease();
    let fenceFailure: string | null = null;
    if (!lease) {
      fenceFailure = '当前不存在有效主控租约';
    } else if (
      lease.leaderId !== message.leaderId ||
      lease.epoch !== message.epoch
    ) {
      fenceFailure = `命令来自旧任期（epoch ${message.epoch}，当前 ${lease.epoch}），已拒绝`;
    } else if (lease.expiresAt <= now) {
      // 租约此刻已过期：只有「签发时仍在租期窗口内」的在途消息放行
      // （签发在锁内续约之后，issuedAt 必然早于 expiresAt）；
      // 超过一个 TTL 的严重延迟仍然拒绝，绝不凭旧任期执行。
      const issuedWhileValid =
        message.issuedAt <= lease.expiresAt &&
        message.issuedAt >= lease.expiresAt - (lease.ttlMs || this.ttlMs);
      if (!issuedWhileValid) {
        fenceFailure = '命令到达时主控租约已过期且超出在途窗口，已拒绝';
      }
    }
    if (fenceFailure) {
      return this.finishRejected(message, fenceFailure);
    }

    // 序列号水位按任期维护：进入新任期时重新从 0 计数。
    if (message.epoch !== this.appliedEpoch) {
      this.appliedEpoch = message.epoch;
      this.appliedSeq = 0;
    }

    // 缺口补齐：分区/休眠恢复后先收到高序列号命令时，从共享命令日志
    // 连续补执行缺失的部分；日志缺链（被裁剪或已跨任期）才拒绝本条。
    if (message.seq > this.appliedSeq + 1) {
      const log = this.readState().log.filter(
        (entry) =>
          entry.epoch === message.epoch &&
          entry.leaderId === message.leaderId,
      );
      const missing: CommandMessage[] = [];
      let cursor = this.appliedSeq + 1;
      for (const entry of log) {
        if (entry.seq === cursor) {
          missing.push(entry);
          cursor += 1;
          if (entry.seq === message.seq - 1) break;
        }
      }
      if (cursor === message.seq) {
        for (const missingCmd of missing) {
          // eslint-disable-next-line no-await-in-loop
          await this.applyOnce(missingCmd, true);
        }
      } else {
        return this.finishRejected(
          message,
          `乱序命令（期望 #${this.appliedSeq + 1}，收到 #${message.seq}，且无法补齐），已拒绝`,
        );
      }
    }

    return this.applyOnce(message, false);
  }

  private async finishRejected(
    message: CommandMessage,
    reason: string,
  ): Promise<CommandResult> {
    const result: CommandResult = {
      id: message.id,
      seq: message.seq,
      epoch: message.epoch,
      action: message.action,
      status: 'rejected',
      reason,
      at: this.clock.now(),
    };
    await this.appendResult(result);
    return result;
  }

  /** 去重 + 序列号判定 + 执行（fencing 已由调用方保证）。 */
  private async applyOnce(
    message: CommandMessage,
    recovered: boolean,
  ): Promise<CommandResult> {
    const now = this.clock.now();

    // 闸门 2：命令 ID 去重，重复投递回放首次结果，绝不二次执行。
    const seen = this.seenCommands.get(message.id);
    if (seen) {
      const duplicate: CommandResult = {
        ...seen,
        status: 'duplicate',
        reason: `重复命令（#${message.seq} 已于此前执行），幂等忽略`,
        at: now,
      };
      await this.appendResult(duplicate);
      return duplicate;
    }

    // 闸门 3：序列号必须严格相邻（补缺后仍不相邻说明乱序）。
    if (message.seq <= this.appliedSeq) {
      return this.finishRejected(
        message,
        `乱序/回溯命令（已执行到 #${this.appliedSeq}），已拒绝`,
      );
    }
    if (message.seq > this.appliedSeq + 1) {
      return this.finishRejected(
        message,
        `乱序命令（期望 #${this.appliedSeq + 1}，收到 #${message.seq}），已拒绝`,
      );
    }

    // 通过全部闸门：执行（本地模拟切台 = 推进序列号与播出状态）。
    const applied: CommandResult = {
      id: message.id,
      seq: message.seq,
      epoch: message.epoch,
      action: message.action,
      status: 'applied',
      recovered: recovered || undefined,
      at: now,
    };
    this.appliedSeq = message.seq;
    this.seenCommands.set(message.id, applied);
    await this.mutateState((state) => {
      state.lastCommand = message;
    });
    await this.appendResult(applied);
    return applied;
  }

  private async appendResult(result: CommandResult): Promise<void> {
    // 只持久化 applied 原始记录作为去重依据；duplicate/rejected 仅作留痕。
    await this.mutateState((state) => {
      const list = state.results[this.seatId] ?? [];
      const capped = [...list, result].slice(-RESULTS_PER_SEAT_CAP);
      state.results[this.seatId] = capped;
    });
    if (result.status === 'applied') {
      this.seenCommands.set(result.id, result);
    }
    this.emitChange();
  }

  /** 通道名称常量，供界面/调试引用。 */
  static readonly CHANNEL_NAME = CHANNEL_NAME;
}

let commandCounter = 0;
let localRejectCounter = 0;
function makeCommandId(): string {
  commandCounter += 1;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${commandCounter}-${Math.round(Math.random() * 1e9)}`;
}
