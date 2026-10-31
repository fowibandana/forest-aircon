import assert from 'node:assert/strict';
import worker, { tickAuto, runAuto, snapshot } from '../src/index.js';
import { decideRoom } from '../src/auto.js';
import { CONFIG } from '../src/config.js';

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e).split('\n').slice(0, 4).join('\n      ')); process.exitCode = 1; } };

/* ── 모의 서버: 일정 + ThinQ ─────────────────────────────────── */
const ALIASES = {
  // 2F
  '음파실 내측': 'r201', '음파실 창측': 'r201', '입식다도실 스크린측': 'r202', '입식다도실 강사측': 'r202',
  '203호 스크린측': 'r203', '203호 입구측': 'r203', '204호 스크린측': 'r204', '204호 입구측': 'r204',
  '좌식다도실 탕비실측': 'r205', '좌식다도실 강사측': 'r205',
  // 1F / B1
  '치유장비실 1': 'hp1', '치유장비실 2': 'hp1', '치유장비실 3': 'hp1', '치유장비실 4': 'hp1', '산림치유센터 탈의실 여': 'dressF', '산림치유센터 탈의실 남': 'dressM', '산림치유센터 비품실': 'supply', '건강증진실2 1': 'hp2', '건강증진실2 2': 'hp2', '건강증진실2 3': 'hp2', '건강증진실2 4': 'hp2', '해아림홀 뒤': 'haearim',
  'B101호': 'b101', '건강측정실 입구측': 'b102', '실감실': 'media',
  // 후순위
  '데탁': 'later', '엘베쪽': 'later',
};
function makeWorld({ nowMin = 9 * 60, items = [], temps = {}, power = {}, mode = {} }) {
  const devices = Object.keys(ALIASES).map((a, i) => ({ deviceId: 'dev' + i, alias: '에어컨(' + a + ')', type: 'DEVICE_AIR_CONDITIONER' }));
  devices.push({ deviceId: 'wash1', alias: '세탁기1호', type: 'DEVICE_WASHER' });
  const calls = [];
  const state = {};
  for (const d of devices) {
    const a = d.alias.replace(/^에어컨\(|\)$/g, '');
    state[d.deviceId] = {
      operation: { airConOperationMode: power[a] || (/비품실/.test(a) ? 'POWER_ON' : 'POWER_OFF') },
      airConJobMode: { currentJobMode: mode[a] || 'COOL' },
      temperature: { currentTemperature: temps[ALIASES[a]] ?? 24, targetTemperature: 24, unit: 'C' },
    };
  }
  const nowMs = Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + nowMin * 60e3;
  const fetchFn = async function (url, opt = {}) {
    // 진짜 Workers 의 fetch 처럼, 메서드로 호출되면(this 가 객체) 거절한다
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
    calls.push({ url, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null });
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (url.includes('jinan-schedule')) return ok({ ok: true, date: '2026-10-27', serverMs: nowMs, items });
    if (url.endsWith('/devices')) return ok({ response: devices.map((d) => ({ deviceId: d.deviceId, deviceInfo: { deviceType: d.type, alias: d.alias, modelName: 'X' } })) });
    let m = /\/devices\/(\w+)\/state$/.exec(url);
    if (m) return ok({ response: state[m[1]] });
    m = /\/devices\/(\w+)\/control$/.exec(url);
    if (m) {
      const b = JSON.parse(opt.body);
      if (b.operation) state[m[1]].operation = b.operation;
      if (b.airConJobMode) state[m[1]].airConJobMode = b.airConJobMode;
      if (b.temperature) Object.assign(state[m[1]].temperature, b.temperature);
      return ok({ response: {} });
    }
    return new Response('no', { status: 404 });
  };
  return { fetchFn, calls, devices, state };
}
const item = (loc, start, end, group = '테스트단체') => ({ location: loc, start, end, groupName: group, program: '숲체험', color: '#2a7' });
const ENV = { THINQ_PAT: 'tok', APP_PASSWORD: 'pw', AUTO_MODE: 'live', ASSETS: { fetch: () => new Response('asset') } };
const sleepless = () => {}; // 테스트 속도: 300ms 대기를 줄이려고 setTimeout 을 즉시 실행으로 바꾼다
const realST = globalThis.setTimeout; globalThis.setTimeout = (f) => realST(f, 0);

