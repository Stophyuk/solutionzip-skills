---
name: secret-guard
description: 클로드 코드 입력창에 붙여 넣는 API 키 · 비밀번호 · 주민번호를 보내기 전에 막는 훅을 깔고, 이미 쌓인 입력 기록(history.jsonl)과 세션 기록에 남은 비밀값을 가린다. "키 붙여 넣은 거 지워줘", "비밀번호 입력 막아줘", "대화 기록에 남은 키 정리", "비밀값 차단 훅" 같은 요청에 쓴다.
---

# 비밀값 차단과 기록 가리기

입력창에 붙여 넣은 키는 모델로 넘어가고, 맥의 입력 기록(`~/.claude/history.jsonl`, 기간 제한 없음)과 세션 기록(`~/.claude/projects`, 기본 30일)에 평문으로 남는다. 요약이나 다른 에이전트에게 넘기는 지시문으로 번지기도 한다. 앞으로는 막고, 이미 남은 것은 가린다.

## 1. 앞으로 막기(훅)

1. `hooks/secret-guard.mjs`를 `~/.claude/hooks/`로 복사한다.
2. `~/.claude/settings.json`을 먼저 읽고, 기존 훅을 지우지 말고 `hooks.UserPromptSubmit`에 더한다.
   ```json
   { "type": "command", "command": "node \"$HOME/.claude/hooks/secret-guard.mjs\"", "timeout": 5 }
   ```
3. 시험: 가짜 키(`sk-ant-api03-` 뒤에 아무 글자 30개)를 넣은 문장을 훅에 흘려 종료 코드 2가 나오는지, 보통 문장은 0인지 본다.

막는 것: Anthropic · OpenAI · AWS · GitHub · Google · Slack · Apify 키, 개인 키 블록, 주민 · 외국인등록번호, 서버용 Supabase 키(service_role. 공개용 anon 키는 통과), "비밀번호: abc123" 같은 문장. 잘못 걸리면 맨 앞에 `#허용`을 붙여 보낸다. 걸린 종류(값은 아님)는 `~/.claude/hooks/log.jsonl`에 한 줄씩 남는다.

## 2. 이미 남은 것 가리기

먼저 바꾸지 않고 건수만 본다. 값은 화면에 찍지 않는다.

```sh
python3 -I scripts/redact_history.py                  # 입력 기록, 건수만
python3 -I scripts/redact_transcripts.py              # 세션 기록, 건수만(오래 걸린다)
```

괜찮으면 `--apply`. 입력 기록은 원본을 `~/.claude-redact-backup/`(권한 700)에 남기고 고친다. 세션 기록은 비밀값이 든 사본을 하나 더 만들지 않으려고 원본 없이 그 자리에서 고친다. 지금 열려 있는 세션 파일(1시간 안에 쓰인 것)은 건너뛴다. 모든 세션을 닫은 뒤 `--apply --all`로 한 번 더 돌린다.

- 노션이나 문서에 비밀값 모음 페이지가 있고 그 페이지를 Claude가 읽은 적이 있으면, 페이지 제목이나 ID를 `--marker "제목"`으로 넘긴다. 그 기록은 통째로 가리고, 거기 있던 값은 다른 기록에서도 찾아 가린다.
- 백업 폴더는 `permissions.deny`에 `Read(~/.claude-redact-backup/**)`를 넣어 Claude가 읽지 못하게 하고, 확인이 끝나면 지운다.

## 3. 가린 뒤에

가리기는 맥에 남은 사본을 지울 뿐이다. 이미 모델로 넘어간 키는 각 서비스에서 재발급해야 한다. 재발급 목록을 만들 때는 값 대신 끝 4자리와 붙여 넣은 날짜 · 폴더만 적는다. 키로 직접 접속해 살아 있는지 확인하지 않는다(그 계정에 기록이 남는다).

## 지난 실수

- 문맥을 확인하려고 출력하다가, 길이 기준(16자 이상)보다 짧은 값이 가려지지 않고 찍혔다. 그 뒤로 문맥을 볼 때는 6자 이상 영문 · 숫자 덩어리를 모두 가린다.
