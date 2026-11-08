# HW3 Docker CI

Node.js 24와 내장 SQLite를 사용합니다. 외부 npm 의존성이 없어 설치 단계는 없습니다.
기존 Cloudflare Workers/D1 설정과 `.github/workflows/deploy.yml`은 그대로 유지됩니다.

## 로컬 실행 (PowerShell)

```powershell
npm.cmd test
docker build -t reflex-lab:local .
docker volume create reflex-lab-data
docker run -d --name reflex-lab -p 3000:3000 --mount source=reflex-lab-data,target=/data reflex-lab:local
Invoke-RestMethod http://localhost:3000/api/health
docker inspect --format '{{.State.Health.Status}}' reflex-lab
docker logs reflex-lab
```

정상 health 응답은 `{"ok":true,"version":"1.0.0"}`입니다.
브라우저에서 `http://localhost:3000`을 열면 게임을 사용할 수 있습니다.
컨테이너는 일반 사용자 `node`로 `node server.mjs`를 실행합니다.
환경변수는 `HOST=0.0.0.0`, `PORT=3000`, `DB_PATH=/data/reflex.sqlite`입니다.

SQLite 데이터베이스와 WAL 파일을 모두 `/data` 볼륨에 저장합니다.
아래처럼 컨테이너를 삭제하고 같은 볼륨으로 다시 실행해도 기록이 유지됩니다.

```powershell
docker stop reflex-lab
docker rm reflex-lab
docker run -d --name reflex-lab -p 3000:3000 --mount source=reflex-lab-data,target=/data reflex-lab:local
```

볼륨을 삭제하면 기록도 삭제됩니다. 기존 로컬 `.data/`와 Cloudflare D1 기록은 별개입니다.
호스트의 3000 포트가 사용 중이면 `-p 3001:3000`으로 바꾸고 `http://localhost:3001`로 접속하세요.

## GitHub Actions

- `main` push: 테스트 성공 → Docker 이미지 빌드 성공 → Docker Hub 로그인 및 업로드.
- `main` 대상 PR: 테스트와 Docker 빌드만 실행. 로그인과 업로드는 건너뜁니다. Fork PR도 Secrets 없이 빌드합니다.
- 이미지: `<DOCKERHUB_USERNAME>/reflex-lab:latest`, `<DOCKERHUB_USERNAME>/reflex-lab:<전체 커밋 SHA>`.
- 저장소 Secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (Docker Hub 이미지 push 권한 필요).
- GitHub 호스팅 `ubuntu-latest` runner만 사용합니다. Self-hosted Runner 배포는 추가하지 않았습니다.
- 기존 Cloudflare 배포 워크플로는 별도로 계속 실행됩니다.

업로드된 이미지는 `docker pull <DOCKERHUB_USERNAME>/reflex-lab:latest`로 받을 수 있습니다.
실제 GitHub Actions 실행과 Docker Hub 업로드는 변경 사항을 push한 뒤 확인합니다.

Docker Hub 로그인과 PR 업로드 제외 조건은 [Docker 공식 GitHub Actions 문서](https://docs.docker.com/build/ci/github-actions/)를 참고했습니다.
