#!/usr/bin/env python3
"""Redact secrets in Claude Code session logs (~/.claude/projects, paste-cache).
Usage: redact_transcripts.py           dry run, counts only
       redact_transcripts.py --apply  rewrite files in place (no backup, so no extra copy of the secrets)
What is masked:
  1. key-shaped secrets and resident numbers (same patterns as redact_history.py)
  2. every exact value found in the prompt history (original backup if history was already redacted)
  3. records that hold a secrets page (--marker TEXT, plus Notion pages that read like credential notes):
     masked whole, and every value-like token from them is also masked wherever else it appears
Files written to in the last 60 minutes (open sessions) are skipped; after closing every session, run again with --apply --all.
Never prints secret values."""
import os, re, sys, glob, time, json, shutil, collections

H = os.path.expanduser('~')
APPLY = '--apply' in sys.argv
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, 'redact_history.py'), encoding='utf-8').read().split('def run(')[0]
g = {}; exec(src, g)
PATTERNS, MASK = g['PATTERNS'], g['MASK']

# --- 2. exact values from the prompt history
import glob as _g
baks = sorted(_g.glob(os.path.expanduser(os.environ.get('REDACT_BACKUP_DIR', '~/.claude-redact-backup')) + '/history.before-redact-*.jsonl'))
hist = baks[0] if baks else H + '/.claude/history.jsonl'
values = set()
for line in open(hist, encoding='utf-8', errors='replace'):
    try: g['walk'](json.loads(line), collections.Counter(), values)
    except Exception: pass

# --- 3. Notion secrets page records
# Records that contain any of these strings (e.g. the title or id of a notes page where you keep secrets)
# are masked whole, and value-like tokens from them are masked everywhere. Set with --marker TEXT (repeatable).
PAGE_MARKERS = [sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == '--marker']
SECRET_WORDS = re.compile(r'비밀번호|비번|시크릿|secret|api ?key|복구 ?코드|keystore|키스토어|토큰|token', re.I)
VALUE_TOKEN = re.compile(r'[A-Za-z0-9_\-\.\+/!@#$%^&*~?]{8,120}')
HEXISH = re.compile(r'^[0-9a-f\-]{16,}$')
def is_secret_record(line):
    if '"tool_result"' not in line and '"toolUseResult"' not in line: return False
    if PAGE_MARKERS and any(m in line for m in PAGE_MARKERS): return True
    # Notion page bodies that look like credential notes
    return ('<page' in line and '<content>' in line and len(SECRET_WORDS.findall(line)) >= 3)
SYMBOLS = set('!@#$%^&*~?+')
def secret_like(t):
    """Keep only values that look like passwords or keys, not paths, slugs or IDs."""
    if re.search(r'A-Z|a-z|0-9', t): return False                       # regex character classes
    if '/' in t:
        return len(t) == 40 and not t.startswith('/') and '//' not in t   # AWS secret access key
    up, lo, dg = (any(c.isupper() for c in t), any(c.islower() for c in t), any(c.isdigit() for c in t))
    if any(c in SYMBOLS for c in t):
        return (up or lo) and dg                                           # password with symbols
    if len(t) >= 24:
        return sum((up, lo, dg)) >= 2 and not re.fullmatch(r'[a-z0-9]+(?:[-_.][a-z0-9]+)+', t)
    return len(t) >= 10 and up and lo and dg and not re.fullmatch(r'[A-Za-z]+[-_.]?[0-9]+', t)
def value_tokens(text):
    for t in VALUE_TOKEN.findall(text.replace('\\n', ' ').replace('\\t', ' ')):
        t = t.strip('.')
        if len(t) < 8 or t.startswith(('http', 'www.')) or HEXISH.match(t) or re.match(r'^\d{4}-\d{2}-\d{2}', t): continue
        if re.search(r'\.(com|kr|net|io|app|dev|org|so|md|png|jpg|html|json|ts|js|mjs|py|sh)\b', t): continue
        if secret_like(t): yield t

paths = glob.glob(H + '/.claude/projects/*/*.jsonl') + glob.glob(H + '/.claude/projects/*/*/subagents/*.jsonl') + \
        glob.glob(H + '/.claude/paste-cache/*')
page_lines = 0
for p in paths:
    if not p.endswith('.jsonl'): continue
    try:
        for line in open(p, encoding='utf-8', errors='replace'):
            if is_secret_record(line):
                page_lines += 1
                values.update(value_tokens(line))
    except Exception:
        pass

PLACEHOLDER = re.compile(r'x{4,}|your|example|placeholder|dummy|sample', re.I)
hist_text = open(hist, encoding='utf-8', errors='replace').read()
SECRET_SET = {v for v in values if len(v) >= 8 and MASK not in v and not PLACEHOLDER.search(v)
              and (v + '@') not in hist_text}  # e-mail local parts are not secrets
SECRET_SET |= {v.rstrip('=') for v in SECRET_SET if v.endswith('=') and len(v.rstrip('=')) >= 8}
LONGEST = max((len(v) for v in SECRET_SET), default=0)
TOKEN = re.compile(r'[A-Za-z0-9_\-\.\+/!@#$%^&*~?]{8,' + str(max(8, LONGEST)) + '}')

def mask_record(line):
    try:
        d = json.loads(line)
    except Exception:
        return MASK + '\n'
    def walk(o):
        if isinstance(o, str): return MASK if len(o) > 40 else o
        if isinstance(o, list): return [walk(x) for x in o]
        if isinstance(o, dict): return {k: (v if k in ('type', 'uuid', 'parentUuid', 'sessionId', 'timestamp', 'tool_use_id', 'id', 'role', 'cwd') else walk(v)) for k, v in o.items()}
        return o
    return json.dumps(walk(d), ensure_ascii=False, separators=(',', ':')) + '\n'

now = time.time(); cnt = collections.Counter(); changed = []; skipped = []
for p in paths:
    if not os.path.isfile(p): continue
    try:
        lines = open(p, encoding='utf-8', errors='surrogateescape').readlines()
    except Exception:
        continue
    c2 = collections.Counter(); out = []
    for line in lines:
        if p.endswith('.jsonl') and is_secret_record(line):
            out.append(mask_record(line)); c2['secret_page_record'] += 1; continue
        s = line
        for name, rx in PATTERNS:
            s, n = rx.subn(MASK, s)
            if n: c2[name] += n
        def tok_sub(m):
            t = m.group(0)
            if t in SECRET_SET or t.strip('.') in SECRET_SET:
                c2['known_value'] += 1; return MASK
            return t
        s = TOKEN.sub(tok_sub, s)
        out.append(s)
    if not c2: continue
    if now - os.path.getmtime(p) < 3600 and '--all' not in sys.argv:  # --all: every session is closed
        skipped.append(p); continue
    cnt.update(c2); changed.append(p)
    if APPLY:
        tmp = p + '.redacting'
        with open(tmp, 'w', encoding='utf-8', errors='surrogateescape') as f: f.writelines(out)
        shutil.copymode(p, tmp); os.replace(tmp, p)

verb = '가림' if APPLY else '가릴 것(바꾸지 않음)'
print(f'비밀값 페이지로 보이는 기록 {page_lines}줄, 거기서 모은 값과 입력 기록 값 {len(SECRET_SET)}개')
print(f'파일 {len(paths)}개 중 {len(changed)}개, {verb} {sum(cnt.values())}건: {dict(cnt)}')
if skipped:
    print(f'지금 열린 세션으로 보여 건너뛴 파일 {len(skipped)}개. 모든 세션을 닫은 뒤 --apply --all 로 한 번 더 실행하세요.')
