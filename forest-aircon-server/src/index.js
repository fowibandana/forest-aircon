import { CONFIG, ROOM_OVERRIDES } from './config.js';
import { PLACES, FLOOR_ORDER, placeOfDevice } from './rooms.js';
import { fetchSchedule, itemsByRoom, summarizeRoom } from './schedule.js';
import { Thinq } from './thinq.js';
import { decideRoom } from './auto.js';
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
export async function snapshot(env, fetchFn = fetch, wantRoom = () => true, knownSched = null) {
  const thinq = new Thinq(env.THINQ_PAT, { fetchFn });
  const [sched, list] = await Promise.all([knownSched || fetchSchedule(fetchFn), thinq.listDevices()]);
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

function evaluate(sched, devices, smap = {}) {
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
    out[key] = decideRoom({ roomItems: by[key] || [], allItems: sched.items, nowMin: sched.nowMin, devices: devs, cfg: cfgOf(settings) });
  }
  return { by, decisions: out, cfgs };
}

const pub = (d) => ({ id: d.id, alias: d.alias, unsupported: !!(d.room && PLACES[d.room] && PLACES[d.room].noapi), ok: !!d.ok, error: d.error || null, power: d.power || null, mode: d.mode || null, cur: d.cur ?? null, target: d.target ?? null });

async function isPaused(env) {
  if (!env.STATE) return false;
  try { return (await env.STATE.get('paused')) === '1'; } catch { return false; }
}

async function statusResponse(env) {
  const [snap, smap] = await Promise.all([snapshot(env), loadSettings(env)]);
  const { by, decisions, cfgs } = evaluate(snap.sched, snap.devices, smap);
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
    date: snap.sched.date,
    nowMin: snap.sched.nowMin,
    floors,
    others: snap.devices.filter((d) => !d.room).map(pub),   // 어느 방인지 모르는 에어컨(표에 추가 필요)
    auto: { mode: env.AUTO_MODE === 'live' ? 'live' : 'dry', paused: await isPaused(env), canPause: !!env.STATE, canSave: !!env.STATE, defaults: DEFAULTS },
  };
}

// 수동 제어: { deviceIds:[...], action:'cool'|'heat'|'off'|'temp', value? }
async function controlResponse(env, body) {
  const ids = Array.isArray(body.deviceIds) ? body.deviceIds.map(String) : [];
  const action = String(body.action || '');
  if (!ids.length) return json({ ok: false, error: '대상 에어컨이 없습니다' }, 400);
  if (ids.length > 12) return json({ ok: false, error: '한 번에 12대까지만 제어합니다' }, 400);
  if (!['cool', 'heat', 'off', 'temp'].includes(action)) return json({ ok: false, error: '알 수 없는 동작' }, 400);
  let value = null;
  if (action === 'temp') {
    value = Number(body.value);
    if (!(value >= 16 && value <= 30)) return json({ ok: false, error: '온도는 16~30°C 사이로 입력하세요' }, 400);
  }
  const thinq = new Thinq(env.THINQ_PAT);
  const acs = (await thinq.listDevices()).filter((d) => /AIR_CONDITIONER/i.test(d.type));
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

async function applyOne(thinq, id, a) {
  if (a.power === 'OFF') { await thinq.setPower(id, false); return; }
  if (a.power === 'ON') { await thinq.setPower(id, true); await sleep(300); }
  if (a.mode) { await thinq.setMode(id, a.mode); await sleep(300); }
  if (typeof a.temp === 'number' && Number.isFinite(a.temp)) await thinq.setTemp(id, a.temp, a.mode);
}

// 5분마다 도는 자동 제어
export async function runAuto(env, fetchFn = fetch, now = new Date()) {
  const hour = new Date(now.getTime() + 9 * 3600 * 1000).getUTCHours();
  if (hour < CONFIG.ACTIVE_FROM_HOUR || hour >= CONFIG.ACTIVE_TO_HOUR) return { skipped: 'time' };
  if (await isPaused(env)) { console.log('[auto] 일시중지 중'); return { skipped: 'paused' }; }

  const sched = await fetchSchedule(fetchFn);
  const by = itemsByRoom(sched.items);
  const snap = await snapshot(env, fetchFn, (k) => (by[k] || []).length > 0, sched);
  const { decisions } = evaluate(snap.sched, snap.devices, await loadSettings(env));
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!env.APP_PASSWORD || !env.THINQ_PAT) {
      const missing = ['APP_PASSWORD', 'THINQ_PAT'].filter((k) => !env[k]);
      return json({ ok: false, error: `서버 설정이 끝나지 않았습니다(없는 비밀값: ${missing.join(', ')})` }, 503);
    }
    if (!passwordOk(request.headers.get('x-app-password') || '', env.APP_PASSWORD)) {
      return json({ ok: false, error: '비밀번호가 맞지 않습니다' }, 401);
    }
    try {
      if (url.pathname === '/api/status' && request.method === 'GET') return json({ ok: true, ...(await statusResponse(env)) });
      if (url.pathname === '/api/devices' && request.method === 'GET') {
        const list = await new Thinq(env.THINQ_PAT).listDevices();
        return json({ ok: true, devices: list.map((d) => ({ ...d, room: deviceRoom(d) || null })) });
      }
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
    ctx.waitUntil(runAuto(env).catch((e) => console.log('[auto] 오류', e.message)));
  },
};