console.log('자동 판단');
const dev = (power, mode, cur) => ({ id: 'd' + Math.random(), power, mode, cur, target: 24 });
await t('시작 20분 전 + 더움 → 냉방 켜기', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 575, devices: [dev('OFF', 'COOL', 30.5), dev('OFF', 'COOL', 30.5)], cfg: CONFIG });
  assert.equal(r.state, 'soon'); assert.equal(r.actions.length, 2); assert.equal(r.actions[0].mode, 'COOL'); assert.equal(r.actions[0].power, 'ON');
});
await t('시작 40분 전은 아직 안 함', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 560, devices: [dev('OFF', 'COOL', 30)], cfg: CONFIG });
  assert.equal(r.actions.length, 0); assert.equal(r.state, 'gap');
});
await t('추워도 난방은 하지 않는다(중앙제어) — 켜 두면(HEAT_ENABLED) 그때만 난방', () => {
  const base = { roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 610, devices: [dev('OFF', 'COOL', 17)] };
  assert.equal(decideRoom({ ...base, cfg: CONFIG }).actions.length, 0);
  const r = decideRoom({ ...base, cfg: { ...CONFIG, HEAT_ENABLED: true } });
  assert.equal(r.actions[0].mode, 'HEAT'); assert.equal(r.actions[0].temp, CONFIG.HEAT_TARGET);
});
await t('기본 기준: 28° 이상 → 26° 냉방 켜기 / 24° 이하 → 끄기 / 그 사이는 가만히', () => {
  assert.equal(CONFIG.HOT_ON, 28); assert.equal(CONFIG.COOL_TARGET, 26); assert.equal(CONFIG.COOL_OFF, 24);
  const run = (temp, power) => decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 610, devices: [dev(power, 'COOL', temp)], cfg: CONFIG });
  const hot = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 575, devices: [dev('OFF', 'COOL', 28)], cfg: CONFIG }); assert.equal(hot.actions[0].power, 'ON'); assert.equal(hot.actions[0].temp, 26);
  assert.equal(run(27.5, 'OFF').actions.length, 0);
  assert.equal(run(25, 'ON').actions.length, 0);
  assert.equal(run(24, 'ON').actions[0].power, 'OFF');
});
await t('적정 온도면 아무것도 안 함', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 610, devices: [dev('OFF', 'COOL', 24.5)], cfg: CONFIG });
  assert.equal(r.actions.length, 0);
});
await t('냉방 중 목표 도달 → 끄기', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 610, devices: [dev('ON', 'COOL', 23.5)], cfg: CONFIG });
  assert.equal(r.actions[0].power, 'OFF');
});
await t('이미 냉방 중이고 더우면 다시 안 건드림', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 610, devices: [dev('ON', 'COOL', 28)], cfg: CONFIG });
  assert.equal(r.actions.length, 0);
});
await t('모든 일정 종료 10분 뒤 → 켜진 것만 끄기', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 11 * 60 + 10, devices: [dev('ON', 'COOL', 24), dev('OFF', 'COOL', 24)], cfg: CONFIG });
  assert.equal(r.state, 'done'); assert.equal(r.actions.length, 1); assert.equal(r.actions[0].power, 'OFF');
});
await t('종료 5분 뒤는 아직 대기', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 11 * 60 + 5, devices: [dev('ON', 'COOL', 24)], cfg: CONFIG });
  assert.equal(r.actions.length, 0);
});
await t('일정 사이 쉬는 시간엔 끄지 않음', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00'), item('2F 203호', '14:00', '15:00')], allItems: [], nowMin: 12 * 60, devices: [dev('ON', 'COOL', 24)], cfg: CONFIG });
  assert.equal(r.state, 'gap'); assert.equal(r.actions.length, 0);
});
await t('오늘 일정이 없는 방은 손대지 않음', () => {
  const r = decideRoom({ roomItems: [], allItems: [], nowMin: 700, devices: [dev('ON', 'COOL', 24)], cfg: CONFIG });
  assert.equal(r.state, 'none'); assert.equal(r.actions.length, 0);
});

console.log('서버 동작 (모의 일정·ThinQ)');
globalThis.fetch = null;
const withWorld = async (w, fn) => { globalThis.fetch = w.fetchFn; try { return await fn(); } finally { globalThis.fetch = null; } };

