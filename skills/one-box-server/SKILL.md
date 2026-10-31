---
name: one-box-server
description: Vercel · Supabase Cloud 대신 VPS 한 대에 앱 여러 개와 자체 Supabase 스택(Postgres · PostgREST · storage-api)을 올리고 운영한다. 서버 준비 · 키 생성 · DB 부트스트랩 · Caddy부터 배포 스크립트(게이트 → 푸시 → 서버 빌드 → 안 뜨면 앞 판), 마이그레이션 · 되돌리기 · 매일 백업 · 매달 복구 연습까지 템플릿으로 깐다. "서버 한 대로 옮겨줘", "배포 스크립트 만들어줘", "백업 · 복구 연습", "Supabase 셀프 호스팅" 같은 요청에 쓴다.
---

# 서버 한 대 스킬

앱마다 호스팅 프로젝트와 DB 프로젝트를 따로 두는 대신, VPS 한 대에 Caddy 하나와 앱별 compose 묶음을 올린다. 운영 스크립트는 `/srv/ops` 한 곳에, 앱은 `/srv/<app>/` 아래에 모두 같은 꼴로 둔다. `templates/`는 실제로 앱 여러 개를 돌리던 구성을 일반화한 것이다.

## 맞는지 먼저 본다

- **맞다**: 트래픽이 작은 앱이 여럿이고, 앱 수만큼 붙는 요금이 부담이다. 경보 메일(디스크 · 인증서 · 백업 · 크론)을 받고 서버에 들어가 손댈 사람이 있다.
- **안 맞다**: 무중단 · 여러 리전이 필요하다. 서버를 볼 사람이 없다. 이 템플릿에 없는 기능(Realtime · Edge Functions · 호스팅 쪽 대시보드)에 기대고 있다. 앱 하나가 서버를 거의 다 쓴다.
- 애매하면 지금 쓰는 서비스 목록 · 앱 수 · 대략의 방문 수를 묻고, 위 기준에 비춰 한 줄로 답한 뒤 진행한다.

## 구성

| 템플릿 | 서버 위치 | 하는 일 |
|---|---|---|
| `bin/dc` | `/usr/local/bin/dc` | `dc <app> <compose 인자>` — 프로젝트 이름 · 폴더 · env 파일 · compose 파일을 늘 같게 |
| `edge/` | `/srv/edge` | Caddy 하나가 모든 호스트의 TLS와 라우팅을 맡는다 |
| `ops/` | `/srv/ops/ops` | 준비 · 키 · DB · env 합치기 · 마이그레이션 · 크론 · 경보 · 감시 · 백업 · 복구 연습 · 되돌리기 |
| `app/` | 각 앱 저장소의 `deploy/`(Dockerfile은 뿌리) | 앱 compose · `deploy.sh` · `env-push.sh` · `env.fixed.example` · `db/*.sql` |

`bin/` · `edge/` · `ops/`는 비공개 ops 저장소 하나로 만들어 서버의 `/srv/ops`에 받는다. 앱 하나 = `ops/apps.conf` 한 줄(이름 · deploy 폴더 · 포트). 서버 전체 설정은 `ops/ops.conf`(시간대 · 배포 사용자 · 백업 버킷).

## 처음 세우기 — 한 단계씩 확인하고 넘어간다

1. **값부터 정해 사용자에게 보여 준다**: 올릴 앱 목록, 앱마다 호스트 이름 · 포트 · DB 터널 포트, 백업 버킷, 경보 받을 주소, ssh 별칭. 템플릿의 `app1` · `example.com` · `myserver` · `<...>`를 이 값으로 바꾼다. 확인을 받고 파일을 만든다.
2. **서버 준비**: `sudo install -d -o ubuntu -g ubuntu /srv && git clone <ops 저장소> /srv/ops` → `sudo bash /srv/ops/ops/prep.sh` → 재부팅 한 번. 스왑 · Docker · 방화벽 · 자동 보안 업데이트 · 시간대 · 폴더가 깔린다.
3. **앱마다** (앱 저장소에 `app/` 템플릿을 넣고 `deploy/env.fixed`를 만든 뒤 커밋 · 푸시):
   1. `git clone <앱 저장소> /srv/<app>/repo`
   2. 키: `/srv/ops/ops/bootstrap-keys.sh <app>` → `.env.generated`. **첫 `db` 기동 전에.**
   3. 밀어 넣을 비밀: 로컬에서 `bash deploy/env-push.sh`(외부 API 키 → `.env.pushed`, 끝에서 env 합치기까지). 보낼 것이 없으면 서버에서 `env-merge.sh <app>`만.
   4. DB: `dc <app> up -d --wait db` → `bootstrap-db.sh <app>` (storage · auth 띄우기 전, 한 번).
   5. `dc <app> up -d --wait storage` — storage-api가 자기 표를 만든다. auth를 쓰면 같이.
   6. 마이그레이션: `migrate.sh <app> /srv/<app>/repo/supabase/migrations --dry-run` 목록을 보여 주고 → 적용.
   7. `dc <app> up -d rest`
