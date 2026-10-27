// 자동 제어 기준 — 아래 숫자는 제가 임의로 정한 "기본값"입니다. 현장에 맞게 고쳐 쓰세요.
export const CONFIG = {
  SCHEDULE_URL: 'https://jinan-schedule.pages.dev/api',
  THINQ_BASE: 'https://api-kic.lgthinq.com', // 한국(동아시아) 서버

  PRE_MIN: 30,         // 프로그램 시작 몇 분 전부터 방 온도를 보고 제어할지
  POST_GRACE_MIN: 10,  // 모든 일정이 끝나고 몇 분 뒤에 끌지

  HOT_ON: 26,          // 방 온도가 이 이상이면 냉방을 켠다
  COOL_TARGET: 24,     // 냉방 설정 온도
  COOL_OFF: 24,        // 냉방 중 방 온도가 이 이하로 내려오면 끈다

  COLD_ON: 18,         // 방 온도가 이 이하면 난방을 켠다
  HEAT_TARGET: 22,     // 난방 설정 온도
  HEAT_OFF: 22,        // 난방 중 방 온도가 이 이상으로 오르면 끈다

  ACTIVE_FROM_HOUR: 6, // 이 시각(KST) 전에는 자동 제어를 하지 않는다
  ACTIVE_TO_HOUR: 22,  // 이 시각(KST) 이후에는 하지 않는다
};

// 에어컨 이름(별칭)에서 방을 못 찾을 때, 기기 ID로 직접 지정한다.
// 예) { 'eb8ce6a9...': 'r201' }  — 방 키는 src/rooms.js 의 ROOMS 참고
export const ROOM_OVERRIDES = {};