await t('상태 응답', async () => {
  const w = makeWorld({ nowMin: 9 * 60, items: [item('스마트치유실 B101호', '10:00', '11:00')] });
  const r = await withWorld(w, async () => (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), ENV)).json());
  assert.equal(r.ok, true);
  const f2 = r.floors.find((f) => f.floor === '2F');
  assert.deepEqual(f2.rooms.map((x) => x.key), ['r201', 'r202', 'r203', 'r204', 'r205']);
  assert.equal(f2.rooms.find((x) => x.key === 'r203').devices.length, 2);
  assert.equal(r.floors.find((f) => f.floor === '1F').rooms.find((x) => x.key === 'hp2').devices.length, 4);
  const all = r.floors.flatMap((f) => f.rooms.flatMap((x) => x.devices));
  assert.ok(!all.some((d) => /데탁|엘베쪽/.test(d.alias)), '후순위 에어컨이 섞임');
  assert.equal(r.others.length, 0);
  assert.ok(w.calls.length <= 50, '호출 수 ' + w.calls.length);
  assert.ok(!w.calls.some((c) => /wash1|데탁/.test(c.url)));
  const b101 = r.floors.find((f) => f.floor === 'B1').rooms.find((x) => x.key === 'b101');
  assert.equal(b101.schedule.next.start, '10:00');
});
await t('비밀번호 틀리면 401, 설정 없으면 503', async () => {
  const w = makeWorld({});
  await withWorld(w, async () => {
    assert.equal((await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'bad' } }), ENV)).status, 401);
    assert.equal((await worker.fetch(new Request('https://x/api/status'), ENV)).status, 401);
    assert.equal((await worker.fetch(new Request('https://x/api/status'), { ...ENV, APP_PASSWORD: '' })).status, 503);
  });
  assert.equal(w.calls.length, 0);
});
await t('자동(live): 203호 20분 전 + 더움 → 두 대 켜고 냉방·26도', async () => {
  const w = makeWorld({ nowMin: 9 * 60 + 35, items: [item('2F 203호(명상실)', '10:00', '11:00')], temps: { r203: 30.5 } });
  await withWorld(w, () => runAuto(ENV, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 35))));
  const ctl = w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url));
  assert.equal(ctl.length, 8); // 2대 × (전원, 모드, 온도, 바람세기)
  assert.deepEqual(ctl.slice(0, 4).map((c) => Object.keys(c.body)[0]), ['operation', 'airConJobMode', 'temperature', 'airFlow']);
  assert.equal(ctl[3].body.airFlow.windStrength, 'AUTO');
  assert.equal(ctl[0].body.operation.airConOperationMode, 'POWER_ON');
  assert.equal(ctl[1].body.airConJobMode.currentJobMode, 'COOL');
  assert.equal(ctl[2].body.temperature.targetTemperature, 26);
  assert.ok(ctl.every((c) => /dev\d+\/control/.test(c.url)));
  // 일정 없는 방(2F 다른 방, 후순위)은 건드리지 않음
  const touched = new Set(ctl.map((c) => c.url.match(/devices\/(\w+)\//)[1]));
  assert.equal(touched.size, 2);
  assert.equal(w.calls.filter((c) => /state$/.test(c.url)).length, 5, '일정 있는 방(203호 2대) + 상시 냉방 방(204호 2대) + 비품실 1대만 상태를 읽어야 함');
  assert.equal(w.calls.filter((c) => /jinan-schedule/.test(c.url)).length, 1, '일정은 한 번만 읽어야 함');
});
await t('자동(dry): 시험 모드는 제어 호출이 없다', async () => {
  const w = makeWorld({ nowMin: 9 * 60 + 35, items: [item('2F 203호(명상실)', '10:00', '11:00')], temps: { r203: 30.5 } });
  await withWorld(w, () => runAuto({ ...ENV, AUTO_MODE: 'dry' }, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 35))));
  assert.equal(w.calls.filter((c) => c.method === 'POST' && /control/.test(c.url)).length, 0);
});
await t('자동: 모든 일정 끝난 방의 켜진 에어컨만 끈다', async () => {
  const w = makeWorld({ nowMin: 11 * 60 + 15, items: [item('2F 204호', '10:00', '11:00')], power: { '204호 스크린측': 'POWER_ON' }, mode: { '204호 스크린측': 'COOL' } });
  await withWorld(w, () => runAuto(ENV, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 2, 15))));
  const ctl = w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url));
  assert.equal(ctl.length, 1); assert.equal(ctl[0].body.operation.airConOperationMode, 'POWER_OFF');
});
await t('자동: 새벽·밤에는 아무것도 안 한다', async () => {
  const w = makeWorld({ nowMin: 3 * 60, items: [item('2F 203호', '04:00', '05:00')], temps: { r203: 31 } });
  const r = await withWorld(w, () => runAuto(ENV, w.fetchFn, new Date(Date.UTC(2026, 9, 26, 18, 0))));
  assert.equal(r.skipped, 'time'); assert.equal(w.calls.length, 0);
});
await t('자동: 일시중지(KV)면 건너뜀', async () => {
  const w = makeWorld({ nowMin: 9 * 60 + 35, items: [item('2F 203호', '10:00', '11:00')], temps: { r203: 31 } });
  const kv = { get: async () => '1' };
  const r = await withWorld(w, () => runAuto({ ...ENV, STATE: kv }, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 35))));
  assert.equal(r.skipped, 'paused'); assert.equal(w.calls.length, 0);
});
await t('프로그램 진행 중에는 켜지 않고(일부러 꺼 둔 에어컨), 켜기는 시작 30분 전부터 10분 안에만 한다', () => {
  const run = (nowMin, extra = {}) => decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin, devices: [dev('OFF', 'COOL', 31)], cfg: { ...CONFIG, ...extra } });
  assert.equal(run(630).actions.length, 0, '진행 중(10:30) 켜지 않음'); assert.match(run(630).reason, /진행 중에는 켜지 않음/);
  assert.equal(run(600).actions.length, 0, '시작 시각(10:00)에도 켜지 않음');
  assert.equal(run(570).actions.length, 1, '시작 30분 전(9:30) 켬');
  assert.equal(run(579).actions.length, 1, '9:39까지 켬');
  assert.equal(run(585).actions.length, 0, '9:45(15분 지남)에는 다시 켜지 않음');
  assert.equal(run(585, { RETRY_ON: true }).actions.length, 1, '미룬 조치 이어서 하기는 허용');
  // 진행 중이라도 추우면 끄기는 한다
  const cold = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 630, devices: [dev('ON', 'COOL', 23)], cfg: CONFIG });
  assert.equal(cold.actions.length, 1); assert.equal(cold.actions[0].power, 'OFF');
});
await t('204호(상시 냉방)도 자기 프로그램이 진행 중일 때는 켜지 않는다', () => {
  const d = (nowMin, items) => decideRoom({ roomItems: items, allItems: [], nowMin, devices: [dev('OFF', 'COOL', 30)], cfg: { ...CONFIG, ALWAYS_COOL: true } });
  assert.equal(d(840, []).actions.length, 1, '프로그램 없으면 켬');
  assert.equal(d(630, [item('2F 204호', '10:00', '11:00')]).actions.length, 0, '자기 프로그램 진행 중에는 안 켬');
  assert.equal(d(660 + 30, [item('2F 204호', '10:00', '11:00')]).actions.length, 1, '프로그램이 끝나면 다시 켬');
});
await t('수동 제어: 바람 세기만 바꾸기(전원·모드·온도는 건드리지 않음)', async () => {
  const w = makeWorld({});
  await withWorld(w, async () => {
    const post = (b) => worker.fetch(new Request('https://x/api/control', { method: 'POST', headers: { 'x-app-password': 'pw' }, body: JSON.stringify(b) }), ENV);
    assert.equal((await post({ deviceIds: ['dev0'], action: 'wind', value: 'TURBO' })).status, 400);
    const ok = await (await post({ deviceIds: ['dev0', 'dev1'], action: 'wind', value: 'LOW' })).json();
    assert.equal(ok.ok, true);
  });
  const cc = w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url));
  assert.equal(cc.length, 2); assert.ok(cc.every((c) => c.body.airFlow && c.body.airFlow.windStrength === 'LOW' && Object.keys(c.body).length === 1));
});
await t('수동 제어: 등록 안 된 기기·범위 밖 온도 거절', async () => {
  const w = makeWorld({});
  await withWorld(w, async () => {
    const post = (b) => worker.fetch(new Request('https://x/api/control', { method: 'POST', headers: { 'x-app-password': 'pw' }, body: JSON.stringify(b) }), ENV);
    assert.equal((await post({ deviceIds: ['dev0'], action: 'temp', value: 40 })).status, 400);
    const r = await (await post({ deviceIds: ['wash1', 'nope'], action: 'off' })).json();
    assert.equal(r.ok, false); assert.ok(r.results.every((x) => !x.ok));
    const ok = await (await post({ deviceIds: ['dev0'], action: 'cool', value: 24 })).json();
    assert.equal(ok.ok, true);
    const def = await (await post({ deviceIds: ['dev1'], action: 'cool' })).json();   // 값을 안 주면 26°·바람 자동
    assert.equal(def.ok, true);
  });
  const cc = w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url));
  assert.equal(cc.length, 8);
  assert.equal(cc[6].body.temperature.targetTemperature, 26); assert.equal(cc[7].body.airFlow.windStrength, 'AUTO');
});
await t('해아림홀은 제어 불가: 상태도 읽지 않고, 제어 요청도 거절, 자동도 건드리지 않는다', async () => {
  const w = makeWorld({ nowMin: 9 * 60, temps: { haearim: 31 }, items: [item('해아림홀', '09:30', '11:00')] });
  const hid = w.devices.find((d) => d.alias.includes('해아림홀')).deviceId;
  await withWorld(w, async () => {
    const r = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), ENV)).json();
    const room = r.floors.find((f) => f.floor === '1F').rooms.find((x) => x.key === 'haearim');
    assert.equal(room.noapi, true); assert.equal(room.devices[0].unsupported, true);
    const res = await (await worker.fetch(new Request('https://x/api/control', { method: 'POST', headers: { 'x-app-password': 'pw' }, body: JSON.stringify({ deviceIds: [hid], action: 'cool', value: 24 }) }), ENV)).json();
    assert.equal(res.ok, false);
    await runAuto(ENV, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + 9 * 60 * 60e3));
  });
  assert.equal(w.calls.filter((c) => c.url.includes(hid)).length, 0);
});
await t('치유장비실 에어컨은 건강증진실 1 로, 탈의실 여/남·비품실은 B1 에 따로 표시', async () => {
  const w = makeWorld({});
  await withWorld(w, async () => {
    const r = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), ENV)).json();
    const f1 = r.floors.find((f) => f.floor === '1F').rooms;
    assert.equal(f1.find((x) => x.key === 'hp1').devices.length, 4);
    assert.ok(!f1.find((x) => x.key === 'equip'));
    const b1 = r.floors.find((f) => f.floor === 'B1').rooms.map((x) => x.key);
    for (const k of ['dressF', 'dressM', 'supply']) assert.ok(b1.includes(k), k);
  });
});

