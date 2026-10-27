import assert from 'node:assert/strict';
import worker, { runAuto, snapshot } from '../src/index.js';
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
      operation: { airConOperationMode: power[a] || 'POWER_OFF' },
      airConJobMode: { currentJobMode: mode[a] || 'COOL' },
      temperature: { currentTemperature: temps[ALIASES[a]] ?? 24, targetTemperature: 24, unit: 'C' },
    };
  }
  const nowMs = Date.UTC(2026, 9, 27, 0, 0) - 9 * 3600e3 + nowMin * 60e3;
  const fetchFn = async (url, opt = {}) => {
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
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 580, devices: [dev('OFF', 'COOL', 30.5), dev('OFF', 'COOL', 30.5)], cfg: CONFIG });
  assert.equal(r.state, 'soon'); assert.equal(r.actions.length, 2); assert.equal(r.actions[0].mode, 'COOL'); assert.equal(r.actions[0].power, 'ON');
});
await t('시작 40분 전은 아직 안 함', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 560, devices: [dev('OFF', 'COOL', 30)], cfg: CONFIG });
  assert.equal(r.actions.length, 0); assert.equal(r.state, 'gap');
});
await t('진행 중 + 추움 → 난방', () => {
  const r = decideRoom({ roomItems: [item('2F 203호', '10:00', '11:00')], allItems: [], nowMin: 610, devices: [dev('OFF', 'COOL', 17)], cfg: CONFIG });
  assert.equal(r.actions[0].mode, 'HEAT'); assert.equal(r.actions[0].temp, CONFIG.HEAT_TARGET);
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
await t('자동(live): 203호 20분 전 + 더움 → 두 대 켜고 냉방·24도', async () => {
  const w = makeWorld({ nowMin: 9 * 60 + 40, items: [item('2F 203호(명상실)', '10:00', '11:00')], temps: { r203: 30.5 } });
  await withWorld(w, () => runAuto(ENV, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 40))));
  const ctl = w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url));
  assert.equal(ctl.length, 6); // 2대 × (전원, 모드, 온도)
  assert.deepEqual(ctl.slice(0, 3).map((c) => Object.keys(c.body)[0]), ['operation', 'airConJobMode', 'temperature']);
  assert.equal(ctl[0].body.operation.airConOperationMode, 'POWER_ON');
  assert.equal(ctl[1].body.airConJobMode.currentJobMode, 'COOL');
  assert.equal(ctl[2].body.temperature.targetTemperature, 24);
  assert.ok(ctl.every((c) => /dev\d+\/control/.test(c.url)));
  // 일정 없는 방(2F 다른 방, 후순위)은 건드리지 않음
  const touched = new Set(ctl.map((c) => c.url.match(/devices\/(\w+)\//)[1]));
  assert.equal(touched.size, 2);
  assert.equal(w.calls.filter((c) => /state$/.test(c.url)).length, 2, '일정 있는 방(203호 2대)만 상태를 읽어야 함');
  assert.equal(w.calls.filter((c) => /jinan-schedule/.test(c.url)).length, 1, '일정은 한 번만 읽어야 함');
});
await t('자동(dry): 시험 모드는 제어 호출이 없다', async () => {
  const w = makeWorld({ nowMin: 9 * 60 + 40, items: [item('2F 203호(명상실)', '10:00', '11:00')], temps: { r203: 30.5 } });
  await withWorld(w, () => runAuto({ ...ENV, AUTO_MODE: 'dry' }, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 40))));
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
  const w = makeWorld({ nowMin: 9 * 60 + 40, items: [item('2F 203호', '10:00', '11:00')], temps: { r203: 31 } });
  const kv = { get: async () => '1' };
  const r = await withWorld(w, () => runAuto({ ...ENV, STATE: kv }, w.fetchFn, new Date(Date.UTC(2026, 9, 27, 0, 40))));
  assert.equal(r.skipped, 'paused'); assert.equal(w.calls.length, 0);
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
  });
  assert.equal(w.calls.filter((c) => c.method === 'POST' && /control$/.test(c.url)).length, 3);
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

console.log(process.exitCode ? '\n실패 있음' : `\n전부 통과 (${pass}개)`);
