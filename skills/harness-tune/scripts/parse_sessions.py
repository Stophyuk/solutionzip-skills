#!/usr/bin/env python3
"""Parse Claude Code transcripts into stats + compact per-session digests (read-only on sources)."""
import json, os, sys, glob, collections, re, datetime

ROOT = os.path.expanduser('~/.claude/projects')
OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, 'digests'), exist_ok=True)

SECRET_RE = re.compile(r'(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|\d{6}-[1-4]\d{6})')

def scrub(s):
    return SECRET_RE.sub('<SECRET>', s)

def text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict):
            if c.get('type') == 'text':
                out.append(c.get('text', ''))
            elif c.get('type') == 'tool_result':
                cc = c.get('content')
                out.append(text_of(cc) if not isinstance(cc, str) else cc)
    return '\n'.join(out)

def classify_user(d, txt):
    if d.get('isMeta'):
        return 'meta'
    t = txt.lstrip()
    if t.startswith('<command-name>') or t.startswith('<local-command'):
        return 'command'
    if t.startswith('<task-notification>'):
        return 'task-notification'
    if t.startswith('[Request interrupted by user'):
        return 'interrupt'
    if t.startswith('<system-reminder>') or t.startswith('Caveat:'):
        return 'meta'
    if 'This session is being continued from a previous conversation' in t[:300]:
        return 'compact-summary'
    return 'prompt'

