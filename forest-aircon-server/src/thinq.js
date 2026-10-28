import { CONFIG } from './config.js';

const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3'; // LG ThinQ Connect 공용 키(스펙에 고정값으로 공개)

function messageId() {
  const hex = crypto.randomUUID().replace(/-/g, '');
  let bin = '';
  for (let i = 0; i < 32; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class ThinqError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export class Thinq {
  constructor(pat, { fetchFn = (...a) => fetch(...a), base = CONFIG.THINQ_BASE, clientId = 'forest-aircon-server' } = {}) {
    this.pat = String(pat || '').trim();
    this.fetchFn = fetchFn;   // 메서드로 호출하면 Workers 가 "Illegal invocation" 을 내므로 아래에서 변수로 꺼내 호출
    this.base = base;
    this.clientId = clientId;
  }

  async req(method, path, body, control) {
    const headers = {
      Authorization: 'Bearer ' + this.pat,
      'x-message-id': messageId(),
      'x-country': 'KR',
      'x-client-id': this.clientId,
      'x-api-key': API_KEY,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (control) headers['x-conditional-control'] = 'true';
    let r;
    try {
      const doFetch = this.fetchFn;
      r = await doFetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new ThinqError('네트워크 오류: ' + e.message, -1);
    }
    const text = await r.text();
    if (/"code"\s*:\s*"?1314"?/.test(text)) throw new ThinqError('LG 서버의 호출 횟수 한도에 걸렸습니다. 잠시(몇 분) 뒤에 다시 시도해 주세요', 1314);
    if (r.status >= 400) throw new ThinqError('HTTP ' + r.status + ' ' + text.replace(/\s+/g, ' ').slice(0, 200), r.status);
    try { return text ? JSON.parse(text) : {}; } catch { throw new ThinqError('응답 해석 실패: ' + text.slice(0, 100), -2); }
  }

  async listDevices() {
    const j = await this.req('GET', '/devices');
    const arr = Array.isArray(j.response) ? j.response : (j.response && j.response.devices) || [];
    return arr.map((d) => ({
      id: d.deviceId,
      alias: (d.deviceInfo && d.deviceInfo.alias) || d.deviceId,
      type: (d.deviceInfo && d.deviceInfo.deviceType) || '',
      model: (d.deviceInfo && d.deviceInfo.modelName) || '',
    }));
  }

  async getState(id) {
    const j = await this.req('GET', '/devices/' + id + '/state');
    let r = j.response;
    if (Array.isArray(r)) r = r[0];
    return parseState(r || j);
  }

  control(id, body) { return this.req('POST', '/devices/' + id + '/control', body, true); }
  setPower(id, on) { return this.control(id, { operation: { airConOperationMode: on ? 'POWER_ON' : 'POWER_OFF' } }); }
  setMode(id, mode) { return this.control(id, { airConJobMode: { currentJobMode: mode } }); }

  // 목표 온도 — targetTemperature 가 거절되면(4xx) 모드별 항목으로 재시도
  async setTemp(id, temp, mode) {
    try {
      return await this.control(id, { temperature: { targetTemperature: temp, unit: 'C' } });
    } catch (e) {
      if (!(e.status >= 400 && e.status < 500)) throw e;
      const key = mode === 'HEAT' ? 'heatTargetTemperature' : 'coolTargetTemperature';
      return await this.control(id, { temperature: { [key]: temp, unit: 'C' } });
    }
  }
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ThinQ 상태 → 화면/규칙에서 쓰는 단순한 모양
export function parseState(st) {
  const op = st.operation && st.operation.airConOperationMode;
  const mode = (st.airConJobMode && st.airConJobMode.currentJobMode) || null;
  const t = st.temperature || {};
  let target = num(t.targetTemperature);
  if (target === null) target = num(mode === 'HEAT' ? t.heatTargetTemperature : t.coolTargetTemperature);
  return {
    power: op === 'POWER_ON' ? 'ON' : op === 'POWER_OFF' ? 'OFF' : null,
    mode,
    cur: num(t.currentTemperature),
    target,
  };
}
