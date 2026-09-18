import { useState } from 'react';
import { DEFAULT_LEASE_TTL_MS } from '../core/protocol';
import type {
  CommandRecord,
  ElectionEvent,
  PlayoutSnapshot,
  Seat,
  SeatKind,
} from '../core/types';
import { SEAT_KIND_LABEL, SWITCH_INPUTS } from '../core/types';
import type { PlayoutCore } from '../core/PlayoutCore';
import { saveSeatProfile } from './identity';

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
    d.getMilliseconds(),
    3,
  )}`;
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/* ------------------------------ 席位表 ------------------------------ */

export function SeatsPanel({
  snap,
  now,
}: {
  snap: PlayoutSnapshot;
  now: number;
}) {
  const leaderId = snap.lease?.holderId;
  return (
    <section className="card span-4">
      <h2>席位（{snap.seats.length} 个标签页在线）</h2>
      <div className="log-scroll">
        <table>
          <thead>
            <tr>
              <th>席位</th>
              <th>类型</th>
              <th>角色</th>
              <th>最后可见</th>
            </tr>
          </thead>
          <tbody>
            {snap.seats.map((s) => {
              const isLeader = s.seat.id === leaderId;
              const online = now - s.lastSeenAt < DEFAULT_LEASE_TTL_MS * 2.5;
              return (
                <tr key={s.seat.id}>
                  <td>
                    <span className="mono">{s.seat.label || shortId(s.seat.id)}</span>
                    {s.isSelf && <span className="muted">（本席）</span>}
                  </td>
                  <td className="kind-tag">{SEAT_KIND_LABEL[s.seat.kind]}</td>
                  <td>
                    {isLeader ? (
                      <span className="badge badge-leader">
                        <span className="dot dot-good" />
                        主控
                      </span>
                    ) : (
                      <span className="badge badge-standby">备机</span>
                    )}
                  </td>
                  <td className="mono muted">
                    {online ? `${Math.max(0, now - s.lastSeenAt)}ms` : '离线'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------ 主控状态 ------------------------------ */

export function LeaderPanel({
  snap,
  now,
}: {
  snap: PlayoutSnapshot;
  now: number;
}) {
  const isLeader = snap.role === 'leader';
  const remaining = isLeader && snap.lease ? Math.max(0, snap.lease.expiresAt - now) : null;
  const ratio = isLeader && snap.lease ? remaining! / (snap.lease.expiresAt - snap.lease.acquiredAt) : 0;
  const low = remaining != null && remaining < 2000;
  return (
    <section className="card span-4">
      <h2>当前主控</h2>
      <div className="leader-name self">
        {snap.lease ? shortId(snap.lease.holderId) : '空缺'}
      </div>
      <div>
        {isLeader ? (
          <span className="badge badge-leader">
            <span className="dot dot-good" />
            本席是主控
          </span>
        ) : (
          <span className="badge badge-standby">
            <span className="dot dot-dim" />
            本席待机
          </span>
        )}
        {snap.sleeping && (
          <span className="badge badge-sleep" style={{ marginLeft: 8 }}>
            <span className="dot dot-warn" />
            休眠中
          </span>
        )}
      </div>

      <dl className="kv">
        <dt>租约 epoch</dt>
        <dd>{snap.lease?.epoch ?? '—'}</dd>
        <dt>命令围栏 epoch</dt>
        <dd>{isLeader ? snap.commandEpoch : '—'}</dd>
        <dt>见过最大 epoch</dt>
        <dd>{snap.maxEpoch}</dd>
        <dt>剩余租约</dt>
        <dd>{remaining != null ? `${remaining}ms` : '—'}</dd>
        <dt>下条 seq</dt>
        <dd>{isLeader ? snap.nextSeq : '—'}</dd>
        <dt>接管方式</dt>
        <dd>{snap.lease?.reason ?? '—'}</dd>
      </dl>

      {isLeader && (
        <div className={`lease-bar ${low ? 'low' : ''}`}>
          <div style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      )}

      <div className="pgm">
        <div>
          <div className="muted" style={{ fontSize: 11 }}>PGM 输出</div>
          <div className="pgm-input">{snap.currentInput}</div>
        </div>
        <span className={`rec-tag ${snap.recording ? 'rec-on' : 'rec-off'}`}>
          <span
            className="dot"
            style={{ background: snap.recording ? 'var(--rec)' : 'var(--text-faint)' }}
          />
          {snap.recording ? 'REC 录制中' : '未录制'}
        </span>
      </div>
    </section>
  );
}

/* ------------------------------ 播控操作 ------------------------------ */

export function ControlPanel({
  core,
  snap,
}: {
  core: PlayoutCore;
  snap: PlayoutSnapshot;
}) {
  const isLeader = snap.role === 'leader';
  return (
    <section className="card span-4">
      <h2>播控操作</h2>
      <div className="input-grid">
        {SWITCH_INPUTS.map((n) => (
          <button
            key={n}
            className={`btn input-btn ${snap.currentInput === n ? 'active' : ''}`}
            disabled={!isLeader || snap.sleeping}
            onClick={() => void core.issue('switch', n)}
            title={isLeader ? `签发切台到通道 ${n}` : '仅主控可签发'}
          >
            {n}
            <small>{snap.currentInput === n ? 'ON AIR' : 'CUT'}</small>
          </button>
        ))}
      </div>
      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={!isLeader || snap.sleeping || snap.recording}
          onClick={() => void core.issue('rec', null)}
        >
          ● 开始录制
        </button>
        <button
          className="btn"
          disabled={!isLeader || snap.sleeping || !snap.recording}
          onClick={() => void core.issue('stop', null)}
        >
          ■ 停止录制
        </button>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-warn"
          disabled={!isLeader || snap.sleeping}
          onClick={() => core.handover()}
          title="正常交接：主动释放，备机以新 epoch 接管"
        >
          ⇄ 正常交接
        </button>
        <button
          className="btn btn-danger"
          disabled={isLeader || snap.sleeping}
          onClick={() => core.forceTakeover()}
          title="强制接管：立即抬升 epoch 夺取主控"
        >
          ⚡ 强制接管
        </button>
      </div>
      <p className="hint">
        命令在 Web Lock 内复核租约后才签发；非主控按钮仅“强制接管”可用。
      </p>
    </section>
  );
}

/* ------------------------------ 故障注入 ------------------------------ */

export function SimulationPanel({
  core,
  snap,
}: {
  core: PlayoutCore;
  snap: PlayoutSnapshot;
}) {
  const [sleepMs, setSleepMs] = useState(8000);
  const [delay, setDelay] = useState(snap.inboundDelayMs);
  return (
    <section className="card span-4">
      <h2>故障注入 / 现场验收</h2>

      <div className="sim-row">
        <label>休眠</label>
        <input
          type="range"
          min={1000}
          max={20000}
          step={500}
          value={sleepMs}
          onChange={(e) => setSleepMs(Number(e.target.value))}
          disabled={snap.sleeping}
        />
        <output>{sleepMs}ms</output>
      </div>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button
          className="btn btn-warn"
          disabled={snap.sleeping}
          onClick={() => core.sleep(sleepMs)}
        >
          模拟休眠（挂起 + 丢消息）
        </button>
        <button
          className="btn"
          disabled={!snap.sleeping}
          onClick={() => core.wake()}
        >
          立即唤醒
        </button>
      </div>
      {snap.sleeping && (
        <div className="sleep-overlay">
          本席已休眠：定时器挂起、租约不再续约、入站 BroadcastChannel / storage 消息全部丢弃。
          租约 TTL={DEFAULT_LEASE_TTL_MS}ms，休眠超过它备机就会过期接管。
        </div>
      )}

      <div className="sim-row" style={{ marginTop: 12 }}>
        <label>入站延迟</label>
        <input
          type="range"
          min={0}
          max={8000}
          step={100}
          value={delay}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDelay(v);
            core.setDelay(v);
          }}
        />
        <output>{delay}ms</output>
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={snap.inboundJitter}
          onChange={(e) => core.setJitter(e.target.checked)}
        />
        叠加随机抖动（0～延迟值），制造乱序到达
      </label>
      <p className="hint">
        延迟过久的命令会因“签发时间过旧”被拒绝；抖动制造的乱序由 seq 围栏拦截。
      </p>
    </section>
  );
}

/* ------------------------------ 命令执行结果 ------------------------------ */

function describeCommand(rec: CommandRecord): string {
  const c = rec.command;
  if (c.type === 'switch') return `切台 → CH${c.input}`;
  if (c.type === 'rec') return '开始录制';
  return '停止录制';
}

function LogRow({ rec }: { rec: CommandRecord }) {
  return (
    <tr>
      <td className="mono muted">{fmtTime(rec.at)}</td>
      <td className="mono">{shortId(rec.command.from)}</td>
      <td>{describeCommand(rec)}</td>
      <td className="mono">
        {rec.command.epoch}/{rec.command.seq}
      </td>
      <td>
        <span className={`tag tag-${rec.status}`}>
          {rec.status === 'applied' ? '已执行' : rec.status === 'duplicate' ? '重复忽略' : '已拒绝'}
        </span>
      </td>
      <td className="muted" style={{ maxWidth: 260 }}>
        {rec.reason ?? 'OK'}
      </td>
    </tr>
  );
}

export function CommandLogPanel({ snap }: { snap: PlayoutSnapshot }) {
  return (
    <section className="card span-8">
      <h2>命令执行结果（新在上，最多 60 条）</h2>
      <div className="log-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>动作</th>
              <th>epoch/seq</th>
              <th>结果</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {snap.log.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  暂无命令
                </td>
              </tr>
            ) : (
              snap.log.map((rec, i) => (
                <LogRow
                  key={`${rec.command.id}-${rec.at}-${rec.seatId}-${i}`}
                  rec={rec}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------ 选举事件 ------------------------------ */

export function EventsPanel({ snap }: { snap: PlayoutSnapshot }) {
  return (
    <section className="card span-12">
      <h2>选举 / 租约事件（新在上）</h2>
      <div className="log-scroll" style={{ maxHeight: 180 }}>
        {snap.events.length === 0 ? (
          <div className="muted">暂无事件</div>
        ) : (
          snap.events.map((e: ElectionEvent) => (
            <div
              key={e.id}
              className={`event-${e.kind}`}
              style={{ display: 'flex', gap: 10, padding: '2px 0' }}
            >
              <span className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                {fmtTime(e.at)}
              </span>
              <span className="event-text">{e.text}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ------------------------------ 顶栏 ------------------------------ */

export function TopBar({
  seat,
  core,
}: {
  seat: Seat;
  core: PlayoutCore;
}) {
  const [kind, setKind] = useState<SeatKind>(seat.kind);
  const [label, setLabel] = useState(seat.label);
  return (
    <header className="topbar">
      <div>
        <h1>🎛 本地播控主控台</h1>
        <div className="sub">BroadcastChannel + storage 事件 · localStorage 租约 · Web Locks CAS · epoch 围栏</div>
      </div>
      <div className="seat-edit">
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value as SeatKind;
            setKind(k);
            core.updateSelf({ kind: k });
            saveSeatProfile(k, label);
          }}
        >
          {(Object.keys(SEAT_KIND_LABEL) as SeatKind[]).map((k) => (
            <option key={k} value={k}>
              {SEAT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            const l = label.trim() || seat.id;
            core.updateSelf({ label: l });
            saveSeatProfile(kind, l);
          }}
        />
        <span className="sub mono">id: {shortId(seat.id)}</span>
      </div>
    </header>
  );
}

/* ------------------------------ App ------------------------------ */

export function App({
  seat,
  core,
  snap,
  now,
}: {
  seat: Seat;
  core: PlayoutCore;
  snap: PlayoutSnapshot;
  now: number;
}) {
  return (
    <div className="app">
      <TopBar seat={seat} core={core} />
      <div className="grid">
        <LeaderPanel snap={snap} now={now} />
        <SeatsPanel snap={snap} now={now} />
        <SimulationPanel core={core} snap={snap} />
        <ControlPanel core={core} snap={snap} />
        <CommandLogPanel snap={snap} />
        <EventsPanel snap={snap} />
      </div>
    </div>
  );
}
