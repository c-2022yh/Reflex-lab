# Reflex Lab — 반응속도 챌린지

닉네임 입력 → 불규칙한 초록 신호에 5회 반응 → 평균 반응시간과 전체 랭킹을 확인하는 웹게임입니다.

## 현재 확인한 상태

- Node.js 24.19.0에서 추가 npm 패키지 없이 로컬 서버 실행 성공.
- API 자동 테스트 6개 통과: 평균·최솟값 계산, 빈 랭킹, 기록 저장과 중복 방지, 순위와 동점 처리, 세션 검증, 잘못된 요청 처리.
- JavaScript 문법 검사 통과.
- 브라우저 도구의 세션 오류로 실제 클릭·터치·키보드 플레이와 반응형 화면 검증은 미완료.
- GitHub 업로드, Cloudflare 계정·D1 연결, GitHub Secrets 설정, 실제 온라인 배포 및 Push 자동 재배포는 미완료.
- 이 폴더의 `.github/workflows/deploy.yml`은 자동 배포 설정이며, 배포 성공 증거가 아닙니다.

## 로컬 실행 (Windows PowerShell)

Node.js 24 이상이 필요합니다. Python이나 별도 npm 패키지는 필요하지 않습니다.

```powershell
cd "이 폴더의 전체 경로"
node --version
npm start
```

브라우저에서 `http://127.0.0.1:3000`을 엽니다. 종료는 서버를 실행한 창에서 `Ctrl+C`.
Node 내장 SQLite의 실험적 기능 경고가 표시될 수 있으나 이 프로젝트에서 사용하는 API는 로컬 테스트를 통과했습니다.

로컬 기록은 `.data/reflex.sqlite`에 저장되며 재시작 후 유지됩니다. 이 파일은 Git에 올리지 않습니다. 온라인 D1 기록과 로컬 기록은 서로 별개입니다.

```powershell
npm test
```

## 플레이 규칙

- 닉네임: 문자·숫자·공백·밑줄·하이픈으로 2~12자.
- 각 회차의 대기시간은 1.8~5초 사이의 무작위 값입니다.
- 초록 신호에서 마우스 버튼을 누르거나 터치하거나 스페이스·Enter를 누릅니다.
- 신호 전에 누르면 해당 회차만 재측정합니다.
- 창을 벗어나거나, 반응값이 80ms 미만·5,000ms 초과이면 해당 회차를 재측정합니다.
- 5회 평균이 낮을수록 높은 순위입니다. 평균이 같으면 먼저 저장된 기록이 우선이며 시각까지 같으면 ID로 순서를 정합니다.
- 랭킹은 각 도전을 기록합니다. 동일 닉네임의 최고 기록만 모으는 방식이 아닙니다.
- 5회 완료 후 자동 저장하며 실패하면 재시도 버튼을 제공합니다.
- 랭킹은 측정 도중을 제외하고 15초마다, 그리고 새로고침 버튼을 누를 때 갱신합니다.

## 구조

```text
public/                  HTML, CSS, 브라우저 게임 로직
src/api.mjs              로컬/온라인 공통 API와 서버 입력 검증
src/worker.mjs           Cloudflare Workers 엔트리
src/local-db.mjs         Node 내장 SQLite를 D1 인터페이스로 연결
server.mjs               추가 의존성 없는 로컬 HTTP 서버
migrations/              온라인 D1 스키마 SQL
wrangler.toml            Workers + 정적 파일 + D1 배포 설정
.github/workflows/       Push 시 테스트 → DB 마이그레이션 → 배포
```

## API

| 경로 | 방식 | 역할 |
|---|---|---|
| `/api/sessions` | POST | 측정 세션 생성 (유효기간 1시간) |
| `/api/scores` | POST | 닉네임·세션·5회 측정값 저장, 서버에서 평균 계산 |
| `/api/scores` | GET | 상위 10개, 전체 기록 수, 최고 평균 조회 |
| `/api/health` | GET | DB 연결 확인과 앱 버전 조회 |

