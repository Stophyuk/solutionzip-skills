#!/bin/bash
# Commit stats per repo for the last N days (read-only). Usage: git_stats.sh OUT_DIR [DAYS=30]
OUT="$1"; DAYS="${2:-30}"; mkdir -p "$OUT/git"
# repos: every git repo directly under ~ and ~/clients (override with REPOS="a b c", paths relative to ~)
REPOS="${REPOS:-$(cd "$HOME" && for g in ./*/.git ./clients/*/.git; do [ -e "$g" ] && dirname "${g#./}"; done)}"
for r in $REPOS; do
  d="$HOME/$r"; [ -d "$d/.git" ] || continue
  # skip repos with no commits in the window
  [ -n "$(git -C "$d" log --since="$DAYS days ago" --all -1 --format=%h 2>/dev/null)" ] || continue
  git -C "$d" log --since="$DAYS days ago" --all --no-merges --format='%h%x09%ad%x09%s' --date=format:'%Y-%m-%d %H:%M' --shortstat > "$OUT/git/${r//\//_}.log" 2>/dev/null
  python3 -I - "$OUT/git/${r//\//_}.log" "$r" <<'EOF'
import sys,re,collections
path,repo=sys.argv[1],sys.argv[2]
commits=[];cur=None
for line in open(path):
    line=line.rstrip('\n')
    if not line: continue
    if '\t' in line and re.match(r'^[0-9a-f]{7,}\t',line):
        h,dt,s=line.split('\t',2); cur=dict(h=h,dt=dt,s=s,ins=0,dele=0,files=0); commits.append(cur)
    elif cur and 'changed' in line:
        m=re.search(r'(\d+) files? changed',line); cur['files']=int(m.group(1)) if m else 0
        m=re.search(r'(\d+) insertion',line); cur['ins']=int(m.group(1)) if m else 0
        m=re.search(r'(\d+) deletion',line); cur['dele']=int(m.group(1)) if m else 0
types=collections.Counter();
for c in commits:
    m=re.match(r'^(\w+)(\(|:|!)',c['s']); types[m.group(1) if m else 'other']+=1
fix=[c for c in commits if c['s'].startswith('fix')]
rev=[c for c in commits if 'revert' in c['s'].lower() or '되돌' in c['s']]
big=sorted(commits,key=lambda c:-(c['ins']+c['dele']))[:3]
days=collections.Counter(c['dt'][:10] for c in commits)
ko=sum(1 for c in commits if re.search('[가-힣]',c['s']))
hours=collections.Counter(int(c['dt'][11:13]) for c in commits)
night=sum(v for h,v in hours.items() if h<6)
# fix chains: fix commits within 60 min after a feat touching same day
print(f"{repo}: {len(commits)}커밋 · 활동일 {len(days)} · 유형 {dict(types.most_common(8))} · fix비율 {len(fix)*100//max(1,len(commits))}% · 되돌림 {len(rev)} · 한글제목 {ko*100//max(1,len(commits))}% · 0~6시 {night} · 평균 +{sum(c['ins'] for c in commits)//max(1,len(commits))}/-{sum(c['dele'] for c in commits)//max(1,len(commits))} · 최대일 {days.most_common(1)}")
EOF
done
