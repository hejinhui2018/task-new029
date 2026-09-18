import type {
  Clock,
  KVStore,
  LockManagerLike,
  MessageBus,
} from './env';
import { LOCK_NAME, STORAGE_KEYS } from './env';
import { createLinkConditions, type LinkConditions } from './pipe';
import {
  DEFAULT_LEASE_TTL_MS,
  RENEW_INTERVAL_MS,
  TICK_INTERVAL_MS,
  appendLog,
  buildRecord,
  decideClaim,
  fenceFromLease,
  lastSeqForEpoch,
  leaseAlive,
  parseLease,
  parseState,
  rememberApplied,
  validateCommand,
} from './protocol';
import type {
  AcquireReason,
  CommandRecord,
  CommandType,
  ElectionEvent,
  Lease,
  PersistedState,
  PlayoutCommand,
  PlayoutSnapshot,
  Seat,
  WireMessage,
} from './types';

export interface CoreOptions {
  self: Seat;
  clock: Clock;
  bus: MessageBus;
  storage: KVStore;
  locks: LockManagerLike;
  /** 入站链路条件（与延迟管道共享同一对象） */
  link?: LinkConditions;
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  tickIntervalMs?: number;
  /** 命令从签发到被执行允许的最大延迟 */
  maxCommandAgeMs?: number;
  /** 正常交接后本席回避再次竞选的时间 */
  handoverBackoffMs?: number;
  onSnapshot?: (s: PlayoutSnapshot) => void;
}

interface PeerEntry {
  seat: Seat;
  lastSeenAt: number;
}

let eventSeq = 0;

/**
 * 选举 + 主控命令引擎（时钟 / 通道 / 锁 / 存储全部可注入）。
 *
 * 关键不变量：
 *  1. leadership 变化 ⇒ lease epoch 严格 +1，租约写在 Web Lock 内做 CAS；
 *  2. 命令携带 (epoch, seq, id) 三重围栏：旧/新 epoch、乱序 seq 一律拒绝，
 *     重复 id 幂等；签发也在锁内复核租约，杜绝强制接管瞬间的双发；
 *  3. 休眠 = 停止续约 + 丢弃入站消息 + 时钟流逝，恢复后以 storage 为唯一事实源。
 */
export class PlayoutCore {
  private readonly clock: Clock;
  private readonly bus: MessageBus;
  private readonly storage: KVStore;
  private readonly locks: LockManagerLike;
  self: Seat;
  readonly link: LinkConditions;

  readonly leaseTtl: number;
  private readonly renewInterval: number;
  private readonly tickIntervalMs: number;
  private readonly maxCommandAge: number;
  private readonly handoverBackoff: number;

  private knownLease: Lease | null = null;
  private iAmLeader = false;
  /** 命令围栏 epoch（通常等于租约 epoch，刷新恢复后取两者最大值） */
  private commandEpoch = 0;
  private state: PersistedState;
  private maxEpoch = 0;

  private peers = new Map<string, PeerEntry>();
  private events: ElectionEvent[] = [];

  private sleepStartedAt: number | null = null;
  private sleepUntil: number | null = null;
  private handoverBackoffUntil = 0;
  private lastHelloAt = 0;

  private renewHandle: number | null = null;
  private tickHandle: number | null = null;
  private onSnapshot: ((s: PlayoutSnapshot) => void) | undefined;
  private snapshotScheduled = false;

