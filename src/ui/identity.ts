import type { Seat, SeatKind } from '../core/types';

const SEAT_ID_KEY = 'pocc.seatId';
const SEAT_KIND_KEY = 'pocc.seatKind';
const SEAT_LABEL_KEY = 'pocc.seatLabel';

function randomId(): string {
  // 标签页身份：随机 + 时间，sessionStorage 让刷新保留、关闭即消失
  const rand = Math.random().toString(36).slice(2, 8);
  return `seat-${Date.now().toString(36)}-${rand}`;
}

export function getOrCreateSeat(): Seat {

  const existing = sessionStorage.getItem(SEAT_ID_KEY);
  if (existing) {
    const kind = (sessionStorage.getItem(SEAT_KIND_KEY) as SeatKind | null) ?? 'director';
    const label = sessionStorage.getItem(SEAT_LABEL_KEY) ?? existing;
    return { id: existing, kind, label };
  }
  const id = randomId();
  sessionStorage.setItem(SEAT_ID_KEY, id);
  sessionStorage.setItem(SEAT_KIND_KEY, 'director');
  sessionStorage.setItem(SEAT_LABEL_KEY, id);
  return { id, kind: 'director', label: id };
}

export function saveSeatProfile(kind: SeatKind, label: string): void {
  sessionStorage.setItem(SEAT_KIND_KEY, kind);
  sessionStorage.setItem(SEAT_LABEL_KEY, label);
}
