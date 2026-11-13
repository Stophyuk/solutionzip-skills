#!/usr/bin/env python3
"""Analyze ~/.claude/history.jsonl (user prompts). Usage: parse_history.py OUT_DIR [DAYS=30]"""
import json, sys, os, re, collections, datetime

OUT = sys.argv[1]
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 30
SINCE = (datetime.datetime.now() - datetime.timedelta(days=DAYS)).timestamp() * 1000
SECRET_RE = re.compile(r'(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|\d{6}-[1-4]\d{6})')

rows = []
seen = set()
for l in open(os.path.expanduser('~/.claude/history.jsonl'), encoding='utf-8', errors='replace'):
    try:
        d = json.loads(l)
    except Exception:
        continue
    ts = int(d.get('timestamp') or 0)
    if ts < SINCE:
        continue
    disp = d.get('display') or ''
    key = (d.get('sessionId'), disp)
    dup = key in seen
    seen.add(key)
    pc = d.get('pastedContents')
    if isinstance(pc, str):
        try:
            pc = json.loads(pc)
        except Exception:
            pc = {}
    rows.append(dict(ts=ts, dt=datetime.datetime.fromtimestamp(ts / 1000), text=SECRET_RE.sub('<SECRET>', disp),
                     project=(d.get('project') or '').replace(os.path.expanduser('~'), '~'), session=d.get('sessionId'),
                     pasted=len(pc or {}), dup=dup))

uniq = [r for r in rows if not r['dup']]
print('rows', len(rows), 'unique', len(uniq))

GROUP_DEPTH = int(os.environ.get('HARNESS_GROUP_DEPTH', '1'))  # folders below home that name a project

def proj_group(p):
    if p in ('~', ''):
        return '홈(~)'
    parts = p.split('/')[1:]
    # ~/clients/x, ~/archive/x, ~/Desktop/<a>/<b>: keep one more level
    depth = GROUP_DEPTH + (1 if parts[0] in ('clients', 'archive') else 0) + (2 if parts[0] == 'Desktop' else 0)
    return '/'.join(parts[:depth])

stats = collections.defaultdict(collections.Counter)
by_month_proj = collections.defaultdict(collections.Counter)
hours = collections.Counter(); weekdays = collections.Counter()
lens = []
slash = collections.Counter()
for r in uniq:
    g = proj_group(r['project'])
    m = r['dt'].strftime('%Y-%m')
    by_month_proj[m][g] += 1
    hours[r['dt'].hour] += 1
    weekdays[r['dt'].strftime('%a')] += 1
    lens.append(len(r['text']))
    t = r['text'].strip()
    if t.startswith('/'):
        slash[t.split()[0]] += 1

# correction / friction markers (Korean)
MARKERS = {
    '부정·교정': r'(아니[야요,\s]|아닌데|그게 아니|틀렸|잘못|이상해|이상한데|왜 이렇|왜 또|왜 안)',
    '반복 지적': r'(또 |다시 말하|몇 번|계속 |아직도|여전히|말했잖|했잖아|하라고 했)',
    '금지': r'(하지 ?마|빼줘|빼고|없애|넣지 ?마|쓰지 ?마|금지)',
    '되돌림': r'(되돌|원래대로|롤백|revert|이전으로|원복)',
    '디자인 불만': r'(AI ?티|밤티|촌스|구려|별로|안 예|안예|못생|조잡|정보 ?밀집|복잡해)',
    '확인 요청': r'(확인해|검토해|체크해|점검해|봐줘)',
    '기억 요청': r'(기억해|메모리|잊지 ?마|다음부터|앞으로는|항상 )',
    '병렬·자동화': r'(병렬|동시에|에이전트|서브에이전트|워크플로|자동으로|크론|매일|loop)',
    '배포': r'(배포|deploy|푸시|push|커밋)',
}
mk = collections.Counter(); mk_samples = collections.defaultdict(list)
for r in uniq:
    for k, pat in MARKERS.items():
        if re.search(pat, r['text']):
            mk[k] += 1
            if len(mk_samples[k]) < 40:
                mk_samples[k].append(f"[{r['dt']:%m-%d} {proj_group(r['project'])}] {r['text'][:220]}".replace('\n', ' ⏎ '))

# sessions per day, prompts per session (history sessionId)
sess = collections.defaultdict(list)
for r in uniq:
    sess[r['session']].append(r)
sess_len = sorted((len(v) for v in sess.values()), reverse=True)
sess_span = []
for sid, v in sess.items():
    span = (v[-1]['dt'] - v[0]['dt']).total_seconds() / 3600
    sess_span.append((span, len(v), proj_group(v[0]['project']), sid))
sess_span.sort(reverse=True)
days = collections.Counter(r['dt'].date() for r in uniq)
active_days = len(days)

summary = dict(
    total_rows=len(rows), unique=len(uniq), by_month={m: sum(c.values()) for m, c in sorted(by_month_proj.items())},
    by_month_proj={m: dict(c.most_common()) for m, c in sorted(by_month_proj.items())},
    hours=dict(sorted(hours.items())), weekdays=dict(weekdays), median_len=sorted(lens)[len(lens) // 2], mean_len=sum(lens) / len(lens),
    long_prompts=sum(1 for x in lens if x > 500), very_long=sum(1 for x in lens if x > 2000), pasted=sum(1 for r in uniq if r['pasted']),
    slash=dict(slash.most_common(40)), markers=dict(mk), sessions=len(sess), prompts_per_session_top=sess_len[:20],
    sessions_over_1day=sum(1 for s in sess_span if s[0] > 24), sessions_over_1week=sum(1 for s in sess_span if s[0] > 168),
    longest_sessions=[(round(s[0], 1), s[1], s[2], s[3][:8]) for s in sess_span[:15]], active_days=active_days,
    prompts_per_active_day=round(len(uniq) / active_days, 1),
)
json.dump(summary, open(os.path.join(OUT, 'history_summary.json'), 'w'), ensure_ascii=False, indent=1, default=str)
with open(os.path.join(OUT, 'history_markers.md'), 'w') as f:
    for k, v in mk_samples.items():
        f.write(f"## {k} ({mk[k]})\n" + '\n'.join('- ' + x for x in v) + '\n\n')

# full prompt dump per project group (chronological) for reviewers
os.makedirs(os.path.join(OUT, 'prompts'), exist_ok=True)
groups = collections.defaultdict(list)
for r in uniq:
    groups[proj_group(r['project'])].append(r)
for g, v in groups.items():
    name = re.sub(r'[^\w가-힣().-]', '_', g)
    with open(os.path.join(OUT, 'prompts', f'{name}.md'), 'w') as f:
        f.write(f"# {g} — 내 입력 {len(v)}건\n\n")
        last_sid = None
        for r in v:
            if r['session'] != last_sid:
                f.write(f"\n### 세션 {r['session'][:8]} ({r['project']})\n")
                last_sid = r['session']
            p = f" [붙여넣기 {r['pasted']}]" if r['pasted'] else ''
            f.write(f"- {r['dt']:%m-%d %H:%M}{p} {r['text'][:1500]}".replace('\n', ' ⏎ ') + '\n')
print(json.dumps({k: v for k, v in summary.items() if k not in ('by_month_proj',)}, ensure_ascii=False, default=str, indent=0)[:4000])