  constructor(opts: CoreOptions) {
    this.self = opts.self;
    this.clock = opts.clock;
    this.bus = opts.bus;
    this.storage = opts.storage;
    this.locks = opts.locks;
    this.link = opts.link ?? createLinkConditions();
    this.leaseTtl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.renewInterval = opts.renewIntervalMs ?? RENEW_INTERVAL_MS;
    this.tickIntervalMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.maxCommandAge = opts.maxCommandAgeMs ?? this.leaseTtl * 2;
    this.handoverBackoff = opts.handoverBackoffMs ?? 1200;
    this.onSnapshot = opts.onSnapshot;

    // ---- 刷新恢复：以 storage 为事实源 ----
    this.state = parseState(this.storage.get(STORAGE_KEYS.state), this.clock.now());
    this.maxEpoch = this.state.maxEpoch;
    this.knownLease = parseLease(this.storage.get(STORAGE_KEYS.lease));
    if (this.knownLease) {
      this.maxEpoch = Math.max(this.maxEpoch, this.knownLease.epoch);
      if (
        this.knownLease.holderId === this.self.id &&
        leaseAlive(this.knownLease, this.clock.now())
      ) {
        // 主控刷新：租约未过期，恢复身份与命令围栏
        this.iAmLeader = true;
        this.commandEpoch = fenceFromLease(this.knownLease, this.state);
      }
    }

    this.peers.set(this.self.id, { seat: this.self, lastSeenAt: this.clock.now() });

    this.bus.onMessage((m) => this.handleWire(m));
    this.storage.onStorage((key, value) => this.handleStorage(key, value));
  }

  start(): void {
    this.bus.post({ kind: 'hello', seat: this.self });
    this.tickHandle = this.clock.setInterval(() => this.tick(), this.tickIntervalMs);
    if (this.iAmLeader) {
      this.startRenewer();
      this.logEvent('gain', `刷新后恢复主控身份 epoch=${this.commandEpoch}（租约仍有效）`);
      this.bus.post({ kind: 'claim', lease: this.knownLease! });
    } else {
      this.attemptClaim('initial', '启动后尝试获取主控');
    }
    this.emitNow();
  }

  close(): void {
    if (this.tickHandle != null) this.clock.clearInterval(this.tickHandle);
    if (this.renewHandle != null) this.clock.clearInterval(this.renewHandle);
    this.bus.close();
  }

  /* ------------------------------ 公共操作 ------------------------------ */

  /**
   * 发起主控命令。整个“复核租约 → 取 seq → 应用 → 持久化”在 Web Lock 内完成，
   * 与强制接管/续期互斥，消除接管瞬间旧主控的最后一次误发。
   * 返回本地执行结果记录（被拒绝时返回 rejected 记录）。
   */
  async issue(type: CommandType, input: number | null): Promise<CommandRecord | null> {
    if (this.link.sleeping) {
      this.logEvent('reject', `休眠中，${type} 命令未签发`);
      this.emitNow();
      return null;
    }
    if (!this.iAmLeader || !this.knownLease) {
      const rec = this.rejectedLocal(type, input, '非主控席位，拒绝签发');
      this.emitNow();
      return rec;
    }
    return this.locks.runExclusive(LOCK_NAME, () => {
      const now = this.clock.now();
      const storedLease = parseLease(this.storage.get(STORAGE_KEYS.lease));
      const storedState = parseState(this.storage.get(STORAGE_KEYS.state), now);

      // 锁内 CAS 复核：租约仍是自己、仍在有效期、围栏未变，才允许签发
      if (
        !storedLease ||
        !leaseAlive(storedLease, now) ||
        storedLease.holderId !== this.self.id ||
        storedLease.epoch !== this.knownLease!.epoch ||
        fenceFromLease(storedLease, storedState) !== this.commandEpoch
      ) {
        if (storedLease) this.observeLease(storedLease);
        this.loseLeadership('签发时锁内复核发现主控已易主，撤销本次命令');
        const rec = this.rejectedLocal(type, input, '签发瞬间主控已易主');
        this.emitNow();
        return rec;
      }

      this.state = storedState;
      this.maxEpoch = Math.max(this.maxEpoch, storedState.maxEpoch);
      const seq = lastSeqForEpoch(storedState, this.commandEpoch) + 1;
      const cmd: PlayoutCommand = {
        id: `${this.self.id}-${this.commandEpoch}-${seq}-${now.toString(36)}`,
        from: this.self.id,
        type,
        input,
        epoch: this.commandEpoch,
        seq,
        issuedAt: now,
      };
      const rec = this.applyCommand(cmd, { persist: false });
      // 先广播再落 storage：注入延迟时，命令广播与状态 storage 事件的相对顺序确定，
      // 接收方总是先按围栏/seq 校验命令本体，再用 storage 状态对账。
      this.bus.post({ kind: 'command', command: cmd });
      this.persistState();
      this.emitNow();
      return rec;
    });
  }