const makeKV = () => { const m = {}; return { m, get: async (k, type) => (k in m ? (type === 'json' ? JSON.parse(m[k]) : m[k]) : null), put: async (k, v) => { m[k] = v; } }; };
const post = (path, b, env) => worker.fetch(new Request('https://x' + path, { method: 'POST', headers: { 'x-app-password': 'pw' }, body: JSON.stringify(b) }), env);
const controls = (w) => w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url));
console.log('방별 설정');
await t('방별 설정 저장 → 상태에 반영, 그 방만 기준이 바뀐다', async () => {
  const KV = makeKV(); const env = { ...ENV, STATE: KV };
  const w = makeWorld({ nowMin: 9 * 60 + 35, temps: { r203: 30.5, r204: 30.5 }, items: [item('203호', '10:00', '11:00'), item('204호', '10:00', '11:00')] });
  await withWorld(w, async () => {
    const bad = await post('/api/settings', { room: 'r203', settings: { hot_on: 22, cool_target: 24 } }, env);
    assert.equal(bad.status, 400);
    const ok = await (await post('/api/settings', { room: 'r203', settings: { hot_on: 32, cool_target: 25, cool_off: 23, pre: 20 } }, env)).json();
    assert.equal(ok.ok, true); assert.equal(ok.settings.hot_on, 32);
    const r = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env)).json();
    const f2 = r.floors.find((f) => f.floor === '2F').rooms;
    const r203 = f2.find((x) => x.key === 'r203'), r204 = f2.find((x) => x.key === 'r204');
    assert.equal(r203.settings.hot_on, 32); assert.equal(r203.customSettings, true);
    assert.equal(r204.settings.hot_on, 28); assert.equal(r204.customSettings, false);
    assert.equal(r.auto.canSave, true);
    assert.equal(r203.auto.actions.length, 0);        // 30.5° < 32° → 제어 안 함
    assert.ok(r204.auto.actions.length > 0);           // 기본 기준(28°)이면 냉방
    await runAuto(env, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 35) - 9 * 3600e3 + 9 * 3600e3));
  });
  const calls = controls(w);
  assert.ok(calls.length > 0);
  const ids203 = w.devices.filter((d) => /203호/.test(d.alias)).map((d) => d.deviceId);
  assert.ok(calls.every((c) => !ids203.some((id) => c.url.includes(id))), '203호는 건드리지 않아야 함');
});
await t('방별 자동 끄기·기본값 복원, KV 없으면 저장 거절', async () => {
  const KV = makeKV(); const env = { ...ENV, STATE: KV };
  const w = makeWorld({ nowMin: 9 * 60 + 35, temps: { r203: 30.5 }, items: [item('203호', '10:00', '11:00')] });
  await withWorld(w, async () => {
    await post('/api/settings', { room: 'r203', settings: { enabled: false } }, env);
    let r = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env)).json();
    let x = r.floors.find((f) => f.floor === '2F').rooms.find((y) => y.key === 'r203');
    assert.equal(x.auto.state, 'off'); assert.equal(x.auto.actions.length, 0);
    await runAuto(env, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 35)));
    await post('/api/settings', { room: 'r203', reset: true }, env);
    r = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env)).json();
    x = r.floors.find((f) => f.floor === '2F').rooms.find((y) => y.key === 'r203');
    assert.equal(x.settings.enabled, true); assert.equal(x.customSettings, false);
    const nokv = await post('/api/settings', { room: 'r203', settings: {} }, ENV);
    assert.equal(nokv.status, 400);
    assert.equal((await post('/api/settings', { room: 'b1lobby', settings: {} }, env)).status, 400);   // 일정 없는 방
  });
  assert.equal(controls(w).length, 0);
});

