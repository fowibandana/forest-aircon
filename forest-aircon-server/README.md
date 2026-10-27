# 산림치유센터 에어컨 — 서버 + 폰 화면

- **폰 화면** (`public/index.html`): 층별(B1·1F·2F) 방 카드. 방 온도, 오늘 일정(진행 중/다음), 에어컨 상태, 냉방·난방·끄기·온도 조작.
- **서버** (`src/`): 5분마다 주간운영계획 일정을 읽고, 시작 30분 전부터 방 온도를 봐서 에어컨을 켜고 끄고, 모든 일정이 끝나면 끕니다.
- ThinQ 앱의 «방 설정»은 API로 읽을 수 없어서, 에어컨 이름 → 방 대응표를 `src/rooms.js`의 `ALIAS_PLACE`에 옮겨 두었습니다.
  새 에어컨을 등록하면 거기에 한 줄을 추가하세요. (표에 없는 에어컨은 화면 맨 아래 «표에 없는 에어컨»에 나옵니다)

## 배포 (Cloudflare)
1. Cloudflare 대시보드 → **Workers & Pages → Create application → Import a repository**(GitHub) → 이 저장소 선택
2. **Root directory**: `forest-aircon-server` / Deploy command: `npx wrangler deploy` → **Save and deploy**
3. 배포가 끝나면 **Settings → Variables and Secrets**에서 **Secret**으로 두 개를 추가
   - `THINQ_PAT` : ThinQ 토큰 (재발급한 새 토큰)
   - `APP_PASSWORD` : 폰 화면에 들어갈 비밀번호 (직접 정하세요)
4. 주소(`https://forest-aircon.○○○.workers.dev`)를 폰에서 열고 비밀번호 입력 → 홈 화면에 추가

## 자동 제어 켜기
처음에는 `wrangler.toml`의 `AUTO_MODE = "dry"`(시험 모드)입니다. 실제로 제어하지 않고, 하려던 일을 화면의 «자동 판단»과 Cloudflare 로그에만 남깁니다.
며칠 지켜본 뒤 `"live"`로 바꾸면(GitHub에서 파일 수정 → 자동 재배포) 실제로 제어합니다.

## 기준값 (src/config.js — 제가 임의로 정한 기본값)
| 항목 | 기본값 |
|---|---|
| 프로그램 시작 몇 분 전부터 제어 | 30분 |
| 방 온도가 이 이상이면 냉방(24°) | 26° |
| 방 온도가 이 이하면 난방(22°) | 18° |
| 냉방 중 이 이하로 내려오면 끔 | 24° |
| 난방 중 이 이상으로 오르면 끔 | 22° |
| 모든 일정 종료 후 끄기까지 | 10분 |
| 자동 제어 시간대 | 06:00~22:00 |

## 시험
`npm test` (모의 일정·모의 ThinQ로 판단과 호출을 검사합니다)