  /** 正常交接：立刻使租约失效并回避片刻，让备机以新 epoch 接管 */
  handover(): void {
    if (!this.iAmLeader || !this.knownLease) {
      this.logEvent('reject', '只有主控可以执行正常交接');
      this.emitNow();
      return;
    }
    const lease = this.knownLease;
    const dead: Lease = { ...lease, expiresAt: this.clock.now(), reason: 'handover' };
    // 锁内写死租约，避免与续期互相覆盖
    void this.locks.runExclusive(LOCK_NAME, () => {
      const stored = parseLease(this.storage.get(STORAGE_KEYS.lease));
      if (stored && stored.holderId === this.self.id && stored.epoch === lease.epoch) {
        this.storage.set(STORAGE_KEYS.lease, JSON.stringify(dead));
      }
      this.observeLease(dead);
      this.stepDown('正常交接：主动释放主控');
      this.handoverBackoffUntil = this.clock.now() + this.handoverBackoff;
      this.bus.post({ kind: 'release', holderId: this.self.id, epoch: lease.epoch });
      this.logEvent('info', `交接广播已发出，${this.handoverBackoff}ms 内本席回避竞选`);
      this.emitNow();
    });
  }

  /** 强制接管：无视未过期租约，epoch 抬升后夺取 */
  forceTakeover(): void {
    if (this.link.sleeping) {
      this.logEvent('reject', '休眠中无法强制接管');
      this.emitNow();
      return;
    }
    // 记录发起动作时所针对的 epoch，锁内 CAS 防并发双接管
    const targetEpoch = this.knownLease?.epoch ?? this.maxEpoch;
    this.attemptClaim('force', '强制接管：夺取当前主控', targetEpoch);
  }

  /** 模拟休眠 ms（测试里配合手动时钟推进；真实页面用墙钟自然流逝） */
  sleep(ms: number): void {
    if (this.link.sleeping) return;
    const now = this.clock.now();
    this.link.sleeping = true;
    this.sleepStartedAt = now;
    this.sleepUntil = now + ms;
    this.logEvent('system', `模拟休眠 ${ms}ms（停止续约、入站消息一律丢弃）`);
    this.emitNow();
  }

  /** 提前结束休眠 */
  wake(): void {
    if (!this.link.sleeping) return;
    this.wakeUp();
    this.emitNow();
  }

  setDelay(ms: number): void {
    this.link.delayMs = Math.max(0, ms);
    this.emitNow();
  }

  /** 注册快照监听（UI 订阅；返回取消函数） */
  setSnapshotListener(fn: ((s: PlayoutSnapshot) => void) | null): () => void {
    this.onSnapshot = fn ?? undefined;
    return () => {
      this.onSnapshot = undefined;
    };
  }

  setJitter(on: boolean): void {
    this.link.jitter = on;
    this.emitNow();
  }

  /** 修改本席类型/名称（id 不变），并通知其他席位 */
  updateSelf(patch: Partial<Pick<Seat, 'kind' | 'label'>>): void {
    const next: Seat = { ...this.self, ...patch };
    (this.self as Seat) = next;
    this.peers.set(next.id, { seat: next, lastSeenAt: this.clock.now() });
    this.bus.post({ kind: 'hello', seat: next });
    this.emitNow();
  }

