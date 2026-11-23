/**
 * A self-contained HTML report: one file, inline CSS, no scripts, no external URLs.
 * Screenshots and diff images are embedded as data: URIs so it works offline and can be
 * attached or moved anywhere.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isFooter, type ReportFinding, type ScopedReport } from './model.js';
import { scopeLine } from './terminal.js';
import { agree, plural } from '../plural.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Images larger than this are not embedded (the path is shown instead). */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

async function dataUri(root: string, rel: string | undefined): Promise<string | null> {
  if (!rel) return null;
  try {
    const buf = await readFile(path.join(root, rel));
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3df;--card:#fff;--red:#b42318;--red-bg:#fdecea;--amber:#9a6700;--amber-bg:#fff6dc;--green:#1a7f37;--blue:#2f5fb3;--chip:#f1f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#a3a29d;--line:#2e2d2a;--card:#1e1e1c;--red:#ff7b72;--red-bg:#3a1714;--amber:#e3b341;--amber-bg:#33280e;--green:#56d364;--blue:#79a6ff;--chip:#262624}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h2 .n{color:var(--muted);font-weight:400}
.meta{color:var(--muted);font-size:13px}
.summary{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:18px 0}
.summary.bad{border-color:var(--red);background:var(--red-bg)}
.summary p{margin:2px 0;font-weight:600}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.cmd{display:inline-block;background:var(--chip);border-radius:6px;padding:2px 8px}
.f{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.f.regression{border-left-color:var(--red)}
.f.change{border-left-color:var(--amber)}
.f.fixed{border-left-color:var(--green)}
.f .t{font-weight:600;overflow-wrap:anywhere}
.f .why{color:var(--muted);font-size:13px;margin-top:2px;overflow-wrap:anywhere}
.chips{margin-top:4px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:0 8px;font-size:12px;margin:2px 4px 0 0;color:var(--muted)}
.sev-critical,.sev-high{color:var(--red)}.sev-medium{color:var(--amber)}
pre{background:var(--chip);border-radius:6px;padding:8px 10px;overflow:auto;font-size:12px;margin:8px 0 0;max-height:320px}
ul.notes{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--muted)}
.imgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px}
.imgs figure{margin:0}
.imgs figcaption{font-size:12px;color:var(--muted)}
.imgs img{width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
details>summary{cursor:pointer;font-weight:600;margin:10px 0}
.empty{color:var(--muted)}
table.probes{border-collapse:collapse;width:100%;font-size:13px}
table.probes td{border-top:1px solid var(--line);padding:4px 8px 4px 0;vertical-align:top}
`;

async function findingHtml(root: string, f: ReportFinding): Promise<string> {
  const chips: string[] = [`<span class="chip">${esc(f.probe)}</span>`, `<span class="chip sev-${f.severity}">${esc(f.severity)}</span>`];
  for (const p of f.pages ?? []) chips.push(`<span class="chip">page ${esc(p)}</span>`);
  for (const r of f.routes ?? []) chips.push(`<span class="chip">route ${esc(r)}</span>`);
  for (const t of f.tables ?? []) chips.push(`<span class="chip">table ${esc(t)}</span>`);
  if (f.viewports?.length) chips.push(`<span class="chip">${esc(f.viewports.join(', '))}</span>`);
  let body = '';
  if (f.kind === 'regression' && f.detail) body += `<pre>${esc(f.detail.split('\n').slice(-40).join('\n'))}</pre>`;
  const notes = f.notes.filter((n) => !/^(before|after|diff):/.test(n));
  if (notes.length) body += `<ul class="notes">${notes.map((n) => `<li class="mono">${esc(n)}</li>`).join('')}</ul>`;
  if (f.images) {
    const figs: string[] = [];
    for (const which of ['before', 'after', 'diff'] as const) {
      const rel = f.images[which];
      if (!rel) continue;
      const uri = await dataUri(root, rel);
      figs.push(
        uri
          ? `<figure><img alt="${which} screenshot" src="${uri}"><figcaption>${which} · ${esc(rel)}</figcaption></figure>`
          : `<figure><figcaption>${which}: ${esc(rel)} (not embedded)</figcaption></figure>`,
      );
    }
    if (figs.length) body += `<div class="imgs">${figs.join('')}</div>`;
  }
  return `<div class="f ${esc(f.kind)}" id="${esc(f.id)}"><div class="t">${esc(f.title)}</div><div class="why">why: ${esc(f.reason)}</div><div class="chips">${chips.join('')}</div>${body}</div>`;
}

export async function renderHtml(r: ScopedReport, root: string): Promise<string> {
  const main = r.findings.filter((f) => !isFooter(f));
  const section = async (title: string, list: ReportFinding[], cls: string) =>
    `<section class="${cls}"><h2>${esc(title)} <span class="n">(${list.length})</span></h2>${list.length ? (await Promise.all(list.map((f) => findingHtml(root, f)))).join('') : '<p class="empty">Nothing here.</p>'}</section>`;

  const outside = main.filter((f) => f.scope === 'outside-scope');
  const broken = main.filter((f) => f.scope === 'broken-by-task');
  const ripple = main.filter((f) => f.scope === 'expected-ripple');
  const inScope = main.filter((f) => f.scope === 'in-scope');
  const inRegs = inScope.filter((f) => f.kind === 'regression');
  const inRest = inScope.filter((f) => f.kind !== 'regression');
  const footer = r.findings.filter(isFooter);

  let inHtml = `<section class="in-scope"><h2>In the task area <span class="n">(${inScope.length})</span></h2>`;
  if (inRegs.length) inHtml += (await Promise.all(inRegs.map((f) => findingHtml(root, f)))).join('');
  if (inRest.length) {
    inHtml += `<details><summary>${plural(inRest.length, 'change')} in the task area</summary>${(await Promise.all(inRest.map((f) => findingHtml(root, f)))).join('')}</details>`;
  }
  if (!inScope.length) inHtml += '<p class="empty">Nothing here.</p>';
  inHtml += '</section>';

  let footerHtml = '';
  if (footer.length) {
    footerHtml = `<section class="footer"><details><summary>Also: ${plural(footer.length, 'fixed, already-failing or informational item')}</summary>${(await Promise.all(footer.map((f) => findingHtml(root, f)))).join('')}</details></section>`;
  }
  const own = r.ownOutputs.excluded.length
    ? `<p class="meta">${plural(r.ownOutputs.excluded.length, 'file')} written by your own checks during <code>holdline before</code> ${agree(r.ownOutputs.excluded.length, 'was', 'were')} not counted as agent changes. Add to .gitignore: ${r.ownOutputs.gitignoreSuggestion.map((l) => `<code>${esc(l)}</code>`).join(' ')}</p>`
    : '';
  const probes = `<h2>Checked</h2><table class="probes">${r.probes.map((p) => `<tr><td>${esc(p.title)}</td><td>${esc(p.summary)}</td></tr>`).join('')}</table>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>holdline report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>holdline report</h1>
<div class="meta">Task: <strong>${esc(r.task)}</strong></div>
<div class="meta">Snapshot ${esc(r.snapshots.before.slice(0, 10))} · ${esc(r.sessionCreatedAt)} → ${esc(r.createdAt)}</div>
<div class="meta">Scope: ${esc(scopeLine(r))}</div>
${r.headMoved ? `<div class="meta">HEAD moved during the task: ${esc(String(r.headMoved.from).slice(0, 10))} → ${esc(String(r.headMoved.to).slice(0, 10))}</div>` : ''}
<div class="summary${r.regressed ? ' bad' : ''}">${r.summary.map((l) => `<p>${esc(l)}</p>`).join('')}<div class="meta">Undo everything: <span class="cmd mono">${esc(r.rollbackCommand)}</span></div></div>
${await section('Outside the task', outside, 'outside-scope')}
${await section("Broken by the task's changes", broken, 'broken-by-task')}
${await section('Expected ripple', ripple, 'expected-ripple')}
${inHtml}
${footerHtml}
${own}
${probes}
</main>
</body>
</html>
`;
}