await t('버전이 상태 응답과 package.json 에 같이 나온다', async () => {
  const { VERSION } = await import('../src/version.js');
  const pk = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const html = (await import('node:fs')).readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(pk.version, VERSION); assert.ok(html.includes(`APP_VERSION = '${VERSION}'`));
  const w = makeWorld({});
  const r = await withWorld(w, async () => (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), ENV)).json());
  assert.equal(r.version, VERSION);
});

await t('비밀번호를 여러 개(쉼표·줄바꿈) 넣으면 각각 통과, 그 외는 거절', async () => {
  const env = { ...ENV, APP_PASSWORD: 'alpha, beta\ngamma-9' };
  const w = makeWorld({});
  await withWorld(w, async () => {
    const st = (pw) => worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': pw } }), env).then((r) => r.status);
    for (const pw of ['alpha', 'beta', 'gamma-9']) assert.equal(await st(pw), 200, pw);
    for (const pw of ['', 'alph', 'alpha,beta', 'delta']) assert.equal(await st(pw), 401, pw);
  });
});

await t('LG 호출을 아끼는 저장값: 두 번째 조회는 LG를 부르지 않고, LG가 막히면 이전 값을 보여준다', async () => {
  const kv = { ...makeKV() }; kv.delete = async (k) => { delete kv.m[k]; };
  const env = { ...ENV, STATE: kv };
  const get = (q = '') => worker.fetch(new Request('https://x/api/status' + q, { headers: { 'x-app-password': 'pw' } }), env).then((r) => r.json());
  const w = makeWorld({ nowMin: 9 * 60, items: [item('스마트치유실 B101호', '10:00', '11:00')] });
  const lgCalls = () => w.calls.filter((c) => !c.url.includes('jinan-schedule')).length;
  await withWorld(w, async () => {
    const a = await get(); assert.equal(a.ok, true);
    const n1 = lgCalls(); assert.ok(n1 > 1);
    const b = await get(); assert.equal(lgCalls(), n1, '저장값이 있으면 LG 호출 없음');
    assert.equal(b.floors.length, a.floors.length);
    const c = await get('?fresh=1'); assert.equal(lgCalls(), n1, '20초 안의 새로고침도 저장값 사용');
    // 저장값을 오래된 것으로 만들고, LG가 한도 오류를 내는 상황
    const cache = JSON.parse(kv.m.snapcache); cache.t -= 5 * 60e3; kv.m.snapcache = JSON.stringify(cache);
    const real = globalThis.fetch;
    globalThis.fetch = async (url, o) => url.includes('jinan-schedule') ? real(url, o) : new Response('{"error":{"message":"Exceeded User API calls","code":"1314"}}', { status: 401 });
    const d = await get(); assert.equal(d.ok, true);
    assert.ok(d.stale && d.stale.ageSec >= 290 && /한도/.test(d.stale.reason), '오래된 값 + 이유 표시');
    globalThis.fetch = real;
    // 저장값 없이 한도 오류면 에어컨 없이 이유만 알려준다
    delete kv.m.snapcache;
    globalThis.fetch = async (url, o) => url.includes('jinan-schedule') ? real(url, o) : new Response('{"error":{"message":"Exceeded User API calls","code":"1314"}}', { status: 401 });
    const e = await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env);
    const ej = await e.json(); assert.equal(e.status, 200); assert.equal(ej.stale.ageSec, null); assert.match(ej.stale.reason, /한도/);   // 로그인은 막지 않고 이유만 알린다
    globalThis.fetch = real;
  });
});

await t('자동 점검은 필요한 때만 LG를 부른다(시작 60분 전부터 30분마다 + 중요한 순간)', async () => {
  const items = [item('스마트치유실 B101호', '10:00', '11:00')];
  const run = async (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number); const nowMin = h * 60 + m;
    const w = makeWorld({ nowMin, items });
    const now = new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + nowMin * 60e3);
    const r = await withWorld(w, () => tickAuto({ ...ENV, AUTO_MODE: 'dry' }, w.fetchFn, now));
    return { r, lg: w.calls.filter((c) => !c.url.includes('jinan-schedule')).length };
  };
  for (const hm of ['05:30', '08:10', '08:55', '09:10', '09:20', '10:10', '10:20', '11:20', '11:40', '12:10', '13:10']) {
    const x = await run(hm); assert.equal(x.lg, 0, hm + ' 에는 LG 호출 없어야 함'); assert.ok(x.r.skipped, hm);
  }
  for (const hm of ['09:00', '09:30', '10:00', '10:30', '11:10']) {
    const x = await run(hm); assert.ok(x.lg > 0, hm + ' 에는 LG 호출'); assert.ok(!x.r.skipped, hm);
  }
});