같은 세션으로 저장을 재시도해도 기록은 중복 생성되지 않습니다. 이미 저장한 세션에 다른 데이터를 보내면 409를 반환합니다.

## GitHub와 Cloudflare를 연결해 과제 완료하기

이 프로젝트는 Cloudflare Workers + D1 배포를 대상으로 설정했습니다. 계정과 GitHub 연결은 사용자가 소유한 실제 계정에서 완료해야 합니다. 요금제·할당량은 계정 화면에서 확인하세요.

1. 이 폴더를 새 GitHub 저장소의 루트로 올립니다. 상위 `reaction-rank` 실험용 폴더는 포함하지 않습니다.
2. Cloudflare 계정에서 Workers 사용 준비를 마치고, 해당 계정에 로그인합니다.
3. 이 폴더에서 `npx wrangler@4.92.0 login`을 실행하고 브라우저 인증을 완료합니다.
4. `npm run db:create`로 D1 데이터베이스를 만듭니다.
5. 출력된 실제 `database_id`를 `wrangler.toml`의 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 대신 넣습니다.
6. `npm run db:migrate`와 `npm run deploy`로 최초 배포합니다. 출력된 실제 Workers URL에서 플레이와 랭킹 저장을 확인합니다.
7. GitHub 저장소의 Settings → Secrets and variables → Actions에 아래 두 개를 등록합니다. 토큰은 소스·보고서·채팅에 붙여 넣지 않습니다.
   - `CLOUDFLARE_API_TOKEN`: 이 계정의 Workers 수정 및 D1 수정에 필요한 권한을 가진 API 토큰.
   - `CLOUDFLARE_ACCOUNT_ID`: 배포할 계정의 ID.
8. `wrangler.toml` 변경을 main에 Push합니다. Actions에서 테스트와 배포가 모두 성공하는지 확인합니다.
9. 화면 문구를 한 군데 수정해 main에 다시 Push합니다. Actions 성공과 실제 사이트 반영을 확인하면 자동 배포 검증이 끝납니다.

GitHub Desktop을 사용할 경우 File → Add local repository로 이 폴더를 선택하고, 저장소가 없다는 메시지가 뜨면 여기서 새 저장소를 생성합니다. 변경 내용을 Commit한 다음 Publish repository로 새 저장소를 올릴 수 있습니다. 저장소 공개 여부는 과제 기준과 본인 선호에 맞게 선택합니다.

## 제출 캡처 제안

1. 배포 주소가 보이는 실제 게임 결과와 랭킹.
2. GitHub의 소스 및 커밋 기록.
3. 마지막 수정 Push에 대응하는 Actions 테스트·배포 성공 화면.

보고서 1페이지에는 서비스 목적, 핵심 기능, AI에 요청한 실제 프롬프트와 검토 내용, 개발·데이터 저장·배포 구조, GitHub·서비스 URL, 실제 검증 결과를 적습니다. 아직 하지 않은 배포나 검증을 완료했다고 적지 않습니다.

## 측정 한계

브라우저의 `performance.now()`로 초록 신호 처리 시점부터 입력 이벤트까지의 시간을 계산합니다. 모니터 주사율, 프레임 표시 시점, 입력장치 지연이 포함될 수 있으며 기기 간 정밀 측정 도구는 아닙니다. 서버는 입력 형식·범위·세션과 중복 여부를 검증하지만, 브라우저에서 만든 측정값 자체의 조작을 완전히 방지하지는 못합니다.

## AI 활용 기록

요청 방향: “반응속도 측정 + 전체 랭킹. 닉네임 입력 → 5회 측정 → 평균 기록 저장. GitHub Push 시 자동 배포.”
AI가 화면, 상태 전환, 공통 API, SQLite/D1 연결, 테스트, 배포 워크플로와 문서 초안을 작성했습니다. 개발 중 외부 패키지 설치와 소스 배포 서버 접근이 실패해, 로컬 실행이 추가 의존성을 요구하지 않도록 HTML/CSS/JavaScript + Node 내장 SQLite 구조로 정리했습니다. 실제 검증 결과는 위 ‘현재 확인한 상태’에 구분해 기록했습니다.
