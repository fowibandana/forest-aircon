import { CONFIG } from './config.js';

// 방별 자동 제어 설정. 기본값은 config.js 에 있고, 방마다 바꾼 값만 KV(STATE)의 'settings' 키에 저장한다.
export const DEFAULTS = Object.freeze({
  enabled: true,                    // 이 방을 자동 제어할지
  pre: CONFIG.PRE_MIN,              // 프로그램 시작 몇 분 전부터 방 온도를 볼지
  hot_on: CONFIG.HOT_ON,            // 방 온도가 이 이상이면 냉방
  cool_target: CONFIG.COOL_TARGET,  // 냉방 설정 온도(방 온도가 여기까지 내려오면 끔)
  cold_on: CONFIG.COLD_ON,          // 방 온도가 이 이하면 난방
  heat_target: CONFIG.HEAT_TARGET,  // 난방 설정 온도(방 온도가 여기까지 오르면 끔)
});

const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

// 사용자가 보낸 값을 검사해서 정리한다. 이상하면 { error } 를 돌려준다.
export function cleanSettings(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  const out = { enabled: s.enabled !== false };
  for (const [k, lo, hi, label] of [['pre', 0, 120, '시작 전 확인 시간(분)'], ['hot_on', 20, 35, '냉방 시작 온도'], ['cool_target', 16, 30, '냉방 설정 온도'], ['cold_on', 5, 25, '난방 시작 온도'], ['heat_target', 16, 30, '난방 설정 온도']]) {
    const v = num(s[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return { error: `${label}는 ${lo}~${hi} 사이로 입력하세요` };
    out[k] = k === 'pre' ? Math.round(v) : Math.round(v * 2) / 2;
  }
  if (!(out.cool_target < out.hot_on)) return { error: '냉방 설정 온도는 냉방 시작 온도보다 낮아야 합니다' };
  if (!(out.cold_on < out.heat_target)) return { error: '난방 시작 온도는 난방 설정 온도보다 낮아야 합니다' };
  if (!(out.cold_on < out.cool_target && out.heat_target < out.hot_on)) return { error: '난방 쪽 온도는 냉방 쪽 온도보다 낮아야 합니다' };
  return { value: out };
}

// 방별로 «바꾼 값»만 담긴 지도: { r201: {hot_on: 27}, ... }
export async function loadSettings(env) {
  if (!env.STATE) return {};
  try { return (await env.STATE.get('settings', 'json')) || {}; } catch { return {}; }
}

export function settingsOf(map, key) {
  const custom = map[key];
  const cleaned = cleanSettings(custom);
  return { settings: cleaned.value || { ...DEFAULTS }, custom: !!custom && !!cleaned.value };
}

// decideRoom 이 쓰는 형태로 바꾼다.
export function cfgOf(settings) {
  return { ...CONFIG, PRE_MIN: settings.pre, HOT_ON: settings.hot_on, COOL_TARGET: settings.cool_target, COOL_OFF: settings.cool_target,
    COLD_ON: settings.cold_on, HEAT_TARGET: settings.heat_target, HEAT_OFF: settings.heat_target };
}