await t('비품실 켜짐 확인은 매시 정각에 비품실만 읽고, 꺼져 있으면 켠다', async () => {
  const w = makeWorld({ nowMin: 8 * 60, items: [item('스마트치유실 B101호', '10:00', '11:00')], power: { '산림치유센터 비품실': 'POWER_OFF' } });
  const now = new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + 8 * 60 * 60e3);
  const r = await withWorld(w, () => tickAuto({ ...ENV, AUTO_MODE: 'live' }, w.fetchFn, now));
  const states = w.calls.filter((c) => /\/state$/.test(c.url)); assert.equal(states.length, 4, '비품실 + 상시 냉방 방(204호) + 일정 있는 방만 읽음');
  const ctl = w.calls.filter((c) => /\/control$/.test(c.url)); assert.equal(ctl.length, 1);
  assert.equal(ctl[0].body.operation.airConOperationMode, 'POWER_ON'); assert.ok(r.log.length === 1);
});

await t('10시 체험·실감실 켜기 / 20시 끄기', async () => {
  const mk = async (hm, power) => {
    const [h, m] = hm.split(':').map(Number); const w = makeWorld({ nowMin: h * 60 + m, items: [], power });
    const now = new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + (h * 60 + m) * 60e3);
    const r = await withWorld(w, () => tickAuto({ ...ENV, AUTO_MODE: 'live' }, w.fetchFn, now));
    return { w, r };
  };
  const on = await mk('10:00', { '실감실': 'POWER_OFF', '산림치유센터 비품실': 'POWER_ON' });
  assert.ok(on.r.log.some((l) => l.room === 'media' && /켜기/.test(l.do)), '10:00 켜짐');
  const off = await mk('20:00', { '실감실': 'POWER_ON', '산림치유센터 비품실': 'POWER_ON' });
  assert.ok(off.r.log.some((l) => l.room === 'media' && /끄기/.test(l.do)), '20:00 꺼짐');
  assert.ok(!off.r.log.some((l) => l.room === 'supply'), '비품실은 건드리지 않음');
});

await t('21시: 비품실과 남은 일정이 있는 방을 빼고 전부 끈다(요청당 12대 제한, 비품실은 절대 끄지 않음)', async () => {
  const power = {}; for (const a of Object.keys(ALIASES)) power[a] = 'POWER_ON';
  const items = [item('스마트치유실 B101호', '21:30', '22:30')];
  const w = makeWorld({ nowMin: 21 * 60, items, power });
  const now = new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + 21 * 60 * 60e3);
  const r = await withWorld(w, () => tickAuto({ ...ENV, AUTO_MODE: 'live' }, w.fetchFn, now));
  const offIds = w.calls.filter((c) => /\/control$/.test(c.url) && c.body.operation && c.body.operation.airConOperationMode === 'POWER_OFF').map((c) => c.url);
  const aliasOf = (u) => { const id = /devices\/(\w+)\//.exec(u)[1]; return w.devices.find((d) => d.deviceId === id).alias; };
  const others = offIds.filter((u) => !/B101/.test(aliasOf(u)));   // B101 은 일정 기반 판단(충분히 시원함)으로 꺼질 수 있다
  assert.equal(others.length, 12, '한 번에 12대까지');
  for (const u of offIds) assert.ok(!/비품실/.test(aliasOf(u)), '비품실은 끄면 안 됨');
  assert.ok(!r.log.some((l) => l.room === 'supply'));
});

await t('09시: 오늘 일정이 있는 방이 너무 추우면 «난방 확인 필요» 알림을 저장하고, 상태 응답에 담고, 확인하면 사라진다', async () => {
  const kv = { m: {}, async get(k) { return this.m[k] ?? null; }, async put(k, v) { this.m[k] = v; } };
  const env = { ...ENV, STATE: kv };
  const w = makeWorld({ nowMin: 9 * 60, items: [item('스마트치유실 B101호', '10:30', '11:30')], temps: { b101: 16 } });
  const now = new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + 9 * 60 * 60e3);
  const r = await withWorld(w, () => tickAuto(env, w.fetchFn, now));
  assert.equal(r.alerts.length, 1); assert.equal(r.alerts[0].room, 'b101');
  const call = (path, body) => worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: { 'x-app-password': 'pw' }, body: body ? JSON.stringify(body) : undefined }), env);
  const real = globalThis.fetch; globalThis.fetch = w.fetchFn;
  try {
    const j = await (await call('/api/status')).json();
    assert.equal(j.alerts.length, 1); assert.match(j.alerts[0].msg, /난방 확인 필요/); assert.match(j.alerts[0].msg, /10:30 프로그램 있음/);
    await call('/api/alerts/ack', { all: true });
    const j2 = await (await call('/api/status')).json(); assert.equal(j2.alerts.length, 0);
  } finally { globalThis.fetch = real; }
  // 따뜻하면 알림 없음
  const w2 = makeWorld({ nowMin: 9 * 60, items: [item('스마트치유실 B101호', '10:30', '11:30')], temps: { b101: 22 } });
  const r2 = await withWorld(w2, () => tickAuto({ ...ENV, STATE: { m: {}, async get() { return null; }, async put() {} } }, w2.fetchFn, now));
  assert.equal(r2.alerts.length, 0);
});

const mkKV = () => ({ m: {}, async get(k) { return this.m[k] ?? null; }, async put(k, v) { this.m[k] = v; } });
const at = (hm) => { const [h, m] = hm.split(':').map(Number); return { nowMin: h * 60 + m, now: new Date(Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + (h * 60 + m) * 60e3) }; };

