import { CONFIG, ROOM_OVERRIDES, ALWAYS_COOL_ROOMS, WIND_DEFAULT } from './config.js';
import { loadLogs, addLogs, pickLogs } from './logs.js';
import { PLACES, FLOOR_ORDER, placeOfDevice } from './rooms.js';
import { fetchSchedule, itemsByRoom, summarizeRoom } from './schedule.js';
import { Thinq } from './thinq.js';
import { decideRoom, shouldCheckLG } from './auto.js';
import { timedActions, coldAlerts, roomsNeeded, hhmm } from './rules.js';
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

function evaluate(sched, devices, smap = {}, heat = false, retry = false) {
  const by = itemsByRoom(sched.items);
  const out = {}, cfgs = {};
  for (const key of Object.keys(PLACES)) {
    const devs = devices.filter((d) => d.room === key && d.ok);
    const { settings, custom } = settingsOf(smap, key);
    cfgs[key] = { settings, custom };
    const always = ALWAYS_COOL_ROOMS.includes(key);
    if (!settings.enabled && ((by[key] || []).length || always)) {
      const temps = devs.map((d) => d.cur).filter((v) => typeof v === 'number');
      out[key] = { state: 'off', reason: '이 방은 자동 제어를 꺼 두었습니다', temp: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length * 10) / 10 : null, actions: [] };
      continue;
    }
    out[key] = decideRoom({ roomItems: by[key] || [], allItems: sched.items, nowMin: sched.nowMin, devices: devs, cfg: { ...cfgOf(settings, heat), ALWAYS_COOL: always, RETRY_ON: retry } });
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
    alerts: (await loadAlerts(env)).filter((a) => a.date === snap.sched.date && !a.ack).map(alertView),
    auto: { mode: env.AUTO_MODE === 'live' ? 'live' : 'dry', heat: heatOn(env), paused: await isPaused(env), canPause: !!env.STATE, canSave: !!env.STATE, defaults: DEFAULTS },
  };
}

// 수동 제어: { deviceIds:[...], action:'cool'|'heat'|'off'|'temp', value? }
async function controlResponse(env, body) {
  const ids = Array.isArray(body.deviceIds) ? body.deviceIds.map(String) : [];
  const action = String(body.action || '');
  if (!ids.length) return json({ ok: false, error: '대상 에어컨이 없습니다' }, 400);
  if (ids.length > 12) return json({ ok: false, error: '한 번에 12대까지만 제어합니다' }, 400);
  if (!['cool', 'heat', 'off', 'temp', 'wind'].includes(action)) return json({ ok: false, error: '알 수 없는 동작' }, 400);
  if (action === 'heat' && !heatOn(env)) return json({ ok: false, error: '난방은 현재 중앙제어로 막혀 있어 사용하지 않습니다' }, 400);
  let value = null;
  const WINDS = { AUTO: '자동', LOW: '약', MID: '중', HIGH: '강' };
  if (action === 'wind') {
    value = String(body.value || '');
    if (!WINDS[value]) return json({ ok: false, error: '바람 세기는 자동·약·중·강 중에서 고르세요' }, 400);
  }
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
      const warn = await applyOne(thinq, id, action === 'cool' ? { power: 'ON', mode: 'COOL', temp: body.value ? Number(body.value) : CONFIG.COOL_TARGET, wind: WIND_DEFAULT }
        : action === 'heat' ? { power: 'ON', mode: 'HEAT', temp: body.value ? Number(body.value) : undefined }
        : action === 'off' ? { power: 'OFF' } : action === 'wind' ? { wind: value } : { temp: value });
      results.push({ id, ok: true, warn });
    } catch (e) { results.push({ id, ok: false, error: e.message }); }
    await sleep(300);
  }
  const byId = new Map(acs.map((d) => [d.id, d]));
  const label = action === 'cool' ? `냉방 켜기 ${body.value ? Number(body.value) : CONFIG.COOL_TARGET}° · 바람 자동` : action === 'heat' ? '난방 켜기' : action === 'off' ? '끄기' : action === 'wind' ? `바람 세기 ${WINDS[value]}` : `온도 ${value}°`;
  await addLogs(env, results.map((r) => { const d = byId.get(r.id) || {}; const k = d.id ? deviceRoom(d) : null; return { kind: 'manual', room: (PLACES[k] || {}).name || '', dev: d.alias || r.id.slice(0, 8), what: label, res: r.ok ? 'ok' : 'fail', note: r.ok ? (r.warn || []).join(' / ') : r.error }; }));
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

