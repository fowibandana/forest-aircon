// ── 장소(방) 정의 ─────────────────────────────────────────────────────────
// 대표님이 ThinQ 앱에서 나눈 «방 설정» 그대로입니다. (일정 화면의 방 번호와 같은 키를 씁니다)
// sched=true 인 방만 일정에 따라 자동 제어합니다. 나머지(로비·비품실·탈의실·치유장비실)는 화면에서 보고 수동 조작만 합니다.
export const PLACES = {
  // 지하 1층
  b1lobby: { name: 'B1 로비',                 short: 'B1 로비',     floor: 'B1', sched: false },
  b101:    { name: 'B101호 (사무실)',          short: 'B101호',      floor: 'B1', sched: true },
  b102:    { name: 'B102호 (건강측정실)',      short: 'B102호',      floor: 'B1', sched: true },
  media:   { name: '실감미디어실',             short: '실감미디어실', floor: 'B1', sched: true },
  dressF:  { name: '탈의실 (여)',              short: '탈의 여',     floor: 'B1', sched: false },
  dressM:  { name: '탈의실 (남)',              short: '탈의 남',     floor: 'B1', sched: false },
  supply:  { name: '비품실',                  short: '비품실',      floor: 'B1', sched: false },
  // 1층
  lobby1:  { name: '1F 로비',                 short: '1F 로비',     floor: '1F', sched: false },
  hp1:     { name: '건강증진실 1 (치유장비실)', short: '건강증진실 1', floor: '1F', sched: true,
             sensors: ['치유장비실1', '치유장비실4'],   // 방 온도는 양끝(1번·4번) 에어컨의 값으로
             groups: [{ label: '1·2번', names: ['치유장비실1', '치유장비실2'] }, { label: '3·4번', names: ['치유장비실3', '치유장비실4'] }] },   // 켤 때는 한 묶음씩 번갈아   // ThinQ 앱에서는 «치유장비실»로 등록된 에어컨 4대
  hp2:     { name: '건강증진실 2',             short: '건강증진실 2', floor: '1F', sched: true,
             sensors: ['건강증진실21', '건강증진실24'],
             groups: [{ label: '1·2번', names: ['건강증진실21', '건강증진실22'] }, { label: '3·4번', names: ['건강증진실23', '건강증진실24'] }] },
  // noapi: LG 서버가 이 에어컨의 상태 읽기·제어를 지원하지 않는다(ThinQ 앱에서만 조작). 일정은 보여주되 제어하지 않는다.
  haearim: { name: '해아림홀',                short: '해아림홀',     floor: '1F', sched: true, noapi: true },
  // 백운홀: 한 개의 넓은 방. 난방도 되지만 모두 묶여 있어 가끔 냉방이 난방으로 바뀜 → 바뀌면 오류·알림. 일정 연동 없음(수동).
  // dummies: ThinQ 에 없는 자리(도면에 «없음»으로만 표시)
  baekun:  { name: '백운홀',                  short: '백운홀',       floor: '백운홀', sched: false, heat: true, dummies: ['강사옆측'],
             sensors: ['강사측', '입구측'],   // 방 온도: 강사측 쪽 + 입구 쪽 두 곳
             groups: [{ label: '강사측 열', names: ['강사측', '강사옆측'] }, { label: '2열', names: ['강사측2열', '강사옆측2열'] }, { label: '입구측 열', names: ['입구옆측', '입구측'] }] },
  // 2층
  r201:    { name: '201호 (음파실)',           short: '201호',       floor: '2F', sched: true },
  r202:    { name: '202호 (입식다도실)',       short: '202호',       floor: '2F', sched: true },
  r203:    { name: '203호 (명상실)',           short: '203호',       floor: '2F', sched: true },
  r204:    { name: '204호 (명상실)',           short: '204호',       floor: '2F', sched: true },
  r205:    { name: '205호 (좌식다도실)',       short: '205호',       floor: '2F', sched: true },
};
export const FLOOR_ORDER = ['B1', '1F', '2F', '백운홀'];
export const ROOMS = PLACES; // 이전 이름 호환