await t('204호는 프로그램이 없어도 28° 이상이면 냉방(26°·바람 자동), 24° 이하면 끈다 — 다른 방은 그대로', async () => {
  const k = at('14:00');
  const hot = makeWorld({ nowMin: k.nowMin, items: [], temps: { r204: 29, r203: 30 } });
  const kv = mkKV();
  const r = await withWorld(hot, () => tickAuto({ ...ENV, STATE: kv }, hot.fetchFn, k.now));
  const ctl = hot.calls.filter((c) => /control$/.test(c.url));
  assert.equal(ctl.filter((c) => c.body.operation && c.body.operation.airConOperationMode === 'POWER_ON').length, 2, '204호 2대 켜짐');
  assert.ok(ctl.some((c) => c.body.temperature && c.body.temperature.targetTemperature === 26));
  assert.equal(ctl.filter((c) => c.body.airFlow && c.body.airFlow.windStrength === 'AUTO').length, 2);
  assert.ok(r.log.every((l) => l.room === 'r204'), '203호 등은 일정이 없으니 그대로');
  const cold = makeWorld({ nowMin: k.nowMin, items: [], temps: { r204: 23 }, power: { '204호 스크린측': 'POWER_ON', '204호 입구측': 'POWER_ON' } });
  const r2 = await withWorld(cold, () => tickAuto({ ...ENV, STATE: mkKV() }, cold.fetchFn, k.now));
  assert.equal(r2.log.length, 2); assert.ok(r2.log.every((l) => /끄기/.test(l.do)));
  const mid = makeWorld({ nowMin: k.nowMin, items: [], temps: { r204: 26 }, power: { '204호 스크린측': 'POWER_ON' } });
  const r3 = await withWorld(mid, () => tickAuto({ ...ENV, STATE: mkKV() }, mid.fetchFn, k.now));
  assert.equal(r3.log.length, 0, '24~28 사이는 그대로');
});

await t('204호 점검은 30분 간격(정각·30분)에만 LG를 부른다', async () => {
  for (const [hm, expectCalls] of [['14:10', false], ['14:30', true], ['15:00', true], ['15:20', false]]) {
    const k = at(hm); const w = makeWorld({ nowMin: k.nowMin, items: [] });
    await withWorld(w, () => tickAuto({ ...ENV, STATE: mkKV() }, w.fetchFn, k.now));
    assert.equal(w.calls.some((c) => /state$/.test(c.url)), expectCalls, hm);
  }
});

await t('자동·수동 제어와 오류가 로그에 남고, /api/logs 로 종류별로 볼 수 있다', async () => {
  const kv = mkKV(); const env = { ...ENV, STATE: kv };
  const k = at('14:00');
  const w = makeWorld({ nowMin: k.nowMin, items: [], temps: { r204: 29 } });
  // 한 대는 제어가 실패하도록
  const real = w.fetchFn; let failed = false;
  w.fetchFn = async function (url, o) { if (!failed && /control$/.test(url) && JSON.parse(o.body).temperature) { failed = true; return new Response('{"error":"x"}', { status: 500 }); } return real.call(undefined, url, o); };
  await withWorld(w, () => tickAuto(env, w.fetchFn, k.now));
  const call = async (path, body) => (await worker.fetch(new Request('https://x' + path, { method: body ? 'POST' : 'GET', headers: { 'x-app-password': 'pw' }, body: body ? JSON.stringify(body) : undefined }), env)).json();
  globalThis.fetch = w.fetchFn;
  try {
    await call('/api/control', { deviceIds: ['dev0'], action: 'off' });
    const auto = await call('/api/logs?kind=auto'), man = await call('/api/logs?kind=manual'), err = await call('/api/logs?kind=error');
    assert.ok(auto.logs.length >= 2 && auto.logs.every((x) => x.kind === 'auto'));
    assert.ok(auto.logs.some((x) => /냉방 켜기/.test(x.what) && x.res === 'ok'));
    assert.equal(man.logs.length, 1); assert.equal(man.logs[0].what, '끄기');
    assert.equal(err.logs.length, 1); assert.equal(err.logs[0].res, 'fail'); assert.match(err.logs[0].t, /^2026-10-27 14:00$/);
  } finally { globalThis.fetch = null; }
});

await t('한 번에 LG 호출이 너무 많아지면 일부를 다음 점검으로 미룬다', async () => {
  const kv = mkKV(); const env = { ...ENV, STATE: kv };
  const k = at('09:35');
  const items = ['B101호', '2F 201호', '2F 202호', '2F 203호', '2F 205호', '건강측정실', '치유장비실', '건강증진실2'].map((l) => item(l, '10:00', '11:00'));
  const w = makeWorld({ nowMin: k.nowMin, items, temps: { b101: 30, r201: 30, r202: 30, r203: 30, r205: 30, b102: 30, hp1: 30, hp2: 30 } });
  const r = await withWorld(w, () => runAuto(env, w.fetchFn, k.now));
  assert.ok(r.deferred > 0, '미룬 조치가 있어야 함');
  assert.ok(w.calls.length <= 50, '요청 50회 이내: ' + w.calls.length);
  assert.equal(kv.m.retry, '1');
});

await t('에어컨 기능표(/api/profile)가 지원 항목을 풀어서 보여 준다', async () => {
  const w = makeWorld({});
  const real = w.fetchFn;
  w.fetchFn = async function (url, o) { if (/\/profile$/.test(url)) return new Response(JSON.stringify({ response: { property: { airFlow: { windStrength: { type: 'enum', mode: ['r', 'w'], value: { w: ['LOW', 'MID', 'HIGH'] } } } } } }), { status: 200 }); return real.call(undefined, url, o); };
  const j = await withWorld(w, async () => (await worker.fetch(new Request('https://x/api/profile', { headers: { 'x-app-password': 'pw' } }), ENV)).json());
  assert.equal(j.ok, true); assert.equal(j.items[0].path, 'airFlow.windStrength'); assert.match(j.items[0].value, /MID/);
});