// 에어컨 한 대에 켜기/모드/온도/바람세기를 적용한다. 반환: 경고 목록(바람세기처럼 «실패해도 켜기는 된» 항목)
async function applyOne(thinq, id, a) {
  const warn = [];
  if (a.power === 'OFF') { await thinq.setPower(id, false); return warn; }
  if (a.power === 'ON') { await thinq.setPower(id, true); await sleep(300); }
  if (a.mode) { await thinq.setMode(id, a.mode); await sleep(300); }
  if (typeof a.temp === 'number' && Number.isFinite(a.temp)) { await thinq.setTemp(id, a.temp, a.mode); await sleep(300); }
  if (a.wind) { try { await thinq.setWind(id, a.wind); } catch (e) { warn.push('바람세기 ' + a.wind + ' 설정 실패: ' + e.message); } }
  return warn;
}
const costOf = (a) => a.power === 'OFF' ? 1 : 1 + (a.mode ? 1 : 0) + (typeof a.temp === 'number' ? 2 : 0) + (a.wind ? 1 : 0);
const SUBREQ_LIMIT = 40;   // 무료 플랜 요청당 50회(일정·KV 몫을 빼고 LG 호출은 40회까지)

// 에어컨이 실제로 지원하는 항목(LG 가 알려 주는 «기기 프로파일») — 쾌적풍·바람 방향 같은 기능이 되는지 확인용
function flattenProfile(o, path = [], out = []) {
  if (!o || typeof o !== 'object') return out;
  if (o.type !== undefined && o.mode !== undefined) {
    const v = o.value && (o.value.w || o.value.r || o.value);
    out.push({ path: path.join('.'), mode: [].concat(o.mode).join('/'), type: o.type, value: JSON.stringify(v).slice(0, 140) });
    return out;
  }
  for (const [k, v] of Object.entries(o)) flattenProfile(v, [...path, k], out);
  return out;
}
async function profileResponse(env, id) {
  const thinq = new Thinq(env.THINQ_PAT);
  const acs = (await deviceList(env, thinq)).filter((d) => /AIR_CONDITIONER/i.test(d.type)).map((d) => ({ ...d, room: deviceRoom(d) })).filter((d) => d.room && PLACES[d.room] && !PLACES[d.room].noapi);
  const dev = (id && acs.find((d) => d.id === id)) || acs[0];
  if (!dev) return json({ ok: false, error: '조회할 에어컨이 없습니다' }, 404);
  const prof = await thinq.getProfile(dev.id);
  return json({ ok: true, alias: dev.alias, model: dev.model, items: flattenProfile(prof.property || prof) });
}

