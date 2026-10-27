import { spanOf } from './rooms.js';

// 한 방의 자동 제어 판단(순수 함수 — 실제 호출은 하지 않는다).
// roomItems: 그 방의 오늘 일정 / allItems: 오늘 전체 일정 / devices: [{id, power, mode, cur, target}]
export function decideRoom({ roomItems, allItems, nowMin, devices, cfg }) {
  const none = (state, reason, temp = null) => ({ state, reason, temp, actions: [] });
  if (!roomItems.length) return none('none', '오늘 일정 없음 — 자동 제어 안 함');

  const spans = roomItems.map((it) => spanOf(it, allItems));
  const active = spans.some((s) => s.s <= nowMin && nowMin < s.e);
  const soon = spans.some((s) => s.s > nowMin && s.s - nowMin <= cfg.PRE_MIN);
  const lastEnd = Math.max(...spans.map((s) => s.e));
  const allDone = spans.every((s) => s.e <= nowMin);

  const usable = devices.filter((d) => d.power);
  if (!usable.length) return none(active ? 'active' : soon ? 'soon' : 'idle', '제어할 수 있는 에어컨 없음');

  const temps = usable.map((d) => d.cur).filter((v) => typeof v === 'number');
  const temp = temps.length ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10 : null;

  if (active || soon) {
    const state = active ? 'active' : 'soon';
    if (temp === null) return none(state, '방 온도를 읽지 못해 제어 안 함');
    const actions = [];
    if (temp >= cfg.HOT_ON) {
      for (const d of usable) {
        if (!(d.power === 'ON' && d.mode === 'COOL')) {
          actions.push({ deviceId: d.id, power: 'ON', mode: 'COOL', temp: cfg.COOL_TARGET, why: '냉방 켜기' });
        }
      }
      return { state, temp, actions, reason: `방 온도 ${temp}° ≥ ${cfg.HOT_ON}° → 냉방(${cfg.COOL_TARGET}°)` };
    }
    if (temp <= cfg.COLD_ON) {
      for (const d of usable) {
        if (!(d.power === 'ON' && d.mode === 'HEAT')) {
          actions.push({ deviceId: d.id, power: 'ON', mode: 'HEAT', temp: cfg.HEAT_TARGET, why: '난방 켜기' });
        }
      }
      return { state, temp, actions, reason: `방 온도 ${temp}° ≤ ${cfg.COLD_ON}° → 난방(${cfg.HEAT_TARGET}°)` };
    }
    for (const d of usable) {
      if (d.power === 'ON' && d.mode === 'COOL' && temp <= cfg.COOL_OFF) actions.push({ deviceId: d.id, power: 'OFF', why: '충분히 시원해 끄기' });
      if (d.power === 'ON' && d.mode === 'HEAT' && temp >= cfg.HEAT_OFF) actions.push({ deviceId: d.id, power: 'OFF', why: '충분히 따뜻해 끄기' });
    }
    return { state, temp, actions, reason: actions.length ? `방 온도 ${temp}° — 목표 도달, 끄기` : `방 온도 ${temp}° — 적정(제어 없음)` };
  }

  if (allDone && nowMin >= lastEnd + cfg.POST_GRACE_MIN) {
    const actions = usable.filter((d) => d.power === 'ON').map((d) => ({ deviceId: d.id, power: 'OFF', why: '모든 일정 종료 후 끄기' }));
    return { state: 'done', temp, actions, reason: actions.length ? '모든 일정이 끝나 끄기' : '일정 종료 — 이미 꺼져 있음' };
  }
  return none(allDone ? 'done' : 'gap', allDone ? '일정 종료 직후 대기' : '다음 일정까지 대기', temp);
}
