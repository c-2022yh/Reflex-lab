# HW3 Docker CI와 Windows 자동 배포

Node.js 24, 내장 SQLite, Docker Desktop의 `desktop-linux` 컨텍스트를 사용합니다.
외부 npm 의존성은 없습니다. 게임 화면과 Cloudflare Workers/D1 배포 설정은 유지합니다.

## 실행 흐름

`.github/workflows/ci.yml`은 `main` push 또는 `main`을 선택한 수동 실행에서 다음 순서로 실행합니다.

1. `test`: Node.js 24로 `npm.cmd test`와 JavaScript 문법 검사.
2. `docker`: 이미지에 전체 커밋 SHA를 기록하고 Docker Hub에 `latest`, 전체 SHA 태그 업로드.
3. `deploy`: `needs: docker` 성공 후 해당 실행의 **전체 SHA 태그를 pull**하여 배포.

게임의 5회 완료 화면에는 **반응시간 편차 = 최댓값 − 최솟값**을 ms로 표시합니다.
값이 작을수록 이번 도전의 반응이 일정했다는 뜻입니다. 평균·가장 빠른 반응·랭킹 계산과 저장 방식은 유지합니다.

모든 작업은 `[self-hosted, Windows, X64]`, `powershell`을 사용합니다.
현재 이 라벨의 Runner는 `reflex-windows`입니다. 배포는 같은 PC의 Docker/볼륨을 사용해야 합니다.
다른 PC에 같은 라벨의 Runner를 추가하면 별도의 전용 라벨 지정이 필요합니다.
PR 트리거는 없으며 기존 Cloudflare 워크플로는 독립적으로 계속 실행됩니다.
Secrets는 기존 `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`을 사용합니다.

GitHub에서 **Actions → HW3 Docker CI → Run workflow → main**으로 수동 실행합니다.
워크플로 파일은 먼저 기본 브랜치에 반영되어 있어야 합니다.
배포 스크립트의 성공/실패, URL, 요청 SHA, 후보/진입점 health, 복구 결과는 Actions Summary에 기록됩니다.
로그인 등 스크립트 실행 이전 단계가 실패하면 Summary에는 미실행과 health 미검증을 기록합니다. 원인은 해당 단계 로그를 확인하세요.

## 고정 진입점과 blue/green 배포

```text
http://127.0.0.1:3000
          |
reflex-lab-gateway (Nginx, 고정 컨테이너)
          |
   blue 또는 green (Node.js, 내부 포트 3000)
          |
reflex-lab-data 볼륨 → /data/reflex.sqlite (+ WAL/SHM)
```

- 기본 객체: `reflex-lab-gateway`, `reflex-lab-blue`, `reflex-lab-green`, `reflex-lab-network`.
- Nginx 설정은 `reflex-lab-proxy-config` 볼륨에 저장합니다. checkout 경로와 무관하게 유지됩니다.
- 후보 앱은 호스트 포트를 공개하지 않고 `HOST=0.0.0.0`, `PORT=3000`, `DB_PATH=/data/reflex.sqlite`로 실행합니다.
- 후보의 `/api/health`가 DB 질의에 성공하고 **이미지에 기록된 SHA와 요청 SHA가 일치해야** 전환합니다.
- 기존 Nginx 컨테이너를 재시작하지 않고 설정 검사 후 graceful reload합니다.
- 전환 뒤 고정 주소에서 HTTP 200, `ok=true`, 정확한 SHA를 3회 연속 확인합니다.
- 이전 앱은 실행 상태로 보존합니다. 다음 배포에서 이전 Nginx worker가 종료된 것을 확인한 뒤 비활성 슬롯을 재사용합니다.
- 전환 실패 시 이전 설정을 복원하고 이전 SHA의 health를 검증합니다. 복구가 실패하면 두 앱을 남기고 작업을 실패 처리합니다.
- 앱/프록시에는 `unless-stopped`를 설정합니다. Docker Desktop과 Runner는 사용자가 실행해 두어야 합니다.