// 에어컨 이름 → 장소. «에어컨(...)» 괄호 안 글자에서 공백을 뺀 것이 열쇠입니다.
// ThinQ API 는 기기가 어느 «방»에 있는지 알려주지 않아서, ThinQ 앱의 방 설정을 옮겨 적은 표입니다.
// 새 에어컨을 등록하면 여기에 한 줄 추가하세요. ('later' = 후순위 구역 — 화면에 안 나오고 제어도 안 함)
const LATER = 'later';
export const ALIAS_PLACE = {
  // 지하 1층
  '내측': 'b1lobby', '신발장측': 'b1lobby',
  'B101호': 'b101',
  '건강측정실혈압계측': 'b102', '건강측정실입구측': 'b102',
  '실감실': 'media', '체험실입구측': 'media', '체험실내측': 'media',
  '산림치유센터비품실': 'supply',
  '산림치유센터탈의실여': 'dressF', '산림치유센터탈의실남': 'dressM',
  // 1층
  '산림치유센터1F로비': 'lobby1',
  '치유장비실1': 'hp1', '치유장비실2': 'hp1', '치유장비실3': 'hp1', '치유장비실4': 'hp1',   // 치유장비실 = 건강증진실 1
  '건강증진실21': 'hp2', '건강증진실22': 'hp2', '건강증진실23': 'hp2', '건강증진실24': 'hp2',
  '해아림홀뒤': 'haearim',
  // 백운홀(ThinQ 앱의 «백운홀» 방)
  '입구측': 'baekun', '입구옆측': 'baekun', '강사측': 'baekun', '강사측2열': 'baekun', '강사옆측2열': 'baekun',
  // 2층
  '음파실내측': 'r201', '음파실창측': 'r201',
  '입식다도실스크린측': 'r202', '입식다도실강사측': 'r202',
  '203호스크린측': 'r203', '203호입구측': 'r203',
  '204호스크린측': 'r204', '204호입구측': 'r204',
  '좌식다도실탕비실측': 'r205', '좌식다도실강사측': 'r205',
  // 후순위(사무실·업무지원센터 등)
  '엘베쪽': LATER, '중앙': LATER, '안쪽': LATER,
  '안전팀': LATER, '데탁': LATER, '고객지원팀': LATER, '탕비실': LATER, '원장실': LATER,
  '2층로비': LATER, '1층로비': LATER, '시니어안전지기휴게실': LATER, '보건실': LATER,
  '데크측1': LATER, '데크측2': LATER, '데크측3': LATER, '데크측4': LATER,
  '도로측1': LATER, '도로측2': LATER, '도로측3': LATER, '도로측4': LATER,
};

export function aliasCore(alias) {
  const s = String(alias || '');
  const m = /\(([^()]*)\)\s*$/.exec(s);
  return (m ? m[1] : s).replace(/\s+/g, '');
}

// 에어컨 별칭 → 장소 키 | 'later' | null(모르는 기기)
export function placeOfDevice(alias) {
  const hit = ALIAS_PLACE[aliasCore(alias)];
  if (hit) return hit;
  const k = roomOf(alias);   // 표에 없어도 이름에 방 번호가 있으면 찾는다
  return k && PLACES[k] ? k : null;
}

// 일정의 «장소»(또는 에어컨 이름) 글자 → 일정 방 키. 못 맞추면 null.
export function roomOf(loc) {
  const s = String(loc || '').replace(/\s+/g, '');
  if (!s) return null;
  let m = /건강증진실([12])/.exec(s);
  if (m) return 'hp' + m[1];
  if (/해아림/.test(s)) return 'haearim';
  if (/실감/.test(s)) return 'media';
  m = /(?:^|[^\d])B?(10[12])(?:호|[^\d]|$)/i.exec(s);
  if (m && (/B10[12]/i.test(s) || /스마트/.test(s))) return 'b' + m[1];
  m = /(?:^|[^\d])(20[1-5])(?:호|[^\d]|$)/.exec(s);
  if (m) return 'r' + m[1];
  return null;
}

export function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : NaN;
}
export function hhmm(min) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(Math.floor(min / 60)) + ':' + p(min % 60);
}

const INDIV = '개인고객';
const OPEN_MIN = 120;
export function isDesk(it) {
  return String((it && it.program) || '').replace(/\s+/g, '') === '안내데스크';
}
// 끝 시각이 비었으면 «끝 미정» — 같은 단체의 다음 시작까지(없으면 시작+120분) 진행 중으로 본다.
export function spanOf(it, items) {
  const s = toMin(it.start), e = toMin(it.end);
  if (e > s) return { s, e, open: false };
  let nx = s + OPEN_MIN;
  if (it.groupName !== INDIV) {
    for (const o of items) {
      const os = toMin(o.start);
      if (o !== it && o.groupName === it.groupName && os > s && os < nx) nx = os;
    }
  }
  return { s, e: nx, open: true };
}