  snapshot(): PlayoutSnapshot {
    const now = this.clock.now();
    return {
      self: this.self,
      role: this.iAmLeader ? 'leader' : 'standby',
      lease: this.knownLease,
      remainingMs:
        this.iAmLeader && this.knownLease
          ? Math.max(0, this.knownLease.expiresAt - now)
          : null,
      maxEpoch: this.maxEpoch,
      commandEpoch: this.commandEpoch,
      nextSeq: this.iAmLeader ? lastSeqForEpoch(this.state, this.commandEpoch) + 1 : 0,
      currentInput: this.state.currentInput,
      recording: this.state.recording,
      log: [...this.state.log].reverse(),
      events: [...this.events].reverse(),
      seats: [...this.peers.values()]
        .map((p) => ({
          seat: p.seat,
          lastSeenAt: p.lastSeenAt,
          isSelf: p.seat.id === this.self.id,
        }))
        .sort((a, b) => a.seat.id.localeCompare(b.seat.id)),
      sleeping: this.link.sleeping,
      sleepUntil: this.sleepUntil,
      inboundDelayMs: this.link.delayMs,
      inboundJitter: this.link.jitter,
      now,
    };
  }

  /* ------------------------------ 内部：选举 ------------------------------ */

  private tick(): void {
    const now = this.clock.now();

    if (this.link.sleeping) {
      if (this.sleepUntil != null && now >= this.sleepUntil) this.wakeUp();
      return; // 休眠期间不续约、不竞选、不收消息
    }

    if (this.iAmLeader && this.knownLease) {
      if (now >= this.knownLease.expiresAt) {
        this.loseLeadership('本地租约到期且未能续期');
      } else if (now > this.knownLease.expiresAt - this.leaseTtl / 2) {
        this.renew();
      }
    } else if (!this.iAmLeader && now >= this.handoverBackoffUntil) {
      if (!leaseAlive(this.knownLease, now)) {
        this.attemptClaim('expiry', '检测到租约空缺/过期，尝试接管');
      }
    }

    // 周期性 hello：刷新其他席位的在线状态
    if (now - this.lastHelloAt > 3000) {
      this.lastHelloAt = now;
      this.bus.post({ kind: 'hello', seat: this.self });
    }
    // 清理离线席位（超过 2.5 个 TTL 未见）
    const staleBefore = now - this.leaseTtl * 2.5;
    for (const [id, p] of this.peers) {
      if (id !== this.self.id && p.lastSeenAt < staleBefore) this.peers.delete(id);
    }
    this.emit();
  }

  private wakeUp(): void {
    const slept = this.clock.now() - (this.sleepStartedAt ?? this.clock.now());
    this.link.sleeping = false;
    this.sleepStartedAt = null;
    this.sleepUntil = null;
    this.logEvent('system', `休眠结束（经过 ${slept}ms），以 storage 重新对齐状态`);

    this.knownLease = parseLease(this.storage.get(STORAGE_KEYS.lease));
    const restored = parseState(this.storage.get(STORAGE_KEYS.state), this.clock.now());
    this.state = restored;
    if (this.knownLease) this.maxEpoch = Math.max(this.maxEpoch, this.knownLease.epoch);
    this.maxEpoch = Math.max(this.maxEpoch, restored.maxEpoch);

    if (this.iAmLeader) {
      if (!this.knownLease || this.knownLease.holderId !== this.self.id) {
        // 旧主控休眠过久：备机已接管，必须带着旧 epoch 接受下台
        this.loseLeadership('休眠恢复后发现主控已被其他席位接管');
      } else if (!leaseAlive(this.knownLease, this.clock.now())) {
        this.loseLeadership('休眠恢复后自己的租约已过期');
      } else {
        // 租约仍是自己且有效：继续主控，围栏对齐
        this.commandEpoch = fenceFromLease(this.knownLease, this.state);
        this.startRenewer();
      }
    }
    this.bus.post({ kind: 'hello', seat: this.self });
    if (!this.iAmLeader) this.attemptClaim('initial', '休眠恢复后尝试重新加入');
    this.emitNow();
  }

