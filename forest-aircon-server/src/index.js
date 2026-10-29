import { CONFIG, ROOM_OVERRIDES } from './config.js';
import { PLACES, FLOOR_ORDER, placeOfDevice } from './rooms.js';
import { fetchSchedule, itemsByRoom, summarizeRoom } from './schedule.js';
import { Thinq } from './thinq.js';
import { decideRoom, shouldCheckLG } from './auto.js';
import { VERSION } from './version.js';
import { cleanSettings, loadSettings, settingsOf, cfgOf, DEFAULTS } from './settings.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
  }));
  return out;
}

function same(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// APP_PASSWORD 에는 비밀번호를 여러 개 넣을 수 있다(쉼표 또는 줄바꿈으로 구분). 하나라도 맞으면 들어온다.
function passwordOk(given, configured) {
  const list = String(configured).split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  let ok = false;
  for (const pw of list) if (same(given, pw)) ok = true;   // 끝까지 다 비교한다
  return ok;
}

function deviceRoom(d) {
  return ROOM_OVERRIDES[d.id] || placeOfDevice(d.alias);   // 장소 키 | 'later' | null
}

// 일정 + 에어컨 목록·상태를 한 번에 모은다. wantRoom(roomKey)가 거짓인 방의 상태는 읽지 않는다(호출 수 절약).
// 기기 목록(이름·종류)은 거의 안 바뀌므로 1시간 저장해 두고 쓴다 — 목록 조회 1회를 매번 아낀다.
// 세탁기 등 에어컨이 아닌 기기나 산림치유센터 밖의 기기는 목록에는 있어도 «상태 갱신은 절대 하지 않는다».
const LIST_KEY = 'devlist', LIST_TTL_MS = 3600e3;
export async function deviceList(env, thinq, fresh = false) {
  if (env.STATE && !fresh) {
    try { const c = JSON.parse(await env.STATE.get(LIST_KEY) || 'null'); if (c && Array.isArray(c.list) && Date.now() - c.t < LIST_TTL_MS) return c.list; } catch {}
  }
  const list = await thinq.listDevices();
  if (env.STATE) { try { await env.STATE.put(LIST_KEY, JSON.stringify({ t: Date.now(), list })); } catch {} }
  return list;
}

export async function snapshot(env, fetchFn = fetch, wantRoom = () => true, knownSched = null, devicesOverride = null, listFresh = false) {
  if (devicesOverride) return { thinq: null, sched: knownSched || await fetchSchedule(fetchFn), devices: devicesOverride };   // 저장해 둔 기기 상태를 재사용(LG 호출 안 함)
  const thinq = new Thinq(env.THINQ_PAT, { fetchFn });
  const [sched, list] = await Promise.all([knownSched || fetchSchedule(fetchFn), deviceList(env, thinq, listFresh)]);
  const acs = list.filter((d) => /AIR_CONDITIONER/i.test(d.type))
    .map((d) => ({ ...d, room: deviceRoom(d) }))
    .filter((d) => d.room !== 'later');   // 후순위 구역(사무실·업무지원센터 등)은 읽지도 제어하지도 않는다
  const states = await mapLimit(acs, 5, async (d) => {
    // 상태 읽기는 호출 수를 아끼려고 «알려진 방 + 필요한 방»만 한다(Workers 무료 플랜은 요청당 50회 제한)
    if (!d.room || !PLACES[d.room] || PLACES[d.room].noapi || !wantRoom(d.room)) return { ...d, skipped: true };
    try { return { ...d, ...(await thinq.getState(d.id)), ok: true }; }
    catch (e) { return { ...d, ok: false, error: e.message }; }
  });
  return { thinq, sched, devices: states };
}

const heatOn = (env) => env && env.HEAT_ENABLED === '1';   // 난방은 중앙제어로 막혀 있으므로 기본은 꺼짐

function evaluate(sched, devices, smap = {}, heat = false) {
  const by = itemsByRoom(sched.items);
  const out = {}, cfgs = {};
  for (const key of Object.keys(PLACES)) {
    const devs = devices.filter((d) => d.room === key && d.ok);
    const { settings, custom } = settingsOf(smap, key);
    cfgs[key] = { settings, custom };
    if (!settings.enabled && (by[key] || []).length) {
      const temps = devs.map((d) => d.cur).filter((v) => typeof v === 'number');
      out[key] = { state: 'off', reason: '이 방은 자동 제어를 꺼 두었습니다', temp: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length * 10) / 10 : null, actions: [] };
      continue;
    }
    out[key] = decideRoom({ roomItems: by[key] || [], allItems: sched.items, nowMin: sched.nowMin, devices: devs, cfg: cfgOf(settings, heat) });
  }
  return { by, decisions: out, cfgs };
}

