// «한 묶음만 켜고, 온도가 안 내려가면 전부 켜고, 내려가면 다시 한 묶음으로» 단계 판단(순수 함수)
//  · 단계 'one'  : 한 묶음(예: 2대 중 1대)만 켜진 상태
//  · 단계 'all'  : 나머지도 켠 상태
//  · STAGE.CHECK_MIN 분마다 방 온도를 비교한다. 기준 온도보다 STAGE.DROP 도 이상 내려가지 않았으면 전부 켜고,
//    전부 켠 뒤 STAGE.DROP 도 이상 내려갔으면 처음 켠 묶음만 남기고 끈다.
//  · 프로그램 진행 중(active)에는 아무것도 하지 않는다.
export const STAGE = Object.freeze({ CHECK_MIN: 30, DROP: 1 });

// state: {date, stage, t, temp, keep:[id]} | null
// devs: 방의 쓸 수 있는 에어컨 [{id, power, mode}] / isOn(d): «켜져 있음» 판단(비품실은 모드 상관없이 켜짐 기준)
// firstGroupIds: 처음 켜는 묶음 후보(전부 켜진 상태로 처음 본 경우 남길 묶음)
// need: 이 온도보다 높으면(=더 식혀야 하면) 전부 켠다
export function stageStep({ state, date, nowMin, temp, active, devs, isOn, firstGroupIds = [], need, cool = true, coolTarget }) {
  if (active || temp === null || temp === undefined) return { actions: [], state };
  const all = devs.map((d) => d.id), on = devs.filter(isOn).map((d) => d.id);
  if (!on.length || all.length < 2) return { actions: [], state: null };
  const fresh = !state || state.date !== date || (state.keep || []).every((id) => !on.includes(id));
  if (fresh) {
    const keep = on.length < all.length ? on : (firstGroupIds.length ? firstGroupIds.filter((id) => on.includes(id)) : [on[0]]);
    return { actions: [], state: { date, stage: on.length < all.length ? 'one' : 'all', t: nowMin, temp, keep } };
  }
  if (nowMin - state.t < STAGE.CHECK_MIN - 5) return { actions: [], state };
  const drop = state.temp - temp;
  const next = { ...state };
  const actions = [];
  if (on.length < all.length) {
    if (temp > need && drop < STAGE.DROP) {
      for (const d of devs) if (!isOn(d)) actions.push(cool
        ? { deviceId: d.id, power: 'ON', mode: 'COOL', temp: coolTarget, wind: 'AUTO', why: `냉방 켜기 — ${STAGE.CHECK_MIN}분 동안 ${Math.round(drop * 10) / 10}° 내려가 나머지도 켬` }
        : { deviceId: d.id, power: 'ON', why: `켜기 — ${STAGE.CHECK_MIN}분 동안 ${Math.round(drop * 10) / 10}° 내려가 나머지도 켬` });
      next.stage = 'all';
    }
    next.t = nowMin; next.temp = temp;
  } else {
    if (drop >= STAGE.DROP && state.stage === 'all') {
      for (const d of devs) if (isOn(d) && !(state.keep || []).includes(d.id)) actions.push({ deviceId: d.id, power: 'OFF', stageRevert: true, why: `끄기 — 온도가 ${Math.round(drop * 10) / 10}° 내려가 한 묶음만 남김` });
      next.stage = 'one';
    }
    next.t = nowMin; next.temp = temp;
  }
  return { actions, state: next };
}