  private attemptClaim(
    reason: AcquireReason,
    why: string,
    forceTargetEpoch?: number,
  ): void {
    if (this.link.sleeping) return;
    if (!this.iAmLeader && reason !== 'force' && this.clock.now() < this.handoverBackoffUntil) {
      return;
    }
    void this.locks.runExclusive(LOCK_NAME, () => {
      const now = this.clock.now();
      const stored = parseLease(this.storage.get(STORAGE_KEYS.lease));
      const decision = decideClaim({
        selfId: this.self.id,
        current: stored,
        now,
        ttl: this.leaseTtl,
        reason,
        ownEpoch: this.maxEpoch,
        ...(forceTargetEpoch != null ? { forceTargetEpoch } : {}),
      });
      if (!decision) {
        if (stored) this.observeLease(stored);
        this.emit();
        return;
      }
      this.storage.set(STORAGE_KEYS.lease, JSON.stringify(decision));
      const wasLeader = this.iAmLeader;
      const prevEpoch = this.commandEpoch;
      this.observeLease(decision);
      this.iAmLeader = true;
      this.commandEpoch = fenceFromLease(decision, this.state);
      this.maxEpoch = Math.max(this.maxEpoch, decision.epoch, this.commandEpoch);
      this.startRenewer();
      this.logEvent('gain', `${why}：成为主控 leaseEpoch=${decision.epoch} 命令围栏=${this.commandEpoch}（${decision.reason}）`);
      if (!wasLeader || prevEpoch !== this.commandEpoch) {
        this.bus.post({ kind: 'claim', lease: decision });
      }
      this.emit();
    });
  }

  private renew(): void {
    if (!this.iAmLeader || this.link.sleeping) return;
    void this.locks.runExclusive(LOCK_NAME, () => {
      const stored = parseLease(this.storage.get(STORAGE_KEYS.lease));
      if (stored && stored.holderId !== this.self.id) {
        // storage 里已是别人（强制接管已发生）→ 立刻下台，绝不覆盖
        this.observeLease(stored);
        this.loseLeadership(`续期时发现主控已变为 ${stored.holderId} epoch=${stored.epoch}`);
        this.emit();
        return;
      }
      if (stored && this.knownLease && stored.epoch > this.knownLease.epoch) {
        this.observeLease(stored);
        this.loseLeadership(`发现更高 epoch=${stored.epoch}，放弃主控`);
        this.emit();
        return;
      }
      const decision = decideClaim({
        selfId: this.self.id,
        current: stored ?? this.knownLease,
        now: this.clock.now(),
        ttl: this.leaseTtl,
        reason: 'handover',
        ownEpoch: this.maxEpoch,
      });
      if (!decision) {
        if (stored) this.observeLease(stored);
        return;
      }
      this.storage.set(STORAGE_KEYS.lease, JSON.stringify(decision));
      this.observeLease(decision);
      this.bus.post({ kind: 'heartbeat', lease: decision });
      this.emit();
    });
  }

  private startRenewer(): void {
    if (this.renewHandle != null) this.clock.clearInterval(this.renewHandle);
    this.renewHandle = this.clock.setInterval(() => {
      if (!this.link.sleeping) this.renew();
    }, this.renewInterval);
  }

  private stepDown(why: string): void {
    if (!this.iAmLeader) return;
    this.iAmLeader = false;
    this.commandEpoch = 0;
    if (this.renewHandle != null) {
      this.clock.clearInterval(this.renewHandle);
      this.renewHandle = null;
    }
    this.logEvent('lose', why);
  }

  private loseLeadership(why: string): void {
    if (!this.iAmLeader) return;
    this.iAmLeader = false;
    this.commandEpoch = 0;
    if (this.renewHandle != null) {
      this.clock.clearInterval(this.renewHandle);
      this.renewHandle = null;
    }
    this.logEvent('lose', why);
  }

  /* ------------------------------ 内部：消息 ------------------------------ */

