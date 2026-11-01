# solutionzip Claude skills

[한국어](README.md) · English

When you work with Claude Code, you end up explaining the same things every session: how to shoot card news, what to check before a deploy, what never to do on a server. These are the ways [solutionzip](https://solutionzip.kr) (문제해결집) actually works, split into ten skills.

![Five example card-news slides](skills/card-news/examples/_all.png)

> The skill files are written in Korean, and the copy rules, checklists and templates are made for Korean text. Claude reads them as they are, so you can still ask in English.

## Skills

**Make**

| Skill | What it does |
|---|---|
| [`card-news`](skills/card-news) | Lays out card news in one HTML file, shoots each card as a PNG, then checks for what breaks on a phone |
| [`html-shorts`](skills/html-shorts) | Shoots HTML scenes frame by frame into a 1080×1920 vertical video and a cover image |

**Check**

| Skill | What it does |
|---|---|
| [`vibe-app-checkup`](skills/vibe-app-checkup) | Sweeps an app built with AI coding tools for exposed keys, open database rules and payment checks, and writes a risk report with a grade |
| [`anti-slop`](skills/anti-slop) | Measures the "AI look" of a screen and rewrites stacked effects and stock phrases as "do this instead" |
| [`page-shots`](skills/page-shots) | Shoots every page at desktop and phone width, and catches pages that scroll sideways, 404s and broken images |
| [`ko-copy-lint`](skills/ko-copy-lint) | Finds exaggeration (최고 · 100% · 보장), clichés and banned words in Korean copy and suggests sentences to use instead |
| [`ai-before-after`](skills/ai-before-after) | Runs the same samples before and after a prompt or model change and compares them in a table |

**Ways of working**

| Skill | What it does |
|---|---|
| [`solo-dev-kit`](skills/solo-dev-kit) | Sets up a session-start summary, a pre-push check and a work log (`/record`) in your project |
| [`kakao-notify`](skills/kakao-notify) | Messages your KakaoTalk "chat with myself" when a long task ends or Claude is waiting for permission (macOS) |
| [`one-box-server`](skills/one-box-server) | Runs several apps and their databases on one server, with deploys, backups, restore drills and rollbacks |

## Install

You need Node 18 or later. The skills that take screenshots (card-news, html-shorts, page-shots, anti-slop) need Chrome and Playwright, and the shorts skill also needs ffmpeg.

```sh
git clone https://github.com/Stophyuk/solutionzip-skills.git
cd solutionzip-skills
npm i                      # just playwright

# copy only the skills you want into Claude Code
mkdir -p ~/.claude/skills
cp -r skills/card-news skills/page-shots ~/.claude/skills/
```

Then just ask: "make card news about …", "check whether this app is safe to make public", "capture every page", "add KakaoTalk notifications". Claude first shows what it will do, one line per step, and goes ahead once you agree.

## What the skills hold to

- No unverified numbers, superlatives or guarantees, and the same goes for the reports and copy the skills write.
- Keys and passwords never appear on screen. The checkup skill shows only the first few characters of a key it finds.
- Anything that changes a production server or database is explained first and done only after you answer.
- Taking part is never made a condition, as in "follow us to get it" (Meta's spam policy).
- Realistic AI-made images and voices get the AI label switched on when they are posted.

Checklists: [card news](skills/card-news/checklist.md) · [shorts](skills/html-shorts/checklist.md) · [app checkup](skills/vibe-app-checkup/checklist.md) · [AI look](skills/anti-slop/checklist.md) · [copy](skills/ko-copy-lint/rules.md)

## Stuck on a project?

Run the skills over it, and if it needs more hands, write to us at [solutionzip.kr](https://solutionzip.kr) (the site is in Korean). We pick up stalled projects and finish them.

## License

MIT. Commercial use is fine.