def parse_file(path, is_sub=False):
    st = dict(path=path, prompts=[], tools=collections.Counter(), agents=[], skills=collections.Counter(),
              errors=0, error_samples=[], denials=0, denial_samples=[], interrupts=0, compactions=0,
              commands=collections.Counter(), models=collections.Counter(), efforts=collections.Counter(),
              sysub=collections.Counter(), hook_errors=0, first=None, last=None, cwd=None, title=None,
              cost=None, lines_added=0, lines_removed=0, entry=collections.Counter(), version=None,
              scheduled=0, bash_cmds=collections.Counter(), edited_files=collections.Counter(),
              turns=[], task_notifications=0, plan_mode=0, assistant_msgs=0)
    turn = None
    def new_turn(ts, txt, kind):
        return dict(ts=ts, kind=kind, text=txt, tools=collections.Counter(), agents=[], skills=[], errors=[], denials=[], final='', compacted=False)
    try:
        fh = open(path, encoding='utf-8', errors='replace')
    except Exception:
        return None
    for line in fh:
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get('type')
        ts = d.get('timestamp')
        if ts:
            st['first'] = st['first'] or ts
            st['last'] = ts
        if d.get('cwd') and not st['cwd']:
            st['cwd'] = d['cwd']
        if d.get('version'):
            st['version'] = d['version']
        if d.get('entrypoint'):
            st['entry'][d['entrypoint']] += 1
        if t == 'ai-title':
            st['title'] = d.get('aiTitle')
        elif t == 'cost-state':
            st['cost'] = dict(usd=d.get('totalCostUSD'), dur=d.get('totalDuration'), api=d.get('totalAPIDuration'),
                              models={k: {kk: v.get(kk) for kk in ('inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD')} for k, v in (d.get('modelUsage') or {}).items()})
            st['lines_added'] = d.get('totalLinesAdded') or 0
            st['lines_removed'] = d.get('totalLinesRemoved') or 0
        elif t == 'system':
            sub = d.get('subtype')
            st['sysub'][sub] += 1
            if sub == 'compact_boundary':
                st['compactions'] += 1
                if turn:
                    turn['compacted'] = True
            if sub == 'scheduled_task_fire':
                st['scheduled'] += 1
            if sub == 'stop_hook_summary' and d.get('hookErrors'):
                st['hook_errors'] += len(d.get('hookErrors') or [])
        elif t == 'attachment':
            a = d.get('attachment') or {}
            at = a.get('type')
            if at in ('hook_error', 'hook_non_blocking_error', 'hook_blocking_error'):
                st['hook_errors'] += 1
            if at == 'plan_mode':
                st['plan_mode'] += 1
        elif t == 'user':
            msg = d.get('message') or {}
            content = msg.get('content')
            if isinstance(content, list) and any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
                for c in content:
                    if not isinstance(c, dict) or c.get('type') != 'tool_result':
                        continue
                    ctext = text_of(c.get('content')) if not isinstance(c.get('content'), str) else c.get('content')
                    ctext = ctext or ''
                    if "doesn't want to proceed" in ctext or 'user declined' in ctext.lower() or 'rejected' in ctext[:200] and 'tool use was rejected' in ctext:
                        st['denials'] += 1
                        sample = scrub(ctext[:400])
                        if len(st['denial_samples']) < 15:
                            st['denial_samples'].append(sample)
                        if turn:
                            turn['denials'].append(sample[:300])
                    elif c.get('is_error'):
                        st['errors'] += 1
                        if len(st['error_samples']) < 25:
                            st['error_samples'].append(scrub(ctext[:200]))
                        if turn and len(turn['errors']) < 4:
                            turn['errors'].append(scrub(ctext[:160]))
                continue
            txt = text_of(content)
            kind = classify_user(d, txt)
            if kind == 'interrupt':
                st['interrupts'] += 1
                if turn:
                    turn.setdefault('interrupted', 0)
                    turn['interrupted'] += 1
                continue
            if kind == 'command':
                m = re.search(r'<command-name>([^<]+)</command-name>', txt)
                if m:
                    st['commands'][m.group(1).strip()] += 1
                    # slash commands that carry args are also user intent
                    am = re.search(r'<command-args>([^<]*)</command-args>', txt)
                    if am and am.group(1).strip():
                        if turn: st['turns'].append(turn)
                        turn = new_turn(ts, scrub(m.group(1).strip() + ' ' + am.group(1).strip()), 'command')
                continue
            if kind == 'task-notification':
                st['task_notifications'] += 1
                continue
            if kind in ('meta', 'compact-summary'):
                continue
            if is_sub and not st['prompts']:
                st['prompts'].append(dict(ts=ts, text=scrub(txt[:3000])))
                turn = new_turn(ts, scrub(txt[:3000]), 'task')
                continue
            st['prompts'].append(dict(ts=ts, text=scrub(txt[:4000]), src=d.get('promptSource')))
            if turn:
                st['turns'].append(turn)
            turn = new_turn(ts, scrub(txt[:4000]), 'prompt')
        elif t == 'assistant':
            st['assistant_msgs'] += 1
            msg = d.get('message') or {}
            if msg.get('model'):
                st['models'][msg['model']] += 1
            if d.get('effort'):
                st['efforts'][d['effort']] += 1
            for c in msg.get('content') or []:
                if not isinstance(c, dict):
                    continue
                if c.get('type') == 'tool_use':
                    name = c.get('name')
                    st['tools'][name] += 1
                    inp = c.get('input') or {}
                    if turn:
                        turn['tools'][name] += 1
                    if name in ('Agent', 'Task'):
                        a = dict(type=inp.get('subagent_type'), desc=inp.get('description'), model=inp.get('model'), bg=inp.get('run_in_background'), iso=inp.get('isolation'))
                        st['agents'].append(a)
                        if turn: turn['agents'].append(f"{a['type']}:{a['desc']}")
                    elif name == 'Skill':
                        st['skills'][inp.get('skill')] += 1
                        if turn: turn['skills'].append(inp.get('skill'))
                    elif name == 'Bash':
                        cmd = (inp.get('command') or '').strip().split('\n')[0]
                        head = ' '.join(cmd.split()[:2])[:40]
                        st['bash_cmds'][head] += 1
                    elif name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
                        fp = inp.get('file_path') or ''
                        st['edited_files'][fp] += 1
                    elif name == 'Workflow':
                        if turn: turn['agents'].append('WORKFLOW')
                elif c.get('type') == 'text' and turn is not None:
                    txt = c.get('text') or ''
                    if txt.strip():
                        turn['final'] = scrub(txt[-700:])
    if turn:
        st['turns'].append(turn)
    fh.close()
    return st

def proj_of(path):
    rel = os.path.relpath(path, ROOT)
    home_key = re.sub(r'[^A-Za-z0-9]', '-', os.path.expanduser('~'))
    return rel.split(os.sep)[0].replace(home_key, '') or '/home'

def jsonable(st):
    out = dict(st)
    for k, v in list(out.items()):
        if isinstance(v, collections.Counter):
            out[k] = dict(v.most_common())
    out['turns'] = len(st['turns'])
    out['prompts'] = len(st['prompts'])
    return out