  private handleWire(m: WireMessage): void {
    if (this.link.sleeping) return;
    const now = this.clock.now();
    switch (m.kind) {
      case 'hello': {
        this.peers.set(m.seat.id, { seat: m.seat, lastSeenAt: now });
        if (this.iAmLeader && m.seat.id !== this.self.id && this.knownLease) {
          this.bus.post({ kind: 'claim', lease: this.knownLease });
        }
        break;
      }
      case 'claim':
      case 'heartbeat': {
        this.observeLease(m.lease);
        if (m.kind === 'claim') {
          this.peers.set(m.lease.holderId, {
            seat: this.peers.get(m.lease.holderId)?.seat ?? {
              id: m.lease.holderId,
              kind: 'backup',
              label: m.lease.holderId,
            },
            lastSeenAt: now,
          });
        }
        break;
      }
      case 'release': {
        // 释放者已把 storage 租约写死；备机收到广播后立即在本地视为过期，
        // 不必等待（可能被延迟的）storage 事件。
        if (
          this.knownLease &&
          this.knownLease.holderId === m.holderId &&
          this.knownLease.epoch === m.epoch
        ) {
          this.observeLease({ ...this.knownLease, expiresAt: now });
          this.logEvent('info', `收到主控 ${m.holderId} 的交接释放（epoch=${m.epoch}）`);
        }
        break;
      }
      case 'command': {
        this.applyCommand(m.command, { persist: false });
        break;
      }
    }
    this.emit();
  }

  private handleStorage(key: string, value: string | null): void {
    if (this.link.sleeping) return;
    if (key === STORAGE_KEYS.lease) {
      const lease = parseLease(value);
      if (lease) this.observeLease(lease);
    } else if (key === STORAGE_KEYS.state) {
      this.mergeState(parseState(value, this.clock.now()));
    }
    this.emit();
  }

  private observeLease(lease: Lease): void {
    this.maxEpoch = Math.max(this.maxEpoch, lease.epoch);
    const prev = this.knownLease;
    this.knownLease = lease;

    if (lease.holderId === this.self.id) {
      // 只有代数不落后（不是延迟到达的旧 heartbeat/claim）且租约有效时，才（恢复）主控身份。
      // 否则旧主控会被自己的旧广播“复活”造成脑裂。
      if (
        !this.iAmLeader &&
        lease.epoch >= this.maxEpoch &&
        leaseAlive(lease, this.clock.now())
      ) {
        this.iAmLeader = true;
        this.commandEpoch = fenceFromLease(lease, this.state);
        this.startRenewer();
        this.logEvent('gain', `恢复/确认主控身份 epoch=${this.commandEpoch}`);
      }
      return;
    }

    if (this.iAmLeader) {
      // 只有“更新一代”的他人租约才能让本席下台；
      // 延迟到达的旧 epoch heartbeat/claim 一律忽略。
      if (!prev || lease.epoch > prev.epoch) {
        this.loseLeadership(`检测到新主控 ${lease.holderId} epoch=${lease.epoch}`);
      }
    }
  }

  /* ------------------------------ 内部：命令 ------------------------------ */

  private applyCommand(
    cmd: PlayoutCommand,
    opts: { persist: boolean },
  ): CommandRecord {
    const now = this.clock.now();
    // 接收方期望的围栏：自己签发时用 commandEpoch；
    // 备机取“租约 epoch / 持久化状态 maxEpoch”的最大值，容忍两条同步路径的到达顺序差。
    const expectedEpoch = this.iAmLeader
      ? this.commandEpoch
      : Math.max(this.knownLease?.epoch ?? 0, this.state.maxEpoch);
    const effectiveLease: Lease | null = this.iAmLeader
      ? this.knownLease && { ...this.knownLease, epoch: this.commandEpoch }
      : this.knownLease;

    const verdict = validateCommand(cmd, {
      state: this.state,
      activeLease: effectiveLease,
      now,
      selfId: this.self.id,
      maxCommandAgeMs: this.maxCommandAge,
      expectedEpoch,
    });

    if (verdict.status === 'applied') {
      this.state = rememberApplied(this.state, cmd, now);
      this.maxEpoch = Math.max(this.maxEpoch, cmd.epoch);
      this.state = appendLog(this.state, buildRecord(cmd, verdict, now, this.self.id));
      if (opts.persist) this.persistState();
      this.logEvent('info', `执行 ${this.describe(cmd)}（epoch=${cmd.epoch} seq=${cmd.seq}）`);
      return buildRecord(cmd, verdict, now, this.self.id);
    }

    // duplicate / rejected：只进本地日志，不改业务状态、不回写共享状态键
    const rec = buildRecord(cmd, verdict, now, this.self.id);
    this.state = appendLog(this.state, rec);
    if (verdict.status === 'duplicate') {
      this.logEvent('info', `幂等忽略重复命令 ${cmd.id.slice(0, 16)}…`);
    } else {
      this.logEvent('reject', `拒绝命令：${verdict.reason}`);
    }
    return rec;
  }

