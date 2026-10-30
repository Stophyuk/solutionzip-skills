# 카드뉴스 · 숏폼 클로드 스킬

[문제해결집](https://solutionzip.kr)이 인스타 · 스레드 · 유튜브에 올릴 카드뉴스와 숏폼을 만들 때 쓰는 방식을 스킬 두 개로 떼어 냈습니다. 디자인 툴 없이 HTML로 짜고, 헤드리스 크롬으로 찍습니다.

![카드뉴스 예시 다섯 장](skills/card-news/examples/_all.png)

| 스킬 | 하는 일 | 결과 |
|---|---|---|
| [`card-news`](skills/card-news) | HTML 한 장 → 카드마다 PNG, 폰에서 깨지는 곳 검사 | 1080×1350 · 1080×1080 · 1080×1920 PNG |
| [`html-shorts`](skills/html-shorts) | HTML 장면 → 프레임마다 찍어 세로 영상으로 | 1080×1920 MP4 + 표지 JPG |

위 카드 다섯 장과 [예시 영상](skills/html-shorts/examples/demo.mp4)도 이 스킬로 만들었습니다.

## 왜 HTML인가

- 글꼴 · 색 · 줄바꿈이 코드로 고정돼, 몇 번을 뽑아도 같은 결과가 나옵니다.
- 고칠 때는 문장만 바꾸면 됩니다. 클로드가 바로 읽고 고칠 수 있는 형식입니다.
- 찍는 김에 검사합니다. 넘치는 줄, 프로필 격자에서 잘리는 위아래, 너무 작은 글자, 빠진 사진, 매체 버튼에 가리는 글자를 알려 줍니다.

## 설치

필요한 것: Node 18 이상 · 크롬(없으면 `npx playwright install chromium`) · 숏폼은 ffmpeg.

```sh
git clone https://github.com/Stophyuk/solutionzip-skills.git
cd solutionzip-skills
npm i                      # playwright 하나

# 클로드 코드에 스킬로 넣기
mkdir -p ~/.claude/skills
cp -r skills/card-news skills/html-shorts ~/.claude/skills/
```

클로드 코드에서 "카드뉴스 만들어줘: 주제"나 "숏폼 만들어줘: 주제"라고 하면 됩니다. 클로드가 장마다(장면마다) 한 줄씩 먼저 보여 주고, 좋다고 하면 HTML을 쓰고 찍고 검사합니다.

## 직접 돌리기

```sh
node skills/card-news/render.mjs skills/card-news/template.html out
node skills/html-shorts/render.mjs skills/html-shorts/template.html out/demo.mp4
```

Playwright를 찾지 못하면, 스크립트가 있는 폴더나 그 위 폴더에서 `npm i playwright`를 했는지 확인하세요.

## 지키는 것

- 확인 안 된 숫자 · 최상급 · 보장 표현은 쓰지 않습니다.
- "팔로우하면 드려요"처럼 참여를 조건으로 걸지 않습니다(메타 스팸 정책).
- AI로 만든 사실적인 이미지 · 목소리는 올릴 때 AI 표시를 켭니다.
- 같은 틀에 글만 바꾼 영상을 대량으로 찍어 내지 않습니다.

점검표: [카드뉴스](skills/card-news/checklist.md) · [숏폼](skills/html-shorts/checklist.md)

## 라이선스

MIT. 상업적으로 써도 됩니다.
