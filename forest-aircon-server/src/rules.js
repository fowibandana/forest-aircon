import { spanOf } from './rooms.js';
import { TICK_MIN } from './auto.js';

// 시간으로 정해진 규칙(순수 함수) — 일정과 상관없이 정해진 시각에 하는 일
//  · 비품실: 절대 끄지 않는다. 꺼져 있으면 켠다(점검은 매시 정각 근처)
//  · 체험실·실감실(실감미디어실): 10:00 켜기, 20:00 끄기
//  · 21:00 이후: 그날 아직 끝나지 않은 일정이 있는 방, 자동 제어를 끈 방, 비품실만 빼고 모두 끄기
//  · 09:00: 오늘 일정이 있는 방이 너무 추우면 «난방 확인 필요» 알림(난방은 중앙제어라 사람이 가서 확인)
export const RULES = Object.freeze({
  SUPPLY: 'supply', MEDIA: 'media',
  MEDIA_ON: 10 * 60, MEDIA_OFF: 20 * 60,
  SWEEP_AT: 21 * 60, SWEEP_TICKS: 5, SWEEP_MAX_PER_TICK: 12,   // 무료 플랜 요청당 50회 제한 때문에 한 번에 12대까지, 여러 번에 나눠서
  COLD_CHECK_AT: 9 * 60, COLD_ALERT: 18,
  SUPPLY_CHECK_MIN: 60,
});

const tickOf = (nowMin) => nowMin - (nowMin % TICK_MIN);
const inTick = (nowMin, m) => m >= tickOf(nowMin) && m < tickOf(nowMin) + TICK_MIN;
export const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// LG 를 불러야 하는 «시각 규칙» 순간인지(shouldCheckLG 에서 사용)
export function timedMoment(nowMin) {
  if (inTick(nowMin, RULES.COLD_CHECK_AT)) return '09:00 추위 확인';
  if (inTick(nowMin, RULES.MEDIA_ON)) return '10:00 체험·실감실 켜기';
  if (inTick(nowMin, RULES.MEDIA_OFF)) return '20:00 체험·실감실 끄기';
  if (nowMin >= RULES.SWEEP_AT && nowMin < RULES.SWEEP_AT + RULES.SWEEP_TICKS * TICK_MIN) return '21:00 전체 끄기';
  if (nowMin % RULES.SUPPLY_CHECK_MIN < TICK_MIN) return '비품실 켜짐 확인';
  return null;
}

// 이번 점검에서 어떤 방의 상태를 읽어야 하는지(규칙에 필요한 방)
export function roomsNeeded(nowMin, allKeys) {
  const need = new Set([RULES.SUPPLY]);
  if (inTick(nowMin, RULES.MEDIA_ON) || inTick(nowMin, RULES.MEDIA_OFF)) need.add(RULES.MEDIA);
  if (nowMin >= RULES.SWEEP_AT && nowMin < RULES.SWEEP_AT + RULES.SWEEP_TICKS * TICK_MIN) for (const k of allKeys) need.add(k);
  return need;
}

// devices: [{id, room, power, ok}] / by: 방별 오늘 일정 / enabledOf(key): 그 방의 자동 제어 켬 여부
export function timedActions({ nowMin, devices, by, allItems, enabledOf }) {
  const actions = [];
  const live = devices.filter((d) => d.ok && d.power);
  // 비품실: 꺼져 있으면 켠다(모드·온도는 건드리지 않는다)
  for (const d of live) if (d.room === RULES.SUPPLY && d.power === 'OFF') actions.push({ room: d.room, deviceId: d.id, power: 'ON', why: '비품실은 항상 켜 둠 — 켜기' });
  // 체험실·실감실
  if (inTick(nowMin, RULES.MEDIA_ON) && enabledOf(RULES.MEDIA)) {
    for (const d of live) if (d.room === RULES.MEDIA && !(d.power === 'ON')) actions.push({ room: d.room, deviceId: d.id, power: 'ON', mode: 'COOL', temp: null, why: '10:00 체험·실감실 켜기' });
  }
  if (inTick(nowMin, RULES.MEDIA_OFF) && enabledOf(RULES.MEDIA)) {
    for (const d of live) if (d.room === RULES.MEDIA && d.power === 'ON') actions.push({ room: d.room, deviceId: d.id, power: 'OFF', why: '20:00 체험·실감실 끄기' });
  }
  // 21시 전체 끄기(이후 몇 번 더 확인해 남은 것을 끈다)
  if (nowMin >= RULES.SWEEP_AT && nowMin < RULES.SWEEP_AT + RULES.SWEEP_TICKS * TICK_MIN) {
    let n = 0;
    for (const d of live) {
      if (d.power !== 'ON' || !d.room || d.room === RULES.SUPPLY || !enabledOf(d.room)) continue;
      const items = by[d.room] || [];
      if (items.some((it) => spanOf(it, allItems).e > nowMin)) continue;   // 아직 일정이 남았거나 진행 중인 방은 그대로
      if (n >= RULES.SWEEP_MAX_PER_TICK) break;
      n++;
      actions.push({ room: d.room, deviceId: d.id, power: 'OFF', why: '21:00 이후 전체 끄기' });
    }
  }
  return actions;
}

// 09:00 추위 알림: 오늘 아직 안 끝난 일정이 있는 방의 평균 온도가 기준 이하이면 알림
export function coldAlerts({ nowMin, decisions, by, allItems, enabledOf, date }) {
  if (!inTick(nowMin, RULES.COLD_CHECK_AT)) return [];
  const out = [];
  for (const [key, d] of Object.entries(decisions)) {
    const items = by[key] || [];
    if (!items.length || !enabledOf(key) || typeof d.temp !== 'number' || d.temp > RULES.COLD_ALERT) continue;
    const spans = items.map((it) => spanOf(it, allItems)).filter((s) => s.e > nowMin).sort((a, b) => a.s - b.s);
    if (!spans.length) continue;
    out.push({ id: date + ':' + key, date, room: key, temp: d.temp, start: spans[0].s, at: hhmm(nowMin) });
  }
  return out;
}
