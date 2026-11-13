import json, os, re, glob, collections, sys
src = open(os.path.join(os.path.dirname(__file__), 'parse_sessions.py')).read().replace('\nmain()\n', '\n')
g = {'__name__': 'x', '__file__': 'x'}
# Usage: cross_metrics.py OUT_DIR (temp files go to OUT_DIR/tmp)
sys.argv = ['x', os.path.join(sys.argv[1] if len(sys.argv) > 1 else '/tmp/harness-tune', 'tmp')]
exec(compile(src, 'parse_sessions', 'exec'), g)
parse_file = g['parse_file']; ROOT = g['ROOT']; proj_of = g['proj_of']
CORR = re.compile(r'(아니[야요,\s]|아닌데|그게 아니|틀렸|잘못|이상해|왜 이렇|왜 또|왜 안|또 |다시 말하|몇 번|아직도|여전히|말했잖|했잖아|하라고 했|하지 ?마|빼줘|원래대로|되돌)')
after_c = [0, 0]; normal = [0, 0]; pos = collections.defaultdict(lambda: [0, 0])
err_kinds = collections.Counter(); err_samples = collections.defaultdict(list)
eff_proj = collections.defaultdict(collections.Counter)
turn_len_tools = []
for path in sorted(glob.glob(os.path.join(ROOT, '*', '*.jsonl'))):
    st = parse_file(path)
    if not st or not st['first']: continue
    proj = proj_of(path)
    for k, v in st['efforts'].items(): eff_proj[proj][k] += v
    prev_comp = False
    for i, t in enumerate(st['turns']):
        if t['kind'] != 'prompt':
            prev_comp = t['compacted']; continue
        hit = 1 if CORR.search(t['text']) else 0
        b = after_c if prev_comp else normal
        b[0] += hit; b[1] += 1
        bucket = 'T1-10' if i < 10 else ('T11-30' if i < 30 else ('T31-60' if i < 60 else 'T61+'))
        pos[bucket][0] += hit; pos[bucket][1] += 1
        turn_len_tools.append(sum(t['tools'].values()))
        prev_comp = t['compacted']
    for e in st['error_samples']:
        el = e.lower()
        if 'exit code' in el or 'command failed' in el or 'error:' in el[:30]: k = 'bash 실패'
        elif 'not found' in el or 'no such file' in el or 'does not exist' in el: k = '파일/대상 없음'
        elif 'string to replace not found' in el or 'old_string' in el or 'has not been read' in el or 'modified since' in el: k = 'Edit 불일치·미독'
        elif 'timeout' in el or 'timed out' in el: k = '시간 초과'
        elif 'permission' in el or 'denied' in el or 'not allowed' in el or 'blocked' in el: k = '권한·차단'
        elif 'inputvalidation' in el or 'invalid' in el: k = '입력 형식'
        elif 'tab' in el and ('chrome' in el or 'extension' in el or 'browser' in el): k = '브라우저 확장'
        else: k = '기타'
        err_kinds[k] += 1
        if len(err_samples[k]) < 6: err_samples[k].append(e[:160].replace('\n', ' '))
print('교정 표현 비율 — 압축 직후 턴: %d/%d = %.1f%% · 그 외: %d/%d = %.1f%%' % (after_c[0], after_c[1], 100*after_c[0]/max(1,after_c[1]), normal[0], normal[1], 100*normal[0]/max(1,normal[1])))
print('세션 내 위치별 교정 비율:', {k: '%d/%d=%.1f%%' % (v[0], v[1], 100*v[0]/max(1,v[1])) for k, v in sorted(pos.items())})
tl = sorted(turn_len_tools); print('턴당 도구 호출 중앙값', tl[len(tl)//2], '상위10%', tl[int(len(tl)*.9)], '최대', tl[-1])
print('오류 유형(표본 기준):', err_kinds.most_common())
for k, v in err_samples.items(): print(' ', k, '|', ' || '.join(v[:3])[:400])
print('effort by project:', {k: dict(v) for k, v in eff_proj.items()})
