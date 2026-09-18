import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { usePlayoutCore, useSnapshot } from './ui/usePlayoutCore';
import { getOrCreateSeat } from './ui/identity';
import './ui/styles.css';

function Root() {
  // 席位身份存 sessionStorage：刷新保留，关掉标签页即注销
  const [seat] = useState(() => getOrCreateSeat());
  const { core } = usePlayoutCore(seat);
  const snap = useSnapshot(core);
  // 高频墙钟只驱动剩余租约倒计时显示
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(h);
  }, []);

  return <App seat={seat} core={core} snap={snap} now={now} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
