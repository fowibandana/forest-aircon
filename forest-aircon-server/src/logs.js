// 자동·수동 제어 기록과 오류 기록(KV 'logs'). 최신이 맨 앞. 한 건이 200바이트쯤이라 3000건이어도 0.6MB 안팎이다.
const KEY = 'logs', MAX = 3000, KEEP_DAYS = 90;
export const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const ms = (t) => Date.parse(String(t).replace(' ', 'T') + ':00+09:00');

export async function loadLogs(env) {
  if (!env.STATE) return [];
  try { const a = JSON.parse(await env.STATE.get(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

// entries: 시간 순서대로 [{kind:'auto'|'manual'|'sys', room, dev, what, res:'ok'|'fail'|'skip', note}]
export async function addLogs(env, entries, now = new Date()) {
  if (!env.STATE || !entries.length) return;
  try {
    const cur = await loadLogs(env), t = kst(now);
    const add = [];
    for (const e of entries) {
      const row = { t, kind: e.kind, room: e.room || '', dev: e.dev || '', what: String(e.what || ''), res: e.res || 'ok', note: String(e.note || '').slice(0, 240) };
      // 같은 시스템 오류가 계속 나면(예: LG 한도) 30분에 한 번만 남긴다
      if (row.kind === 'sys' && cur.concat(add).some((x) => x.kind === 'sys' && x.what === row.what && now.getTime() - ms(x.t) < 30 * 60e3)) continue;
      add.push(row);
    }
    if (!add.length) return;
    const cutoff = now.getTime() - KEEP_DAYS * 86400e3;
    const next = [...add.reverse(), ...cur].filter((x) => ms(x.t) >= cutoff).slice(0, MAX);
    await env.STATE.put(KEY, JSON.stringify(next));
  } catch (e) { console.log('[log] 기록 실패', e.message); }
}

export const pickLogs = (all, kind) => kind === 'error' ? all.filter((x) => x.res === 'fail') : all.filter((x) => x.kind === kind);
