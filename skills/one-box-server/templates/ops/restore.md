# 복구 — 연습과 실제

## 매달 연습 (날을 정해 둔다. 첫 실결제 · 첫 손님 데이터가 생긴 직후에도 한 번)

1. 앱마다 `sudo /srv/ops/ops/restore-drill.sh <app> [YYYY-MM-DD]`. 그날 밤 덤프를 받아 일회용 컨테이너(같은 Postgres 이미지, `--network none`)에 `public` + `auth`를 되살리고, 표마다 행 수를 운영과 나란히 찍은 뒤 다 지운다.
2. 통과 기준:
   - `errors`가 0이거나, 0이 아니면 이유를 안다(첫 회는 pg_restore 옵션을 맞추느라 날 수 있다).
   - `differs`에 나온 표는 전부 덤프 뒤(03:17 뒤)에 생긴 행으로 설명된다.
   - `drill.d/<app>.txt`의 검사(돈 합계 · 불변식)가 기대값이다 — 불변식은 0.
3. `ops/restore-log.md`에 한 줄: 날짜 · 앱 · 덤프 날 · errors · 표 수와 행 수 · 차이 · 앱별 검사 · 걸린 분.
4. 분기마다: 서버 스냅샷으로 새 인스턴스를 띄워 `docker ps`와 앱 한 페이지를 확인하고 지운다.

## 실제로 한 앱의 DB를 되살릴 때

먼저 사용자에게 말한다: 어느 앱, 어느 시점의 덤프, 그 뒤에 생긴 데이터는 사라진다는 것. 답을 받고 시작한다.

1. 쓰는 쪽을 멈춘다: `dc <app> stop app`, 그동안 `/etc/cron.d/<app>`를 치워 둔다.
2. 지금 있는 것을 깨졌더라도 덤프한다:
   `dc <app> exec -T db pg_dump -U supabase_admin -Fc postgres </dev/null > /srv/<app>/predeploy/before-restore.dump`
3. 되살릴 덤프를 고른다: `/srv/<app>/predeploy/<sha>.dump`(배포가 마이그레이션 직전에 뜬 것) 또는 버킷의 `daily/<day>/<app>-db-<day>.dump`.
4. 운영 db 컨테이너에 `pg_restore -U supabase_admin -d postgres --clean --if-exists -n public -n auth <dump>` →
   `notify pgrst, 'reload schema'` → `dc <app> up -d`.
5. `drill.d/<app>.txt` · `check.d/<app>.sh`의 불변식을 다시 돌려 기대값인지 본다. 크론 파일을 되돌려 놓는다.

## 생성된 키

`/srv/<app>/.env.generated`는 매일 밤 덤프와 함께 버킷에 들어간다(`daily/<day>/env-<day>.tgz`). 새 서버에서는 **이 파일을 되살린다. `bootstrap-keys.sh`를 다시 돌리지 않는다.** 새 JWT 비밀은 모든 세션을 끊고 빌드에 박힌 anon 키를 무효로 만든다. 해시 · 서명용 키가 바뀌면 저장해 둔 해시가 더는 맞지 않고, 이미 보낸 메일의 링크가 열리지 않는다.

이미지는 `ops/rollback.sh <app>`로 되돌린다. DB는 이미지와 함께 돌아가지 않는다 — 마이그레이션은 더하기만 한다.
