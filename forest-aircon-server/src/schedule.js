import { CONFIG } from './config.js';
import { isDesk, roomOf, spanOf, hhmm } from './rooms.js';

// 주간운영계획 서버에서 «오늘 일정»을 읽는다(로그인 없음 — display.html 과 같은 호출).
export async function fetchSchedule(fetchFn = fetch, url = CONFIG.SCHEDULE_URL) {
  const r = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getDisplayNow', args: [] }),
  });
  if (!r.ok) throw new Error('일정 서버 응답 오류 HTTP ' + r.status);
  const res = await r.json();
  if (!res || !res.ok || !Array.isArray(res.items)) {
    throw new Error('일정 응답 이상: ' + ((res && (res.message || res.error)) || ''));
  }
  const serverMs = typeof res.serverMs === 'number' ? res.serverMs : Date.now();
  const kst = new Date(serverMs + 9 * 3600 * 1000);
  return {
    date: res.date || kst.toISOString().slice(0, 10),
    nowMin: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
    items: res.items.filter((it) => !isDesk(it)),
  };
}

// 방 키 → 그 방의 일정들
export function itemsByRoom(items) {
  const by = {};
  for (const it of items) {
    const k = roomOf(it.location);
    if (!k) continue;
    (by[k] = by[k] || []).push(it);
  }
  return by;
}

// 화면 표시용: 지금 진행 중인 것 / 다음 순서
export function summarizeRoom(roomItems, allItems, nowMin) {
  const rows = roomItems.map((it) => ({ it, ...spanOf(it, allItems) }));
  const cur = rows.filter((r) => r.s <= nowMin && nowMin < r.e)
    .map((r) => ({ group: it2(r.it), program: r.it.program || '', start: hhmm(r.s), end: r.open ? '' : hhmm(r.e) }));
  const nx = rows.filter((r) => r.s > nowMin).sort((a, b) => a.s - b.s)[0];
  return {
    current: cur,
    next: nx ? { group: it2(nx.it), program: nx.it.program || '', start: hhmm(nx.s) } : null,
    total: rows.length,
  };
}
function it2(it) { return it.groupName || ''; }
