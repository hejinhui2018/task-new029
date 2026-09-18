import { useMemo, useState } from 'react';
import type { CommandAction, CommandResult } from './core';
import { describeAction } from './core';
import { useCoordinator } from './useCoordinator';

export default function App() {
  const { snapshot, handles } = useCoordinator();
  const [nameDraft, setNameDraft] = useState('');
  const [sleeping, setSleeping] = useState(false);
  const [delayMs, setDelayMs] = useState(0);
  const [duplicate, setDuplicate] = useState(false);
  const [handoffTarget, setHandoffTarget] = useState('');

  const coordinator = handles.coordinator;
  const isLeader = snapshot.role === 'leader';
  const leaderSeat = snapshot.seats.find((s) => s.role === 'leader');
  const targets = snapshot.seats.filter(
    (s) => s.id !== snapshot.seatId && s.online,
  );

  const toggleSleep = () => {
    const next = !sleeping;
    setSleeping(next);
    handles.setSleeping(next);
  };

  const issue = (action: CommandAction) => {
    void coordinator.issue(action);
  };

  const saveName = () => {
    coordinator.setSeatName(nameDraft || snapshot.seatId.slice(0, 6));
    setNameDraft('');
  };

  const doHandoff = () => {
    if (!handoffTarget) return;
    coordinator.handoffTo(handoffTarget);
    setHandoffTarget('');
  };

  const doForce = () => {
    void coordinator.forceTakeover();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          本地播控主控台
          <span className="brand-sub">BroadcastChannel · Web Locks · Lease Fencing</span>
        </div>
        <div className={`seat-card ${isLeader ? 'is-leader' : ''}`}>
          <div className="seat-card-label">本窗口席位</div>
          <div className="seat-card-row">
            <strong>{coordinator.getSeatName()}</strong>
            <span className={`role-badge role-${snapshot.role}`}>
              {snapshot.role === 'leader'
                ? '主控'
                : snapshot.role === 'standby'
                  ? '备机'
                  : '空闲'}
            </span>
            {sleeping && <span className="sleep-badge">休眠中</span>}
          </div>
          <div className="seat-id">{snapshot.seatId.slice(0, 8)}</div>
          <div className="name-edit">
            <input
              value={nameDraft}
              placeholder="修改席位名称…"
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
            />
            <button onClick={saveName}>保存</button>
          </div>
        </div>
      </header>

      <main className="grid">
        <section className="panel lease-panel">
          <h2>主控租约</h2>
          <LeaseBody
            leaderName={leaderSeat?.name ?? null}
            isSelf={leaderSeat?.id === snapshot.seatId}
            epoch={snapshot.lease?.epoch ?? null}
            remainingMs={snapshot.remainingMs}
            ttlMs={snapshot.lease?.ttlMs ?? 5000}
            hasLease={!!snapshot.lease}
          />
          <div className="lease-meta">
            <span>本席位已执行序列号：<b>#{snapshot.appliedSeq}</b></span>
            <span>集群命令水位：<b>#{snapshot.lastSeq}</b></span>
          </div>
        </section>

        <section className="panel">
          <h2>席位（{snapshot.seats.length}）</h2>
          <table className="seats-table">
            <thead>
              <tr>
                <th>席位</th><th>角色</th><th>在线</th>
                <th>已执行</th><th>最近心跳</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.seats.map((seat) => (
                <tr
                  key={seat.id}
                  className={seat.id === snapshot.seatId ? 'self-row' : ''}
                >
                  <td>
                    {seat.name}
                    {seat.id === snapshot.seatId && (
                      <span className="self-tag">本窗口</span>
                    )}
                  </td>
                  <td>
                    <span className={`role-badge role-${seat.role}`}>
                      {seat.role === 'leader'
                        ? '主控'
                        : seat.role === 'standby'
                          ? '备机'
                          : '离线'}
                    </span>
                  </td>
                  <td>
                    <span className={`dot ${seat.online ? 'dot-on' : 'dot-off'}`} />
                  </td>
                  <td>#{seat.appliedSeq}</td>
                  <td className="muted">
                    {seat.online
                      ? `${Math.max(0, Math.round((snapshot.now - seat.lastSeenAt) / 100) / 10)}s 前`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>播控操作</h2>
          <p className="hint">
            {isLeader
              ? '命令携带当前 epoch 与序列号广播；旧任期 / 乱序 / 重复命令在所有席位被拒绝或幂等忽略。'
              : '当前席位不是主控。可等待租约过期自动接管，或执行强制接管。'}
          </p>
          <div className="action-grid">
            {[1, 2, 3, 4].map((input) => (
              <button
                key={input}
                className="action-btn cut-btn"
                disabled={!isLeader || sleeping}
                onClick={() => issue({ type: 'cut', input })}
              >
                切到 <b>{input}</b> 号机
              </button>
            ))}
            <button
              className="action-btn warn-btn"
              disabled={!isLeader || sleeping}
              onClick={() => issue({ type: 'black' })}
            >
              黑场
            </button>
            <button
              className="action-btn warn-btn"
              disabled={!isLeader || sleeping}
              onClick={() => issue({ type: 'freeze' })}
            >
              应急静帧
            </button>
          </div>

          <div className="transfer-row">
            <div className="transfer-group">
              <label>正常交接给</label>
              <select
                value={handoffTarget}
                onChange={(e) => setHandoffTarget(e.target.value)}
                disabled={!isLeader || targets.length === 0 || sleeping}
              >
                <option value="">选择在线备机…</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                disabled={!isLeader || !handoffTarget || sleeping}
                onClick={doHandoff}
              >
                交接（epoch +1）
              </button>
            </div>
            <div className="transfer-group">
              <button
                className="force-btn"
                disabled={isLeader || sleeping}
                onClick={doForce}
                title="无需等待租约过期，立即在锁内把 epoch 加 1 接管"
              >
                强制接管
              </button>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>故障注入（仅影响本窗口）</h2>
          <div className="chaos-grid">
            <button
              className={`chaos-sleep ${sleeping ? 'active' : ''}`}
              onClick={toggleSleep}
            >
              {sleeping ? '▶ 恢复运行' : '⏸ 模拟休眠 / 网卡顿'}
            </button>
            <div className="chaos-slider">
              <label>
                消息延迟：<b>{delayMs}ms</b>
              </label>
              <input
                type="range"
                min={0}
                max={6000}
                step={100}
                value={delayMs}
                onChange={(e) => {
                  const ms = Number(e.target.value);
                  setDelayMs(ms);
                  handles.setDelayMs(ms);
                }}
              />
              <div className="chaos-note">
                延迟超过租约 TTL（5s）可验收「在途旧命令」被拒绝。
              </div>
            </div>
            <label className="chaos-check">
              <input
                type="checkbox"
                checked={duplicate}
                onChange={(e) => {
                  setDuplicate(e.target.checked);
                  handles.setDuplicate(e.target.checked);
                }}
              />
              每条消息重发一份（验收幂等去重）
            </label>
          </div>
        </section>

        <section className="panel wide-panel">
          <h2>命令执行结果（全席位对照）</h2>
          <CommandMatrix
            allResults={snapshot.allResults}
            seatId={snapshot.seatId}
          />
        </section>
      </main>

      <footer className="footer">
        所有状态仅保存在浏览器本地：localStorage 租约/状态 · BroadcastChannel 消息 · Web Locks 互斥。
        多开标签页即可现场验收，F5 刷新后状态恢复。
      </footer>
    </div>
  );
}

function LeaseBody(props: {
  leaderName: string | null;
  isSelf: boolean;
  epoch: number | null;
  remainingMs: number;
  ttlMs: number;
  hasLease: boolean;
}) {
  if (!props.hasLease || !props.leaderName) {
    return (
      <div className="lease-empty">
        尚无主控——首个备机将在一个节拍内当选（epoch 1）
      </div>
    );
  }
  const ratio = Math.max(0, Math.min(1, props.remainingMs / props.ttlMs));
  const urgent = ratio < 0.3;
  return (
    <div className="lease-body">
      <div className="lease-leader">
        当前主控：<b>{props.leaderName}</b>
        {props.isSelf && <span className="self-tag">本窗口</span>}
      </div>
      <div className="lease-stats">
        <div className="stat">
          <span className="stat-label">epoch</span>
          <span className="stat-value">{props.epoch}</span>
        </div>
        <div className="stat">
          <span className="stat-label">剩余租约</span>
          <span className={`stat-value ${urgent ? 'urgent' : ''}`}>
            {(props.remainingMs / 1000).toFixed(1)}s
          </span>
        </div>
      </div>
      <div className={`lease-bar ${urgent ? 'urgent' : ''}`}>
        <div className="lease-bar-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

interface MergedCommand {
  id: string;
  seq: number;
  epoch: number;
  label: string;
  at: number;
  perSeat: Record<string, CommandResult>;
}

function CommandMatrix(props: {
  allResults: Record<string, CommandResult[]>;
  seatId: string;
}) {
  const merged = useMemo<MergedCommand[]>(() => {
    const map = new Map<string, MergedCommand>();
    for (const [seatId, results] of Object.entries(props.allResults)) {
      for (const result of results) {
        let entry = map.get(result.id);
        if (!entry) {
          entry = {
            id: result.id,
            seq: result.seq,
            epoch: result.epoch,
            label: describeAction(result.action),
            at: result.at,
            perSeat: {},
          };
          map.set(result.id, entry);
        }
        entry.perSeat[seatId] = result;
        entry.at = Math.max(entry.at, result.at);
      }
    }
    return [...map.values()].sort((a, b) => b.at - a.at).slice(0, 30);
  }, [props.allResults]);

  const seatIds = useMemo(() => {
    const ids = new Set<string>();
    merged.forEach((m) => Object.keys(m.perSeat).forEach((id) => ids.add(id)));
    return [...ids].sort();
  }, [merged]);

  if (merged.length === 0) {
    return <p className="hint">还没有命令。主控执行切台后，每个席位的裁决结果会出现在这里。</p>;
  }

  return (
    <div className="matrix-wrap">
      <table className="matrix-table">
        <thead>
          <tr>
            <th>命令</th>
            <th>#</th>
            <th>epoch</th>
            {seatIds.map((id) => (
              <th key={id} className={id === props.seatId ? 'self-col' : ''}>
                {id === props.seatId ? '本窗口' : id.slice(0, 6)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {merged.map((cmd) => (
            <tr key={cmd.id}>
              <td className="cmd-label">{cmd.label}</td>
              <td className="muted">{cmd.seq || '—'}</td>
              <td className="muted">{cmd.epoch}</td>
              {seatIds.map((id) => {
                const result = cmd.perSeat[id];
                return (
                  <td key={id} className={id === props.seatId ? 'self-col' : ''}>
                    {result ? <ResultChip result={result} /> : <span className="muted">·</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultChip({ result }: { result: CommandResult }) {
  const text =
    result.status === 'applied'
      ? '已执行'
      : result.status === 'duplicate'
        ? '重复·幂等'
        : '已拒绝';
  return (
    <span
      className={`result-chip result-${result.status}`}
      title={result.reason ?? `seq #${result.seq} · epoch ${result.epoch}`}
    >
      {text}
    </span>
  );
}
