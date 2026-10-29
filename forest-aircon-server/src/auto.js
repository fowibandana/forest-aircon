import { spanOf } from './rooms.js';
import { timedMoment } from './rules.js';

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
    if (cfg.HEAT_ENABLED && temp <= cfg.COLD_ON) {
      for (const d of usable) {
        if (!(d.power === 'ON' && d.mode === 'HEAT')) {
          actions.push({ deviceId: d.id, power: 'ON', mode: 'HEAT', temp: cfg.HEAT_TARGET, why: '난방 켜기' });
        }
      }
      return { state, temp, actions, reason: `방 온도 ${temp}° ≤ ${cfg.COLD_ON}° → 난방(${cfg.HEAT_TARGET}°)` };
    }
    for (const d of usable) {
      if (d.power === 'ON' && d.mode === 'COOL' && temp <= cfg.COOL_OFF) actions.push({ deviceId: d.id, power: 'OFF', why: '충분히 시원해 끄기' });
      if (cfg.HEAT_ENABLED && d.power === 'ON' && d.mode === 'HEAT' && temp >= cfg.HEAT_OFF) actions.push({ deviceId: d.id, power: 'OFF', why: '충분히 따뜻해 끄기' });
    }
    return { state, temp, actions, reason: actions.length ? `방 온도 ${temp}° — 목표 도달, 끄기` : `방 온도 ${temp}° — 적정(제어 없음)` };
  }

  if (allDone && nowMin >= lastEnd + cfg.POST_GRACE_MIN) {
    const actions = usable.filter((d) => d.power === 'ON').map((d) => ({ deviceId: d.id, power: 'OFF', why: '모든 일정 종료 후 끄기' }));
    return { state: 'done', temp, actions, reason: actions.length ? '모든 일정이 끝나 끄기' : '일정 종료 — 이미 꺼져 있음' };
  }
  return none(allDone ? 'done' : 'gap', allDone ? '일정 종료 직후 대기' : '다음 일정까지 대기', temp);
}

// ── LG 호출을 아끼기 위한 «언제 LG 를 부를지» 판단(순수 함수) ──
// 5분마다 깨어나도 대부분은 여기서 «지금은 안 부른다»로 끝난다.
//  · 각 방의 일정 시작 (60분 또는 미리 켜는 시간 중 긴 쪽) 전부터 마지막 일정 종료 후 정리 시간+30분까지가 «점검 구간»
//  · 점검 구간 안에서는 30분마다 한 번(매시 :00, :30 부근)
//  · 그리고 «중요한 순간»(미리 켜기 시작, 시작, 종료 후 끄기)이 이번 5분 안에 있으면 바로 한 번
export const AUTO_INTERVAL_MIN = 30, AUTO_WINDOW_MIN = 60, TICK_MIN = 5;
export function shouldCheckLG({ by, allItems, nowMin, settingsOf, graceMin }) {
  const tick = nowMin - (nowMin % TICK_MIN);
  const onGrid = nowMin % AUTO_INTERVAL_MIN < TICK_MIN;
  let inWindow = false;
  for (const [key, roomItems] of Object.entries(by)) {
    if (!roomItems.length) continue;
    const st = settingsOf(key);
    if (!st.enabled) continue;
    const spans = roomItems.map((it) => spanOf(it, allItems));
    const first = Math.min(...spans.map((x) => x.s)), last = Math.max(...spans.map((x) => x.e));
    const moments = spans.flatMap((x) => [x.s - st.pre, x.s, x.e + graceMin]);
    const hit = moments.find((m) => m >= tick && m < tick + TICK_MIN);
    if (hit !== undefined) return { run: true, why: `중요한 순간(${key})` };
    if (nowMin >= first - Math.max(AUTO_WINDOW_MIN, st.pre) && nowMin < last + graceMin + AUTO_INTERVAL_MIN) inWindow = true;
  }
  if (inWindow && onGrid) return { run: true, why: '점검 구간 정기 확인' };
  const tm = timedMoment(nowMin);   // 시각 규칙(09·10·20·21시, 비품실 매시 확인)
  if (tm) return { run: true, why: tm, supplyOnly: tm.startsWith('비품실') };
  return { run: false, why: inWindow ? '점검 구간 — 다음 정기 확인까지 대기' : '점검 구간 아님' };
}