const pub = (d) => ({ id: d.id, alias: d.alias, unsupported: !!(d.room && PLACES[d.room] && PLACES[d.room].noapi), ok: !!d.ok, error: d.error || null, power: d.power || null, mode: d.mode || null, cur: d.cur ?? null, target: d.target ?? null });

async function isPaused(env) {
  if (!env.STATE) return false;
  try { return (await env.STATE.get('paused')) === '1'; } catch { return false; }
}

// LG 호출 한도(오류 1314)를 피하려고, 기기 상태를 잠시 저장해 두고 여러 화면이 같이 쓴다.
const CACHE_KEY = 'snapcache', CACHE_TTL_MS = 300e3, FORCE_MIN_MS = 20e3;
async function readCache(env) {
  if (!env.STATE) return null;
  try { const c = JSON.parse(await env.STATE.get(CACHE_KEY) || 'null'); return c && Array.isArray(c.devices) ? c : null; } catch { return null; }
}
async function writeCache(env, devices) {
  if (!env.STATE) return;
  try { await env.STATE.put(CACHE_KEY, JSON.stringify({ t: Date.now(), devices })); } catch {}
}

async function statusResponse(env, fresh = false) {
  const smap = await loadSettings(env);
  const cache = await readCache(env);
  const age = cache ? Date.now() - cache.t : Infinity;
  let snap, stale = null;
  if (cache && (age < FORCE_MIN_MS || (!fresh && age < CACHE_TTL_MS))) {
    snap = await snapshot(env, fetch, () => true, null, cache.devices);
  } else {
    try {
      snap = await snapshot(env, fetch, () => true, null, null, fresh);
      const read = snap.devices.filter((d) => !d.skipped), failed = read.filter((d) => !d.ok);
      if (read.length && failed.length === read.length) throw new Error(failed[0].error);   // 전부 읽기 실패(한도 등): 실패 값을 저장하지 않고 이전 값/안내로 처리
      await writeCache(env, snap.devices);
    } catch (e) {
      let sched;
      try { sched = await fetchSchedule(fetch); } catch { sched = { date: '', nowMin: 0, items: [] }; }
      if (cache) {
        snap = await snapshot(env, fetch, () => true, sched, cache.devices);
        stale = { ageSec: Math.round(age / 1000), reason: e.message };
      } else {
        // 저장된 값도 없으면: 에어컨 상태 없이 방 구성(평면도)만 보여주고 이유를 알린다 — 로그인은 막지 않는다
        snap = await snapshot(env, fetch, () => true, sched, []);
        stale = { ageSec: null, reason: e.message };
      }
    }
  }
  const { by, decisions, cfgs } = evaluate(snap.sched, snap.devices, smap, heatOn(env));
  const floors = FLOOR_ORDER.map((f) => ({
    floor: f,
    rooms: Object.entries(PLACES).filter(([, r]) => r.floor === f).map(([key, r]) => ({
      key, name: r.name, short: r.short, scheduled: r.sched, noapi: !!r.noapi, settings: cfgs[key].settings, customSettings: cfgs[key].custom,
      schedule: summarizeRoom(by[key] || [], snap.sched.items, snap.sched.nowMin),
      devices: snap.devices.filter((d) => d.room === key).map(pub),
      temp: decisions[key].temp,
      auto: { state: decisions[key].state, reason: decisions[key].reason, actions: decisions[key].actions.map((a) => a.why) },
    })),
  }));
  return {
    version: VERSION,
    stale,
    cachedSec: Number.isFinite(age) && !stale ? Math.round(age / 1000) : 0,
    date: snap.sched.date,
    nowMin: snap.sched.nowMin,
    floors,
    others: snap.devices.filter((d) => !d.room).map(pub),   // 어느 방인지 모르는 에어컨(표에 추가 필요)
    auto: { mode: env.AUTO_MODE === 'live' ? 'live' : 'dry', heat: heatOn(env), paused: await isPaused(env), canPause: !!env.STATE, canSave: !!env.STATE, defaults: DEFAULTS },
  };
}

