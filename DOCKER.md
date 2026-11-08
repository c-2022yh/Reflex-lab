# HW3 Docker CI와 Windows 자동 배포

Node.js 24, 내장 SQLite, Docker Desktop의 `desktop-linux` 컨텍스트를 사용합니다.
외부 npm 의존성은 없습니다. 게임 화면과 Cloudflare Workers/D1 배포 설정은 유지합니다.

## 실행 흐름

`.github/workflows/ci.yml`은 `main` push 또는 `main`을 선택한 수동 실행에서 다음 순서로 실행합니다.

1. `test`: Node.js 24로 `npm.cmd test`와 JavaScript 문법 검사.
2. `docker`: 이미지에 전체 커밋 SHA를 기록하고 Docker Hub에 `latest`, 전체 SHA 태그 업로드.
3. `deploy`: `needs: docker` 성공 후 해당 실행의 **전체 SHA 태그를 pull**하여 배포.

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

2026-11-08 로컬 검증 결과: API 테스트 7개 통과, Docker 이미지 빌드 성공,
PowerShell/Actions 문법 검사 통과, A→B 전환 중 health 150회 실패 0회.
점수 유지, 전환 후 실패 복구, SHA 불일치 거절, 포트 충돌 시 기존 프로세스 보존,
관련 없는 컨테이너 보존도 통합 검증에서 통과했습니다.
실제 GitHub Actions의 새 `deploy` 작업과 Docker Hub SHA pull은 아직 실행하지 않았습니다.

GitHub에 반영한 뒤 추가 확인:

1. `deploy`가 업로드 성공 뒤에만 `reflex-windows`에서 실행되는지.
2. 로그가 Docker Hub의 해당 전체 SHA 태그 pull을 보여주는지.
3. Summary와 `http://127.0.0.1:3000/api/health`의 SHA가 실행 커밋과 일치하는지.
4. 브라우저에서 게임을 완료하고 기록을 저장한 뒤 다음 커밋 배포 후에도 기록이 유지되는지.
5. 연속 요청 중 두 개의 실제 커밋 간 재배포를 수행해 HTTP 실패와 연결 중단이 없는지.
6. 기존 Cloudflare 워크플로와 사이트가 정상인지.