// ── 알림(KV 'alerts'): 오늘 날짜 것만 보여 주고, «확인»하면 사라진다 ──
const ALERT_KEY = 'alerts';
export async function loadAlerts(env) {
  if (!env.STATE) return [];
  try { const a = JSON.parse(await env.STATE.get(ALERT_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function saveAlerts(env, list) { if (env.STATE) { try { await env.STATE.put(ALERT_KEY, JSON.stringify(list.slice(-40))); } catch {} } }
export async function addAlerts(env, news) {
  if (!news.length) return;
  const cur = await loadAlerts(env);
  const have = new Set(cur.map((a) => a.id));
  const add = news.filter((a) => !have.has(a.id)).map((a) => ({ ...a, ack: false }));
  if (add.length) await saveAlerts(env, [...cur, ...add]);
}
const alertView = (a) => ({ id: a.id, room: a.room, name: (PLACES[a.room] || {}).name || a.room, temp: a.temp, start: hhmm(a.start), at: a.at, ack: !!a.ack,
  msg: `난방 확인 필요! ${(PLACES[a.room] || {}).name || a.room} ${a.temp}° — ${hhmm(a.start)} 프로그램 있음` });

// 5분마다 도는 자동 제어
export async function runAuto(env, fetchFn = fetch, now = new Date(), knownSched = null, opts = {}) {
  const hour = new Date(now.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (hour < CONFIG.ACTIVE_FROM_HOUR || hour >= CONFIG.ACTIVE_TO_HOUR) return { skipped: 'time' };
  if (await isPaused(env)) { console.log('[auto] 일시중지 중'); return { skipped: 'paused' }; }

  const sched = knownSched || await fetchSchedule(fetchFn);
  const by = itemsByRoom(sched.items);
  const need = roomsNeeded(sched.nowMin, Object.keys(PLACES));
  const snap = await snapshot(env, fetchFn, (k) => need.has(k) || ALWAYS_COOL_ROOMS.includes(k) || (!opts.supplyOnly && (by[k] || []).length > 0), sched);
  const smap = await loadSettings(env);
  const { decisions } = evaluate(snap.sched, snap.devices, smap, heatOn(env), !!opts.retry);
  const enabledOf = (k) => settingsOf(smap, k).settings.enabled;
  const live = env.AUTO_MODE === 'live';
  const entries = [];
  const aliasOf = new Map(snap.devices.map((d) => [d.id, d.alias]));
  const nameOf = (k) => (PLACES[k] || {}).name || k || '';

  // 상태를 못 읽은 에어컨이 있으면 오류로 남긴다(LG 호출 한도 등)
  const failed = snap.devices.filter((d) => d.ok === false);
  if (failed.length) entries.push({ kind: 'sys', what: `에어컨 ${failed.length}대 상태 읽기 실패`, res: 'fail', note: failed[0].error });

  // 추운 방 알림(난방은 중앙제어라 사람이 확인)
  const cold = coldAlerts({ nowMin: sched.nowMin, decisions, by, allItems: sched.items, enabledOf, date: sched.date });
  if (cold.length) {
    await addAlerts(env, cold); console.log('[alert]', JSON.stringify(cold));
    for (const c of cold) entries.push({ kind: 'auto', room: nameOf(c.room), what: '난방 확인 필요 알림', res: 'ok', note: `${c.temp}° — ${hhmm(c.start)} 프로그램 있음` });
  }

  // 조치 모으기: 일정 기반 판단 + 시각 규칙(같은 에어컨이면 시각 규칙이 우선). 비품실은 어떤 경우에도 끄지 않는다.
  const todo = new Map();
  for (const [key, d] of Object.entries(decisions)) for (const a of d.actions) todo.set(a.deviceId, { ...a, room: key, reason: d.reason });
  for (const a of timedActions({ nowMin: sched.nowMin, devices: snap.devices, by, allItems: sched.items, enabledOf })) todo.set(a.deviceId, { ...a, reason: a.why });
  for (const [id, a] of todo) if (a.room === 'supply' && a.power === 'OFF') todo.delete(id);
  for (const a of todo.values()) if (a.power === 'ON' && a.mode === 'COOL') { if (typeof a.temp !== 'number') a.temp = CONFIG.COOL_TARGET; a.wind = a.wind || WIND_DEFAULT; }

  const log = [];
  let deferred = 0;
  for (const a of todo.values()) {
    const line = { room: a.room, device: a.deviceId.slice(0, 8), do: a.why, reason: a.reason, live };
    const e = { kind: 'auto', room: nameOf(a.room), dev: aliasOf.get(a.deviceId) || a.deviceId.slice(0, 8), what: a.why, note: a.reason && a.reason !== a.why ? a.reason : '' };
    if (live) {
      if (snap.thinq && snap.thinq.calls + costOf(a) > SUBREQ_LIMIT) { deferred++; line.result = 'deferred'; e.res = 'skip'; e.note = '요청 한도 때문에 다음 점검으로 미룸'; }
      else {
        try { const w = await applyOne(snap.thinq, a.deviceId, a); line.result = 'ok'; e.res = 'ok'; if (w.length) e.note = (e.note ? e.note + ' / ' : '') + w.join(' / '); }
        catch (er) { line.result = 'fail: ' + er.message; e.res = 'fail'; e.note = (e.note ? e.note + ' — ' : '') + er.message; }
        await sleep(300);
      }
    } else { e.res = 'skip'; e.note = '시험 모드 — 실제로 제어하지 않음'; }
    entries.push(e); log.push(line);
    console.log('[auto]', JSON.stringify(line));
  }
  if (env.STATE) { try { await env.STATE.put('retry', deferred ? '1' : '0'); } catch {} }   // 미룬 일이 있으면 다음 5분 점검에서 바로 이어서 한다
  if (!log.length) console.log('[auto] 조치 없음', JSON.stringify(Object.fromEntries(Object.entries(decisions).filter(([, d]) => d.state !== 'none').map(([k, d]) => [k, d.reason]))));
  await addLogs(env, entries, now);
  return { live, log, alerts: cold, deferred };
}

// 5분마다 깨어나지만, LG 는 «필요한 때»에만 부른다(일정 시작 60분 전부터, 30분마다 + 중요한 순간)
export async function tickAuto(env, fetchFn = fetch, now = new Date()) {
  const hour = new Date(now.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (hour < CONFIG.ACTIVE_FROM_HOUR || hour >= CONFIG.ACTIVE_TO_HOUR) return { skipped: 'time' };
  const sched = await fetchSchedule(fetchFn);
  const smap = await loadSettings(env);
  const by = itemsByRoom(sched.items);
  let g = shouldCheckLG({ by, allItems: sched.items, nowMin: sched.nowMin, settingsOf: (k) => settingsOf(smap, k).settings, graceMin: CONFIG.POST_GRACE_MIN, alwaysKeys: ALWAYS_COOL_ROOMS });
  if (!g.run && env.STATE) { try { if (await env.STATE.get('retry') === '1') g = { run: true, why: '미룬 조치 이어서 하기', retry: true }; } catch {} }
  if (!g.run) { console.log('[auto] LG 호출 안 함 —', g.why); return { skipped: 'gate', why: g.why }; }
  console.log('[auto] LG 확인 —', g.why);
  return runAuto(env, fetchFn, now, sched, { supplyOnly: !!g.supplyOnly, retry: !!g.retry });
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
      if (url.pathname === '/api/logs' && request.method === 'GET') {
        const kind = url.searchParams.get('kind') || 'auto';
        return json({ ok: true, kind, canStore: !!env.STATE, logs: pickLogs(await loadLogs(env), kind) });
      }
      if (url.pathname === '/api/profile' && request.method === 'GET') return await profileResponse(env, url.searchParams.get('id'));
      if (url.pathname === '/api/alerts/ack' && request.method === 'POST') {
        const b = await request.json();
        const ids = b.all ? null : new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
        const list = await loadAlerts(env);
        for (const a of list) if (!ids || ids.has(a.id)) a.ack = true;
        await saveAlerts(env, list);
        return json({ ok: true });
      }
      if (url.pathname === '/api/pause' && request.method === 'POST') {
        if (!env.STATE) return json({ ok: false, error: 'KV(STATE)가 연결되지 않았습니다' }, 400);
        const b = await request.json();
        await env.STATE.put('paused', b.paused ? '1' : '0');
        await addLogs(env, [{ kind: 'manual', what: b.paused ? '자동 제어 일시중지' : '자동 제어 다시 켬', res: 'ok' }]);
        return json({ ok: true, paused: !!b.paused });
      }
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.THINQ_PAT) { console.log('[auto] THINQ_PAT 없음'); return; }
    ctx.waitUntil(tickAuto(env).catch(async (e) => { console.log('[auto] 오류', e.message); await addLogs(env, [{ kind: 'sys', what: '자동 점검 오류', res: 'fail', note: e.message }]); }));
  },
};