  private rejectedLocal(type: CommandType, input: number | null, reason: string): CommandRecord {
    const now = this.clock.now();
    const cmd: PlayoutCommand = {
      id: `local-rejected-${now.toString(36)}-${type}`,
      from: this.self.id,
      type,
      input,
      epoch: this.commandEpoch,
      seq: 0,
      issuedAt: now,
    };
    const rec = buildRecord(
      cmd,
      { ok: false, status: 'rejected', reason },
      now,
      this.self.id,
    );
    this.state = appendLog(this.state, rec);
    this.logEvent('reject', `拒绝签发：${reason}`);
    return rec;
  }

  private mergeState(incoming: PersistedState): void {
    const merged: PersistedState = { ...this.state };
    let changed = false;

    this.maxEpoch = Math.max(this.maxEpoch, incoming.maxEpoch);

    if (
      incoming.epoch > this.state.epoch ||
      (incoming.epoch === this.state.epoch && incoming.seq > this.state.seq)
    ) {
      merged.currentInput = incoming.currentInput;
      merged.recording = incoming.recording;
      merged.epoch = incoming.epoch;
      merged.seq = incoming.seq;
      merged.epochSeq = incoming.epochSeq;
      changed = true;
    }

    const mergedIds = new Set([...this.state.appliedIds, ...incoming.appliedIds]);
    if (mergedIds.size !== this.state.appliedIds.length) {
      merged.appliedIds = [...mergedIds].slice(-200);
      changed = true;
    }

    // 合并日志：同一命令 id 只保留一条本地记录
    // （广播与 storage 状态可能携带同一命令；历史命令也由此在新标签页回放）
    const haveIds = new Set(this.state.log.map((r) => r.command.id));
    const extra = incoming.log.filter((r) => !haveIds.has(r.command.id));
    if (extra.length) {
      merged.log = [...this.state.log, ...extra].slice(-60);
      changed = true;
    }
    if (changed) this.state = merged;
  }

  private persistState(): void {
    // 业务状态只由主控写：storage 事件成为备机的权威同步源
    if (!this.iAmLeader) return;
    this.storage.set(STORAGE_KEYS.state, JSON.stringify(this.state));
  }

  private describe(cmd: PlayoutCommand): string {
    if (cmd.type === 'switch') return `切台 → 通道 ${cmd.input}`;
    if (cmd.type === 'rec') return '开始录制';
    return '停止录制';
  }

  /* ------------------------------ 事件/快照 ------------------------------ */

  private logEvent(kind: ElectionEvent['kind'], text: string): void {
    this.events.push({ id: ++eventSeq, at: this.clock.now(), kind, text });
    if (this.events.length > 60) this.events.shift();
  }

  private emit(): void {
    if (this.snapshotScheduled) return;
    this.snapshotScheduled = true;
    Promise.resolve().then(() => {
      this.snapshotScheduled = false;
      this.emitNow();
    });
  }

  private emitNow(): void {
    this.onSnapshot?.(this.snapshot());
  }
}