// 수동 제어: { deviceIds:[...], action:'cool'|'heat'|'off'|'temp', value? }
async function controlResponse(env, body) {
  const ids = Array.isArray(body.deviceIds) ? body.deviceIds.map(String) : [];
  const action = String(body.action || '');
  if (!ids.length) return json({ ok: false, error: '대상 에어컨이 없습니다' }, 400);
  if (ids.length > 12) return json({ ok: false, error: '한 번에 12대까지만 제어합니다' }, 400);
  if (!['cool', 'heat', 'off', 'temp'].includes(action)) return json({ ok: false, error: '알 수 없는 동작' }, 400);
  if (action === 'heat' && !heatOn(env)) return json({ ok: false, error: '난방은 현재 중앙제어로 막혀 있어 사용하지 않습니다' }, 400);
  let value = null;
  if (action === 'temp') {
    value = Number(body.value);
    if (!(value >= 16 && value <= 30)) return json({ ok: false, error: '온도는 16~30°C 사이로 입력하세요' }, 400);
  }
  const thinq = new Thinq(env.THINQ_PAT);
  const acs = (await deviceList(env, thinq)).filter((d) => /AIR_CONDITIONER/i.test(d.type));
  const known = new Set(acs.filter((d) => { const k = deviceRoom(d); return k && PLACES[k] && !PLACES[k].noapi; }).map((d) => d.id));
  const results = [];
  for (const id of ids) {
    if (!known.has(id)) { results.push({ id, ok: false, error: '제어할 수 없는 에어컨입니다(미등록·후순위·API 미지원)' }); continue; }
    try {
      await applyOne(thinq, id, action === 'cool' ? { power: 'ON', mode: 'COOL', temp: body.value ? Number(body.value) : undefined }
        : action === 'heat' ? { power: 'ON', mode: 'HEAT', temp: body.value ? Number(body.value) : undefined }
        : action === 'off' ? { power: 'OFF' } : { temp: value });
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
    await sleep(300);
  }
  return json({ ok: results.every((r) => r.ok), results });
}

// 방(또는 층) 단위 새로고침: 지정한 에어컨의 상태만 읽는다(목록 조회 없음, 저장된 목록으로 허용 여부 확인).
async function refreshResponse(env, body) {
  const ids = Array.isArray(body.deviceIds) ? [...new Set(body.deviceIds.map(String))] : [];
  if (!ids.length) return json({ ok: false, error: '대상 에어컨이 없습니다' }, 400);
  if (ids.length > 14) return json({ ok: false, error: '한 번에 14대까지만 새로고침합니다' }, 400);
  const thinq = new Thinq(env.THINQ_PAT);
  const acs = (await deviceList(env, thinq)).filter((d) => /AIR_CONDITIONER/i.test(d.type));
  const allowed = new Set(acs.filter((d) => { const k = deviceRoom(d); return k && PLACES[k] && !PLACES[k].noapi; }).map((d) => d.id));
  const out = [];
  for (const id of ids) {
    if (!allowed.has(id)) { out.push({ id, ok: false, error: '새로고침 대상이 아닙니다(미등록·후순위·API 미지원)' }); continue; }
    try { out.push({ id, ok: true, ...(await thinq.getState(id)) }); }
    catch (e) { out.push({ id, ok: false, error: e.message }); if (e.status === 1314) break; }   // 한도에 걸리면 더 부르지 않는다
  }
  // 저장해 둔 상태에도 반영(다른 화면이 같은 값을 보도록)
  const cache = await readCache(env);
  if (cache) {
    for (const r of out) { const i = cache.devices.findIndex((d) => d.id === r.id); if (i >= 0 && r.ok) cache.devices[i] = { ...cache.devices[i], ...r, ok: true, error: undefined, skipped: undefined }; }
    if (env.STATE) { try { await env.STATE.put(CACHE_KEY, JSON.stringify(cache)); } catch {} }
  }
  return json({ ok: true, devices: out.map((r) => ({ id: r.id, ok: !!r.ok, error: r.error || null, power: r.power || null, mode: r.mode || null, cur: r.cur ?? null, target: r.target ?? null })) });
}

async function applyOne(thinq, id, a) {
  if (a.power === 'OFF') { await thinq.setPower(id, false); return; }
  if (a.power === 'ON') { await thinq.setPower(id, true); await sleep(300); }
  if (a.mode) { await thinq.setMode(id, a.mode); await sleep(300); }
  if (typeof a.temp === 'number' && Number.isFinite(a.temp)) await thinq.setTemp(id, a.temp, a.mode);
}

// 5분마다 도는 자동 제어
export async function runAuto(env, fetchFn = fetch, now = new Date(), knownSched = null) {
  const hour = new Date(now.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (hour < CONFIG.ACTIVE_FROM_HOUR || hour >= CONFIG.ACTIVE_TO_HOUR) return { skipped: 'time' };
  if (await isPaused(env)) { console.log('[auto] 일시중지 중'); return { skipped: 'paused' }; }

  const sched = knownSched || await fetchSchedule(fetchFn);
  const by = itemsByRoom(sched.items);
  const snap = await snapshot(env, fetchFn, (k) => (by[k] || []).length > 0, sched);
  const { decisions } = evaluate(snap.sched, snap.devices, await loadSettings(env), heatOn(env));
  const live = env.AUTO_MODE === 'live';
  const log = [];
  for (const [key, d] of Object.entries(decisions)) {
    if (!d.actions.length) continue;
    for (const a of d.actions) {
      const line = { room: key, device: a.deviceId.slice(0, 8), do: a.why, reason: d.reason, live };
      if (live) {
        try { await applyOne(snap.thinq, a.deviceId, a); line.result = 'ok'; }
        catch (e) { line.result = 'fail: ' + e.message; }
        await sleep(300);
      }
      log.push(line);
      console.log('[auto]', JSON.stringify(line));
    }
  }
  if (!log.length) console.log('[auto] 조치 없음', JSON.stringify(Object.fromEntries(Object.entries(decisions).filter(([, d]) => d.state !== 'none').map(([k, d]) => [k, d.reason]))));
  return { live, log };
}

// 5분마다 깨어나지만, LG 는 «필요한 때»에만 부른다(일정 시작 60분 전부터, 30분마다 + 중요한 순간)
export async function tickAuto(env, fetchFn = fetch, now = new Date()) {
  const hour = new Date(now.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (hour < CONFIG.ACTIVE_FROM_HOUR || hour >= CONFIG.ACTIVE_TO_HOUR) return { skipped: 'time' };
  const sched = await fetchSchedule(fetchFn);
  const smap = await loadSettings(env);
  const by = itemsByRoom(sched.items);
  const g = shouldCheckLG({ by, allItems: sched.items, nowMin: sched.nowMin, settingsOf: (k) => settingsOf(smap, k).settings, graceMin: CONFIG.POST_GRACE_MIN });
  if (!g.run) { console.log('[auto] LG 호출 안 함 —', g.why); return { skipped: 'gate', why: g.why }; }
  console.log('[auto] LG 확인 —', g.why);
  return runAuto(env, fetchFn, now, sched);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!env.APP_PASSWORD || !env.THINQ_PAT) {
      const missing = ['APP_PASSWORD', 'THINQ_PAT'].filter((k) => !env[k]);
      // 값은 절대 내보내지 않고 "이름"만 보여준다(이름에 공백·오타가 섞였는지 확인용)
      const seen = Object.keys(env).filter((k) => k !== 'ASSETS').map((k) => JSON.stringify(k)).join(', ') || '없음';
      return json({ ok: false, error: `서버 설정이 끝나지 않았습니다(없는 비밀값: ${missing.join(', ')} / 서버가 받은 항목 이름: ${seen})` }, 503);
    }
    if (!passwordOk(request.headers.get('x-app-password') || '', env.APP_PASSWORD)) {
      return json({ ok: false, error: '비밀번호가 맞지 않습니다' }, 401);
    }
    if (url.pathname === '/api/ping') return json({ ok: true, version: VERSION });   // 비밀번호 확인만(LG 호출 없음)
    try {
      if (url.pathname === '/api/status' && request.method === 'GET') return json({ ok: true, ...(await statusResponse(env, url.searchParams.get('fresh') === '1')) });
      if (url.pathname === '/api/devices' && request.method === 'GET') {
        const list = await new Thinq(env.THINQ_PAT).listDevices();
        return json({ ok: true, devices: list.map((d) => ({ ...d, room: deviceRoom(d) || null })) });
      }
      if (url.pathname === '/api/refresh' && request.method === 'POST') return await refreshResponse(env, await request.json());
      if (url.pathname === '/api/control' && request.method === 'POST') return await controlResponse(env, await request.json());
      if (url.pathname === '/api/settings' && request.method === 'POST') {
        if (!env.STATE) return json({ ok: false, error: '설정을 저장하려면 서버에 KV(STATE)를 연결해야 합니다(README 참고)' }, 400);
        const b = await request.json();
        const key = String(b.room || '');
        if (!PLACES[key] || !PLACES[key].sched) return json({ ok: false, error: '자동 제어 설정이 없는 방입니다' }, 400);
        const map = await loadSettings(env);
        if (b.reset) delete map[key];
        else {
          const c = cleanSettings(b.settings);
          if (c.error) return json({ ok: false, error: c.error }, 400);
          map[key] = c.value;
        }
        await env.STATE.put('settings', JSON.stringify(map));
        const r = settingsOf(map, key);
        return json({ ok: true, room: key, settings: r.settings, customSettings: r.custom });
      }
      if (url.pathname === '/api/pause' && request.method === 'POST') {
        if (!env.STATE) return json({ ok: false, error: 'KV(STATE)가 연결되지 않았습니다' }, 400);
        const b = await request.json();
        await env.STATE.put('paused', b.paused ? '1' : '0');
        return json({ ok: true, paused: !!b.paused });
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.THINQ_PAT) { console.log('[auto] THINQ_PAT 없음'); return; }
    ctx.waitUntil(tickAuto(env).catch((e) => console.log('[auto] 오류', e.message)));
  },
};