Nginx reload의 연결 처리 방식은 [Nginx 공식 문서](https://nginx.org/en/docs/control.html)를 참고했습니다.
이 구조는 재배포 중 연속 요청 검증을 위한 것입니다. PC 재부팅, Docker Desktop 중지, 장시간 연결까지 포함한 무중단 보장은 별도 검증이 필요합니다.
이 앱의 일반 HTTP 요청은 최대 30초의 Nginx worker 종료 대기 안에서 처리하도록 구성했습니다.

## 데이터 유지와 기존 서비스

배포 스크립트는 데이터 볼륨을 삭제하거나 초기화하지 않습니다.
기존 `reflex-lab-data` 볼륨이 있으면 그대로 사용하고, 없으면 생성합니다.
데이터 파일과 WAL/SHM은 모두 같은 볼륨에 둡니다. 로컬 `.data/`와 Cloudflare D1은 별개입니다.

기존 데이터 볼륨 이름이 다르면 첫 배포 전에 CI의 스크립트 인자에 `-DataVolume 기존볼륨명`을 지정하세요.
이미 배포된 앱과 다른 볼륨을 지정하면 중단하여 빈 DB로의 실수 전환을 막습니다.
여러 앱이 DB를 잠시 공유하므로 SQLite 잠금 대기는 5초입니다.
앱 롤백은 DB 내용을 되돌리지 않습니다. 향후 스키마 변경은 이전 앱에서도 읽을 수 있도록 설계해야 합니다.

3000 포트가 다른 프로그램/컨테이너에 사용 중이면 PID, 프로세스명, 컨테이너 정보를 출력하고 실패합니다.
프로세스를 종료하거나 다른 서비스의 컨테이너를 자동 삭제하지 않습니다.
이전에 직접 `-p 3000:3000`으로 실행한 컨테이너가 있다면 볼륨을 먼저 확인하고, 해당 서비스의 종료와 첫 진입점 전환을 별도로 계획하세요.
첫 프록시 도입에는 기존 직접 접속 서비스를 자동 전환하지 않습니다.

Docker 객체 이름이 충돌해도 관리 라벨이 일치하지 않으면 변경하지 않습니다.
`docker system prune`, `docker volume prune`, `docker compose down -v`는 배포 과정에 없습니다.

## health 확인과 수동 재배포

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
docker --context desktop-linux ps
docker --context desktop-linux logs reflex-lab-gateway
```

정상 응답 예시:

```json
{"ok":true,"version":"1.0.0","commitSha":"0123456789abcdef0123456789abcdef01234567"}
```

SHA는 Docker build의 `COMMIT_SHA`로 이미지에 기록합니다. 배포 시 환경변수로 덮어쓰지 않습니다.
Node 직접 실행/기본 로컬 빌드는 `commitSha: "local"`을 반환하며 Cloudflare의 기존 health 형식은 유지됩니다.

배포 스크립트를 직접 실행할 때는 먼저 Docker Hub에 로그인하세요. 토큰은 명령줄에 쓰지 않습니다.

```powershell
docker --context desktop-linux login
$image = '본인DockerHub아이디/reflex-lab'
$sha = '배포할전체40자리커밋SHA'
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/deploy-windows.ps1 -Image $image -CommitSha $sha
```

`ExecutionPolicy Bypass`는 해당 자식 PowerShell 프로세스에만 적용하며 PC의 정책을 변경하지 않습니다.
SHA 태그가 없거나 이미지의 health SHA가 다르면 배포가 실패합니다. 정상 재배포에서 `latest`는 사용하지 않습니다.
Nginx 이미지는 첫 진입점 생성 시 `nginx:stable-alpine`을 pull합니다. 프록시 자체의 업그레이드는 이 스크립트가 자동 수행하지 않습니다.

Runner/PC가 강제 종료되어 자동 복구가 실행되지 못했다면 기존 앱이 남아 있는지 확인한 뒤 저장된 직전 설정으로 복구할 수 있습니다.
다음 명령은 정상 배포의 앱 롤백에도 사용할 수 있습니다. 복구 후 반드시 health와 SHA를 확인하세요.

```powershell
docker --context desktop-linux exec reflex-lab-gateway cp /etc/nginx/reflex/nginx.previous.conf /etc/nginx/reflex/nginx.conf
if ($LASTEXITCODE -ne 0) { throw 'Previous config could not be restored.' }
docker --context desktop-linux exec reflex-lab-gateway nginx -t -c /etc/nginx/reflex/nginx.conf
# 위 검사가 성공한 경우에만 reload
if ($LASTEXITCODE -eq 0) { docker --context desktop-linux exec reflex-lab-gateway nginx -s reload -c /etc/nginx/reflex/nginx.conf }
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

## 로컬 검증

```powershell
npm.cmd test
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/test-deploy-windows.ps1
```

통합 검증은 고유한 `reflex-test-...` 이름과 **13001 포트**, 검증 전용 볼륨을 사용합니다.
이미지 A/B와 실패용 이미지를 로컬에서 만들며 Docker Hub에는 업로드하지 않습니다.
검증 후 해당 실행이 생성한 컨테이너·볼륨·네트워크·이미지 태그만 정리합니다. 실제 서비스 데이터 볼륨은 건드리지 않습니다.
로컬 이미지를 쓰는 `-SkipPull`은 이 검증에서만 사용하며 CI는 항상 원격 SHA 이미지를 pull합니다.

검증 범위: 첫 배포, A→B 전환, 전환 중 health 150회, API 점수 저장과 볼륨 유지,
전환 후 health 실패 주입과 복구, 후보 SHA 불일치 거절, Windows 포트 충돌, 관련 없는 컨테이너 보존.
테스트 SHA는 서로 다른 fixture 표식이며 실제로 서로 다른 Git 커밋을 배포한 결과는 아닙니다.

기존 배포 구조의 로컬 검증 결과: API 테스트 7개 통과, Docker 이미지 빌드 성공,
PowerShell/Actions 문법 검사 통과, A→B 전환 중 health 150회 실패 0회.
점수 유지, 전환 후 실패 복구, SHA 불일치 거절, 포트 충돌 시 기존 프로세스 보존,
관련 없는 컨테이너 보존도 통합 검증에서 통과했습니다.
기존 test → docker → deploy와 게임·랭킹 저장은 사용자가 GitHub Actions에서 성공을 확인했습니다.
이번에 추가한 독립 관측 기능의 실제 GitHub Actions 실행은 아직 하지 않았습니다.

## 실제 재배포의 독립 관측

CI는 로그인 후 **별도의 Node.js 프로세스**로 `monitor-deployment.mjs`를 실행합니다.
첫 `/api/scores` 요청 완료 기록과 프로세스 실행을 확인한 뒤에만 `deploy-recorded.ps1`이 기존 배포 스크립트를 호출합니다.
관측 프로세스는 배포 PowerShell과 독립적으로 동작하며 서비스나 DB에 쓰기 요청을 보내지 않습니다.
배포·복구가 끝난 정확한 시각을 파일로 알리고, 성공/실패 모두 **그 시각부터 최소 30초**까지 계속 관측합니다.
단순히 프로세스가 30초 살아 있는 것으로 통과시키지 않고, 30초 경계 이후에 완료된 랭킹 요청도 있어야 합니다.

- 요청 대상은 고정 진입점 `http://127.0.0.1:3000/api/scores`입니다.
- HTTP 200뿐 아니라 JSON 객체, `scores`, `total`, `best`, 각 점수의 `id`, `nickname`, `average`, `fastest`, `createdAt` 및 기본 일관성을 검사합니다.
- 새 로컬 API는 랭킹 응답 JSON에도 이미지에 기록된 `commitSha`를 추가합니다. 기존 게임은 이 추가 필드와 무관하게 동작합니다. Cloudflare 응답 형식은 유지합니다.
- 응답에 SHA가 있으면 40자리 형식을 검사하고, 기준 SHA가 확인된 경우 기준/목표 SHA와 대조합니다. 성공 배포 후 마지막 정상 랭킹 응답이 목표 SHA여야 검증에 통과합니다.
- 직전 버전은 랭킹 응답에 SHA가 없으므로 첫 전환에서는 `SHA unknown`으로 집계합니다. 별도 `/api/health`의 기준 SHA는 출처를 구분해 표시하며, 그 SHA를 랭킹 응답에 대입하지 않습니다.
- 매 요청은 본문 수신·검사·기록을 마친 뒤 이전 응답 완료로부터 **최소 1초 후** 시작합니다. 요청은 겹치지 않습니다. 응답 지연이 있으면 시작 간격도 늘어납니다.
- 요청 시작/완료 UTC 시각, 단조 시계 기준 응답시간, 시작 간격, 이전 완료 후 대기시간, 성공 여부, 상태 코드, SHA, 검증 오류, 전체 응답 본문을 기록합니다.
- 완료 기록 사이의 최대 공백과 마지막 기록 이후 공백을 계산합니다. 기본 2,500ms를 넘는 구간은 시작·종료 시각과 대기/요청시간을 함께 표시합니다. 느린 요청이나 모니터 지연도 공백을 만들 수 있어 곧바로 서비스 중단이라고 단정하지 않습니다.

기존 관리 gateway가 있으면 `redeployment`, 없으면 `initial-deployment`입니다.
최초 배포에서 첫 정상 응답 전의 연결 거부는 `initial service not yet available`로 별도 집계합니다.
HTTP 오류나 잘못된 JSON은 이 예외로 숨기지 않으며, 배포가 끝난 뒤의 연결 실패도 실패입니다.
최초 배포의 이전 SHA는 없음으로 표시하고, 기존 서비스의 재배포 무중단 검증으로 해석하지 않습니다.

Summary에는 검증 URL·UTC 시간 범위·배포 전/중/후 요청 수·전후 SHA·대표 정상/실패 응답,
성공/실패/최초 미가용/SHA 미확인 건수, 응답시간·실제 요청 간격·최대 기록 공백을 표시합니다.
판정은 **관측한 요청에서 실패가 있었는지**와 **관측 범위가 완전한지**로 한정합니다.
1초의 요청 사이 구간, 완료 기록이 없는 요청, 로그 공백에서는 가용성을 증명하지 못합니다.
프로세스/Runner가 강제 종료되거나 파일이 잘리면 불완전한 관측으로 표시합니다.

배포가 성공해도 관측 요청 실패·기록 공백·관측 시간 부족 등이 있으면 관측 단계가 실패할 수 있습니다.
관측 프로세스는 서비스를 변경하지 않습니다. 앱 전환과 복구는 기존 배포 스크립트가 담당합니다.

### UTF-8 로그와 Artifacts

`outputs/deployment-<run_id>-<run_attempt>/` 아래에 기록합니다.
기존 `.gitignore`와 `.dockerignore`의 `outputs/` 제외 규칙이 JSON·로그·제어 파일·임시 파일 모두에 적용됩니다.

| 파일 | 내용 |
|---|---|
| `events.jsonl` | baseline health, 모든 요청 시작과 완료, 배포 시작 이벤트 |
| `requests.jsonl` | 요청별 전체 완료 기록과 원문 응답 |
| `deployment.log` | PowerShell 배포·Docker·실패 복구 전체 출력 (UTF-8로 정규화) |
| `report.json`, `summary.md` | 집계 결과와 Actions Summary 원본 |
| `config.json`, `ready.json`, `process.json`, `complete.json` | 관측 설정·별도 프로세스·완료 상태 |
| `deployment-started.json`, `deployment-finished.json` | 배포 시작/종료 시각과 결과 |
| `monitor.stdout.log`, `monitor.stderr.log` | 모니터 진단 출력 |
| `control-errors.log` (오류 시) | 시작·종료·보고 제어 명령의 예외 |

종료·보고·[Artifact 업로드](https://github.com/actions/upload-artifact)는 `if: always()`로 실행합니다.
배포/관측 실패 시에도 `deployment-observation-<run_id>-<run_attempt>` Artifact를 30일 보존합니다.
Runner 연결 자체가 끊기거나 업로드가 실패하면 원격 보존을 보장할 수 없으므로 PC의 `outputs` 파일도 확인하세요.
다음 checkout이 이전 로컬 로그를 정리할 수 있으니 필요한 결과는 Artifact로 보관하세요.
로그는 실제 랭킹 응답(닉네임 포함)을 담습니다. Docker Hub 로그인은 배포 transcript 밖에서 처리합니다.

전체 로컬 관측 검증은 다음과 같이 실행합니다. 최초 배포/정상 재배포/실패 복구/잘못된 SHA 각각에 종료 후 30초 관측을 적용하므로 수 분이 걸립니다.

```powershell
npm.cmd test
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/test-deploy-windows.ps1 -Observe
```

검증 전용 13001 포트와 고유 볼륨을 사용하고, 결과는 `outputs/reflex-test-.../`에 남깁니다.
테스트 SHA는 fixture 표식입니다. 실제 운영 3000 포트의 앱이나 데이터는 전환하지 않습니다.

이번 변경의 로컬 검증에서는 자동 테스트 11개가 통과했고, 정상 재배포의 랭킹 요청 41건이 모두 성공했습니다.
마지막 요청 완료는 배포 종료 후 30.285초였고 최대 완료 기록 공백은 1.102초였습니다.
실패 주입에서는 503 응답 6건을 기록한 뒤 기존 SHA로 복구되었으며, 복구 종료 후 30초 경계 이후까지 관측·로그를 유지했습니다.
잘못된 JSON·필수 필드 누락·타임아웃·관측 로그 중단 및 편차 표시도 테스트했습니다.
이 결과는 로컬 fixture 검증이며 이번 변경의 실제 Actions 실행/Artifact 업로드 결과는 아닙니다.

GitHub에 반영한 뒤 추가 확인:

1. `deploy`가 업로드 성공 뒤에만 `reflex-windows`에서 실행되는지.
2. 로그가 Docker Hub의 해당 전체 SHA 태그 pull을 보여주는지.
3. Summary와 `http://127.0.0.1:3000/api/health`의 SHA가 실행 커밋과 일치하는지.
4. 브라우저에서 게임을 완료하고 기록을 저장한 뒤 다음 커밋 배포 후에도 기록이 유지되는지.
5. 연속 요청 중 두 개의 실제 커밋 간 재배포를 수행해 HTTP 실패와 연결 중단이 없는지.
6. 기존 Cloudflare 워크플로와 사이트가 정상인지.