4. **엣지**: DNS A 레코드를 이 서버로 돌린 호스트만 Caddyfile에서 켠다. `cp /srv/ops/edge/docker-compose.yml /srv/ops/edge/Caddyfile /srv/edge/ && cd /srv/edge && docker compose up -d`. 첫 리허설은 스테이징 CA 줄을 켜고, 확인 뒤 끄고 `caddy-apply.sh`.
5. **앱 배포**: 로컬에서 `bash deploy/deploy.sh`. 끝에 공개 주소가 200인지 본다.
6. **크론 · 경보 · 백업**: `/srv/ops/alert.env`(root 600) 만들기 → `sudo /srv/ops/ops/check.sh --test`로 메일이 오는지. root에 `aws configure --profile backup`. 앱 크론은 `cron.d/app1.example`을 본떠 `/etc/cron.d/<app>`로. 다음 날 아침 `backup.log`에 "backup ok"가 있는지, 그리고 `restore-drill.sh <app>`를 한 번 돌린다.

## 매일

- **배포**: `bash deploy/deploy.sh`. main · 깨끗한 작업 트리 · 게이트 통과 → push → 서버에서 pull · env 합치기 · 빌드 → `--wait`로 건강 확인 → 안 뜨면 앞 판으로 돌아간다. 푸시만으로는 아무 데도 안 나간다.
- **마이그레이션**: 안 올린 것이 있으면 deploy.sh가 앱을 그대로 두고 멈춰 목록을 보여 준다. 그 파일을 읽고 무엇이 바뀌는지(새 표 · 열, 지우거나 바꾸는 것, 잠기는 큰 표) 사용자에게 말하고, 답을 받은 뒤 `--migrate`로 다시 돌린다. 덤프(`predeploy/<sha>.dump`, 최근 셋)가 먼저 떨어진다.
- **되돌리기**: `ssh <별칭> /srv/ops/ops/rollback.sh <app> [sha]` — 앱 컨테이너만 앞 판으로. DB는 안 돌아간다.
- **Caddy 바꾸기**: ops 저장소에서 고쳐 푸시 → 서버에서 `git -C /srv/ops pull && /srv/ops/ops/caddy-apply.sh`. 컨테이너 재시작으로 적용하지 않는다.
- **경보 메일이 오면**: `journalctl -t ops-check`, `-t cron-<app>`, `dc <app> logs --tail 100 <서비스>`부터 본다.

## 매달

- 정한 날 앱마다 `sudo /srv/ops/ops/restore-drill.sh <app>` → `ops/restore-log.md`에 한 줄. 통과 기준 · 실제 복구 절차는 `templates/ops/restore.md`.
- 재부팅 창: `/var/run/reboot-required`가 있으면 사용자와 시간을 정해 재부팅하고, 모든 컨테이너가 healthy인지 본다.
- 분기마다: 스냅샷으로 새 인스턴스를 띄워 확인하고 지운다.

## 클로드가 서버에서 할 때 지킬 것

- **운영 DB에 쓰기 전(마이그레이션 · 복구 · 손으로 고치는 SQL) 덤프부터.** 그리고 무엇이 바뀌는지 사용자에게 말하고 명시적인 답을 받는다. "계속해"처럼 넘기는 말은 그 변경에 대한 답으로 치지 않는다.
- **키를 화면에 찍지 않는다.** `cat .env*` · `env` · `docker inspect`(env가 나온다) · `dc <app> config`(값이 풀린다)를 쓰지 않는다. 있는지만 볼 때는 `cut -d= -f1 .env` 또는 `grep -c '^NAME=' .env`.
- `bootstrap-keys.sh`가 "exists"로 멈추면 파일을 지우지 않고 사용자에게 알린다. 새 서버에선 백업의 `env-<day>.tgz`에서 되살린다.
- 한 앱만 건드린다(`dc <app> up -d app`). 엣지 컨테이너 재시작 · `docker system prune -a` · 볼륨 삭제는 하지 않는다.
- ssh로 스크립트를 stdin에 실어 보낼 때, 안에서 stdin을 읽는 명령에는 `</dev/null`을 붙인다.
- 검사가 실패하면 원인을 고친다. 경보를 끄거나 검사를 빼서 통과시키지 않는다.
- 겪은 함정 목록은 `gotchas.md` — 새 스크립트를 쓰기 전에 훑는다.

## 필요한 것

- 서버: Ubuntu 22.04 · 24.04, 메모리 4GB 이상을 권한다(서버에서 Next를 빌드하면 1.5~2.5GB까지 올랐다). 로그인 사용자가 비밀번호 없이 sudo를 쓸 수 있어야 한다(클라우드 이미지 기본).
- 로컬: bash · git · ssh(`~/.ssh/config`의 Host 별칭) · 프로젝트의 게이트 명령(`pnpm check` 자리).
- 백업용 S3 호환 버킷 하나와 그 버킷만 쓸 수 있는 키. 경보 메일용 메일 API 키 하나(템플릿은 Resend HTTP API).
- 앱: Next.js `output: "standalone"`. 다른 프레임워크면 `app/Dockerfile`과 헬스체크만 바꾼다.