def write_digest(st, proj, sid, sub_stats):
    p = os.path.join(OUT, 'digests', proj.strip('-/') or 'home')
    os.makedirs(p, exist_ok=True)
    lines = []
    cost = st['cost'] or {}
    lines.append(f"# session {sid} · {proj} · {st['title'] or ''}")
    lines.append(f"- 기간: {st['first']} → {st['last']} · v{st['version']} · 프롬프트 {len(st['prompts'])} · 압축 {st['compactions']} · 중단 {st['interrupts']} · 거부 {st['denials']} · 도구오류 {st['errors']} · API환산비용 ${(cost.get('usd') or 0):.2f} · +{st['lines_added']}/-{st['lines_removed']}줄")
    lines.append(f"- 도구 상위: {dict(st['tools'].most_common(12))}")
    lines.append(f"- 스킬: {dict(st['skills'])} · 커맨드: {dict(st['commands'])} · 모델: {dict(st['models'])} · effort: {dict(st['efforts'])}")
    if sub_stats:
        lines.append(f"- 서브에이전트 {len(sub_stats)}개: " + '; '.join(f"{s.get('agentType')}({s.get('tools_total')}도구,{s.get('dur_min')}분)" for s in sub_stats[:40]))
    lines.append('')
    for i, tn in enumerate(st['turns'], 1):
        tag = ' [압축발생]' if tn['compacted'] else ''
        tag += f" [중단x{tn.get('interrupted')}]" if tn.get('interrupted') else ''
        lines.append(f"## T{i} {tn['ts']}{tag}")
        lines.append('USER: ' + tn['text'].replace('\n', ' ⏎ ')[:2500])
        if tn['tools']:
            lines.append('  도구: ' + ', '.join(f"{k}x{v}" for k, v in tn['tools'].most_common(10)))
        if tn['agents']:
            lines.append('  에이전트: ' + ' | '.join(a for a in tn['agents'] if a)[:600])
        if tn['skills']:
            lines.append('  스킬: ' + ', '.join(s for s in tn['skills'] if s))
        if tn['denials']:
            lines.append('  거부/피드백: ' + ' || '.join(x.replace('\n', ' ') for x in tn['denials'])[:900])
        if tn['errors']:
            lines.append('  오류: ' + ' || '.join(x.replace('\n', ' ') for x in tn['errors'])[:500])
        if tn['final']:
            lines.append('  CLAUDE(끝): ' + tn['final'].replace('\n', ' ⏎ ')[:500])
        lines.append('')
    with open(os.path.join(p, f"{st['first'][:10] if st['first'] else 'x'}_{sid[:8]}.md"), 'w') as f:
        f.write('\n'.join(lines))

def main():
    sessions = []
    subs_all = []
    for path in sorted(glob.glob(os.path.join(ROOT, '*', '*.jsonl'))):
        proj = proj_of(path)
        sid = os.path.basename(path)[:-6]
        st = parse_file(path)
        if not st or not st['first']:
            continue
        sub_stats = []
        sdir = os.path.join(os.path.dirname(path), sid, 'subagents')
        for sp in sorted(glob.glob(os.path.join(sdir, '*.jsonl'))):
            ss = parse_file(sp, is_sub=True)
            if not ss or not ss['first']:
                continue
            meta = {}
            mp = sp[:-6] + '.meta.json'
            if os.path.exists(mp):
                try:
                    meta = json.load(open(mp))
                except Exception:
                    pass
            try:
                dur = (datetime.datetime.fromisoformat(ss['last'].replace('Z', '+00:00')) - datetime.datetime.fromisoformat(ss['first'].replace('Z', '+00:00'))).total_seconds() / 60
            except Exception:
                dur = None
            rec = dict(session=sid, project=proj, agentType=meta.get('agentType') or meta.get('subagent_type'), meta=meta,
                       task=(ss['prompts'][0]['text'][:400] if ss['prompts'] else ''), tools_total=sum(ss['tools'].values()),
                       tools=dict(ss['tools'].most_common(8)), errors=ss['errors'], models=dict(ss['models']),
                       dur_min=round(dur, 1) if dur is not None else None, first=ss['first'], cost=(ss['cost'] or {}).get('usd'))
            sub_stats.append(rec)
            subs_all.append(rec)
        write_digest(st, proj, sid, sub_stats)
        rec = jsonable(st)
        rec.update(session=sid, project=proj, subagents=len(sub_stats))
        rec.pop('error_samples', None)
        rec['error_samples'] = st['error_samples'][:10]
        sessions.append(rec)
    json.dump(sessions, open(os.path.join(OUT, 'sessions.json'), 'w'), ensure_ascii=False, indent=1, default=str)
    json.dump(subs_all, open(os.path.join(OUT, 'subagents.json'), 'w'), ensure_ascii=False, indent=1, default=str)
    print('sessions', len(sessions), 'subagents', len(subs_all))

main()
