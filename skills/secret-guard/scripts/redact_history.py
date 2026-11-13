#!/usr/bin/env python3
"""Redact secret values in ~/.claude/history.jsonl. Never prints secret values.
Usage: redact_history.py          dry run, counts only
       redact_history.py --apply  back up the original to $REDACT_BACKUP_DIR (default ~/.claude-redact-backup, mode 700), then redact in place
Keep the backup out of Claude's reach: add  Read(~/.claude-redact-backup/**)  to permissions.deny, and delete it once you are sure."""
import json, re, sys, os, shutil, collections

MASK = '«가림»'
PATTERNS = [
    ('anthropic', re.compile(r'sk-ant-[A-Za-z0-9_-]{20,}')),
    ('openai', re.compile(r'\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{24,}')),
    ('aws_id', re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b')),
    ('github', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})')),
    ('google', re.compile(r'\bAIza[0-9A-Za-z_-]{30,}')),
    ('slack', re.compile(r'\bxox[abposr]-[A-Za-z0-9-]{10,}')),
    ('apify', re.compile(r'\bapify_api_[A-Za-z0-9]{20,}')),
    ('private_key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}')),
    ('rrn', re.compile(r'\b\d{6}-[1-8]\d{6}\b')),
]
# value after an env-style secret name: FOO_SECRET=..., "api_key": "..."
ENV_RE = re.compile(r'(\b[A-Za-z][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|SERVICE_ROLE_KEY|_KEY)\b["\']?\s*[:=]\s*["\']?)([^\s"\'`,;]{8,})', re.I)
PW_RE = re.compile(r'((?:비밀번호|비번|패스워드|password|passwd|\bpw)\s*(?:[:=]|은|는)?\s*)([^\s가-힣\'"`]{6,64})', re.I)
# bare tokens introduced by a word: "키는 XXX", "token: XXX"
KEY_RE = re.compile(r'((?:api ?key|키|토큰|token|secret|시크릿)\s*(?:[:=]|은|는|:)?\s*)([A-Za-z0-9_\-\.]{16,})', re.I)
# random-looking token: 20+ chars with upper, lower and digit (applied only to strings that already held a secret)
RAND_RE = re.compile(r'(?<![A-Za-z0-9_\-])(?=[A-Za-z0-9_\-]*[A-Z])(?=[A-Za-z0-9_\-]*[a-z])(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{20,}(?![A-Za-z0-9_\-])')
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')

def redact(s, cnt, found=None):
    """Mask secrets in s. found (a set) collects the original values."""
    before = sum(cnt.values())
    def keep(v):
        if found is not None: found.add(v)
    for name, rx in PATTERNS:
        for m in rx.finditer(s): keep(m.group(0))
        s, n = rx.subn(MASK, s)
        if n: cnt[name] += n
    def env_sub(m):
        v = m.group(2)
        if v.startswith('«') or v.lower() in ('true', 'false', 'null', 'none') or v.startswith(('http://localhost', '$', '${', 'process.env')):
            return m.group(0)
        cnt['env_value'] += 1; keep(v)
        return m.group(1) + MASK
    s = ENV_RE.sub(env_sub, s)
    def pw_sub(m):
        v = m.group(2)
        if MASK in v or not (re.search(r'[A-Za-z]', v) and re.search(r'\d', v)):
            return m.group(0)
        cnt['password'] += 1; keep(v)
        return m.group(1) + MASK
    s = PW_RE.sub(pw_sub, s)
    def key_sub(m):
        v = m.group(2)
        if MASK in v or not (re.search(r'[A-Za-z]', v) and re.search(r'\d', v)):
            return m.group(0)
        cnt['keyword_token'] += 1; keep(v)
        return m.group(1) + MASK
    s = KEY_RE.sub(key_sub, s)
    if sum(cnt.values()) > before:
        def rand_sub(m):
            v = m.group(0)
            if UUID_RE.match(v): return v
            cnt['random_token'] += 1; keep(v)
            return MASK
        s = RAND_RE.sub(rand_sub, s)
    return s

def walk(o, cnt, found=None):
    if isinstance(o, str):
        return redact(o, cnt, found)
    if isinstance(o, list):
        return [walk(x, cnt, found) for x in o]
    if isinstance(o, dict):
        return {k: walk(v, cnt, found) for k, v in o.items()}
    return o


def run(src, dst=None):
    cnt = collections.Counter(); changed = 0; total = 0; out = []
    with open(src, encoding='utf-8', errors='surrogateescape') as f:
        for line in f:
            total += 1
            raw = line.rstrip('\n')
            try:
                d = json.loads(raw)
            except Exception:
                out.append(raw); continue
            c2 = collections.Counter()
            nd = walk(d, c2)
            if c2:
                changed += 1; cnt.update(c2)
                out.append(json.dumps(nd, ensure_ascii=False, separators=(',', ':')))
            else:
                out.append(raw)
    if dst:
        with open(dst, 'w', encoding='utf-8', errors='surrogateescape') as f:
            f.write('\n'.join(out) + '\n')
    return total, changed, cnt

H = os.path.expanduser('~/.claude/history.jsonl')
if '--apply' not in sys.argv:
    t, c, cnt = run(H)
    print(f'줄 {t}개 중 {c}개에 비밀값 {sum(cnt.values())}건 (바꾸지 않음): {dict(cnt)}')
    sys.exit(0)

import datetime
priv = os.path.expanduser(os.environ.get('REDACT_BACKUP_DIR', '~/.claude-redact-backup')); os.makedirs(priv, mode=0o700, exist_ok=True)
bak = os.path.join(priv, f'history.before-redact-{datetime.date.today():%Y%m%d}.jsonl')
if not os.path.exists(bak):
    shutil.copy2(H, bak)
tmp = H + '.redacting'
size0 = os.path.getsize(H)
t, c, cnt = run(H, tmp)
size1 = os.path.getsize(H)
if size1 != size0:
    # prompts appended meanwhile: redact the new tail and append it
    with open(H, 'rb') as f:
        f.seek(size0); extra = f.read()
    ex = tmp + '.extra'
    open(ex + '.src', 'wb').write(extra)
    run(ex + '.src', ex)
    with open(tmp, 'a', encoding='utf-8') as o:
        o.write(open(ex, encoding='utf-8').read())
    os.remove(ex); os.remove(ex + '.src')
shutil.copymode(H, tmp)
os.replace(tmp, H)
t2, c2, cnt2 = run(H)
print(f'가림 {sum(cnt.values())}건 완료. 남은 비밀값 {sum(cnt2.values())}건. 원본 백업: {bak}')
