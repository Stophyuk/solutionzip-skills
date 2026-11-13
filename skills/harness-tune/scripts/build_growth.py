#!/usr/bin/env python3
"""Build the harness growth log (Markdown subset) into a reading-style HTML page and a PDF.
Usage: build_growth.py [SRC.md]   (default ~/harness-review/하네스_성장기록.md; writes .html and .pdf beside it)
Markdown subset: # ## ### headings, paragraphs, - and 1. lists, | tables |, **bold**, `code`, [text](url)."""
import os, re, sys, html, subprocess

here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/harness-review/하네스_성장기록.md')
base = os.path.splitext(src)[0]

def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'\[([^\]]+)\]\((https?://[^)\s]+)\)', r'<a href="\2">\1</a>', t)
    return t

def convert(md):
    out, para, lst, tbl = [], [], None, []
    def flush():
        nonlocal para, lst, tbl
        if para: out.append('<p>' + inline(' '.join(para)) + '</p>'); para = []
        if lst: out.append(f'<{lst[0]}>' + ''.join(f'<li>{inline(x)}</li>' for x in lst[1]) + f'</{lst[0]}>'); lst = None
        if tbl:
            rows = [r for r in tbl if not re.match(r'^\|\s*:?-', r)]
            cells = [[c.strip() for c in r.strip().strip('|').split('|')] for r in rows]
            head = '<tr>' + ''.join(f'<th>{inline(c)}</th>' for c in cells[0]) + '</tr>'
            body = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in cells[1:])
            out.append(f'<div class="tbl"><table><thead>{head}</thead><tbody>{body}</tbody></table></div>'); tbl = []
    for line in md.split('\n'):
        s = line.rstrip()
        m = re.match(r'^(#{1,3}) (.*)', s)
        if m:
            flush(); n = len(m.group(1)); out.append(f'<h{n}>{inline(m.group(2))}</h{n}>'); continue
        if s.startswith('|'):
            if para or lst: flush()
            tbl.append(s); continue
        m = re.match(r'^\s*(?:(-)|(\d+)\.) (.*)', s)
        if m:
            kind = 'ul' if m.group(1) else 'ol'
            if para or tbl or (lst and lst[0] != kind): flush()
            if not lst: lst = (kind, [])
            lst[1].append(m.group(3)); continue
        if not s.strip():
            flush(); continue
        if lst and line.startswith('  '):
            lst[1][-1] += ' ' + s.strip(); continue
        if lst or tbl: flush()
        para.append(s.strip())
    flush()
    return '\n'.join(out)

md = open(src, encoding='utf-8').read()
title = re.search(r'^# (.*)', md, re.M).group(1)
css = open(os.path.join(here, 'doc.css'), encoding='utf-8').read()
page = f'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap">
<style>{css}
@page {{ size: A4; margin: 18mm 16mm; }}
td:first-child {{ white-space: normal; min-width: 7em; }}
@media print {{ main {{ padding-block: 0; max-width: none; }} h2, h3 {{ break-after: avoid; }} h2 {{ margin-top: 48px; }} tr, pre {{ break-inside: avoid; }} }}
</style></head>
<body><main>
{convert(md)}
</main></body></html>
'''
open(base + '.html', 'w', encoding='utf-8').write(page)
# Playwright: $PLAYWRIGHT_MODULE, ~/tools/playwright, or the skills repo's own node_modules
cands = [os.environ.get('PLAYWRIGHT_MODULE', ''),
         os.path.expanduser('~/tools/playwright/node_modules/playwright/index.mjs'),
         os.path.join(here, '..', '..', '..', 'node_modules', 'playwright', 'index.mjs')]
mod = next((os.path.abspath(c) for c in cands if c and os.path.exists(c)), None)
if not mod:
    print('wrote', base + '.html', '(PDF skipped: playwright not found; npm i playwright or set PLAYWRIGHT_MODULE)'); sys.exit(0)
js = f"""
import {{ chromium }} from '{mod}';
const b = await chromium.launch(); const p = await b.newPage();
await p.goto('file://' + {repr(base + '.html')}, {{ waitUntil: 'networkidle' }});
await p.emulateMedia({{ media: 'print' }});
await p.pdf({{ path: {repr(base + '.pdf')}, format: 'A4', printBackground: true, preferCSSPageSize: true }});
await b.close();
"""
subprocess.run(['node', '--input-type=module', '-e', js], check=True)
print('wrote', base + '.html', 'and', base + '.pdf')