await t('LG가 막혀도 로그인(ping)은 되고, 저장값이 없으면 에어컨 없이 방 구성만 보여준다', async () => {
  const w = makeWorld({ nowMin: 9 * 60, items: [item('스마트치유실 B101호', '10:00', '11:00')] });
  const real = w.fetchFn;
  const blocked = async (url, o) => url.includes('jinan-schedule') ? real(url, o) : new Response('{"error":{"message":"Exceeded User API calls","code":"1314"}}', { status: 401 });
  const call = (path, pw = 'pw') => worker.fetch(new Request('https://x' + path, { headers: { 'x-app-password': pw } }), ENV);
  globalThis.fetch = blocked;
  try {
    assert.equal((await call('/api/ping')).status, 200);
    assert.equal((await call('/api/ping', 'bad')).status, 401);
    const r = await (await call('/api/status')).json();
    assert.equal(r.ok, true); assert.equal(r.stale.ageSec, null); assert.match(r.stale.reason, /한도/);
    assert.equal(r.floors.length, 3); assert.ok(r.floors.every((f) => f.rooms.length > 0));
    assert.ok(r.floors.flatMap((f) => f.rooms).every((x) => x.devices.length === 0));
  } finally { globalThis.fetch = null; }
});

await t('방별 새로고침: 지정한 에어컨 상태만 읽고(목록 재조회 없음), 모르는 기기는 거절·읽지 않는다', async () => {
  const kv = { ...makeKV() }; kv.delete = async (k) => { delete kv.m[k]; };
  const env = { ...ENV, STATE: kv };
  const w = makeWorld({ nowMin: 9 * 60, items: [item('스마트치유실 B101호', '10:00', '11:00')] });
  const post = (path, body) => worker.fetch(new Request('https://x' + path, { method: 'POST', headers: { 'x-app-password': 'pw' }, body: JSON.stringify(body) }), env).then((r) => r.json());
  const lg = () => w.calls.filter((c) => !c.url.includes('jinan-schedule'));
  await withWorld(w, async () => {
    const st = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env)).json();
    const ids = st.floors.flatMap((f) => f.rooms).flatMap((r) => r.devices).filter((d) => !d.unsupported).map((d) => d.id);
    assert.ok(ids.length >= 3 && kv.m.devlist, '기기 목록이 저장됨');
    const before = lg().length;
    const r = await post('/api/refresh', { deviceIds: [ids[0], ids[1], 'zzz-없는-기기'] });
    assert.equal(r.ok, true); assert.equal(r.devices.length, 3);
    assert.equal(r.devices[0].ok, true); assert.equal(r.devices[2].ok, false);
    const calls = lg().slice(before);
    assert.equal(calls.length, 2, '상태 읽기 2번만: ' + calls.map((c) => c.url).join(' | '));
    assert.ok(calls.every((c) => /\/state$/.test(c.url)), '목록 조회 없음');
    const bad = await post('/api/refresh', { deviceIds: [] }); assert.equal(bad.ok, false);
    // 두 번째 상태 조회: 목록은 저장값, 상태도 저장값 → LG 호출 0
    const n = lg().length;
    await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env)).json();
    assert.equal(lg().length, n);
  });
});

await t('난방 수동 제어는 막혀 있고(HEAT_ENABLED 전에는), 설정은 끄는 온도가 설정 온도보다 높으면 거절', async () => {
  const post2 = (path, body, env) => worker.fetch(new Request('https://x' + path, { method: 'POST', headers: { 'x-app-password': 'pw' }, body: JSON.stringify(body) }), env);
  const w = makeWorld({ nowMin: 9 * 60, items: [] });
  await withWorld(w, async () => {
    const id = w.devices[0].deviceId;
    const r = await post2('/api/control', { deviceIds: [id], action: 'heat' }, ENV); assert.equal(r.status, 400); assert.match((await r.json()).error, /중앙제어/);
    const kv = makeKV(); kv.delete = async () => {};
    const bad = await post2('/api/settings', { room: 'r203', settings: { cool_off: 27, cool_target: 26 } }, { ...ENV, STATE: kv }); assert.equal(bad.status, 400);
    const st = await (await worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), ENV)).json();
    assert.equal(st.auto.heat, false); assert.equal(st.auto.defaults.cool_off, 24); assert.ok(!('cold_on' in st.auto.defaults));
  });
});

await t('비밀값이 빠지면 어느 것이 없는지 알려준다', async () => {
  const call = (env) => worker.fetch(new Request('https://x/api/status', { headers: { 'x-app-password': 'pw' } }), env).then(async (r) => ({ s: r.status, j: await r.json() }));
  let r = await call({ ASSETS: ENV.ASSETS });
  assert.equal(r.s, 503); assert.match(r.j.error, /APP_PASSWORD, THINQ_PAT/);
  r = await call({ ASSETS: ENV.ASSETS, APP_PASSWORD: 'pw' });
  const miss = r.j.error.split('없는 비밀값:')[1].split(' / ')[0];
  assert.match(miss, /THINQ_PAT/); assert.ok(!/APP_PASSWORD/.test(miss));
  assert.match(r.j.error, /서버가 받은 항목 이름: "APP_PASSWORD"/);
  assert.ok(!/ASSETS|pw'/.test(r.j.error.split('서버가 받은 항목 이름:')[1]));   // 값·내부 항목은 노출 안 함
});

console.log(process.exitCode ? '\n실패 있음' : `\n전부 통과 (${pass}개)`);
