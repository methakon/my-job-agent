import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ApplicationRepository } from './application.repository';
import { LeadRepository } from '../leads/lead.repository';
import { EmailTrackerService } from './email-tracker.service';

/** Minimal markdown → HTML renderer for the visa guide. No external deps.
 *  Handles: h1/h2/h3, paragraphs, unordered/ordered lists, tables, code
 *  fences, inline code, bold, italic, and horizontal rules.
 */
function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  let fenceClass = '';
  let codeStart = 0;

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const flushList = (listLines: string[], ordered: boolean) => {
    if (!listLines.length) return '';
    const tag = ordered ? 'ol' : 'ul';
    const items = listLines
      .map((l) => {
        const m = l.match(/^(\s*[-*\d.]\s+)(.*)$/s);
        const text = m ? m[2] : l;
        return '<li>' + inlineMd(esc(text)) + '</li>';
      })
      .join('');
    return `<${tag}>${items}</${tag}>`;
  };

  const inlineMd = (s: string) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (line.startsWith('```')) {
      if (inFence) {
        out.push('<pre><code>' + esc(lines.slice(codeStart, i).join('\n')) + '</code></pre>');
        inFence = false;
      } else {
        inFence = true;
        codeStart = i + 1;
      }
      i++;
      continue;
    }
    if (inFence) { i++; continue; }

    // horizontal rule
    if (/^[\s]*[-*_]{3,}[\s]*$/.test(line)) {
      out.push('<hr style="border:none;border-top:1px solid var(--line);margin:24px 0">');
      i++;
      continue;
    }

    // heading 1
    const h1m = line.match(/^#\s+(.+)$/);
    if (h1m) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push('<h1>' + inlineMd(esc(h1m[1])) + '</h1>');
      i++;
      continue;
    }
    const h2m = line.match(/^##\s+(.+)$/);
    if (h2m) {
      out.push('<h2>' + inlineMd(esc(h2m[1])) + '</h2>');
      i++;
      continue;
    }
    const h3m = line.match(/^###\s+(.+)$/);
    if (h3m) {
      out.push('<h3>' + inlineMd(esc(h3m[1])) + '</h3>');
      i++;
      continue;
    }

    // table row
    if (line.startsWith('|')) {
      const cells = line.split('|').filter((c, idx, arr) => {
        if (idx === 0 || idx === arr.length - 1) return false;
        return c.trim().length > 0 || (idx > 0 && arr[idx - 1].trim().length > 0);
      }).map((c) => c.trim());
      // skip separator row (|---|---|)
      if (cells.every((c) => /^[\s:-]+$/.test(c))) { i++; continue; }
      const tag = 'td';
      out.push(
        '<table><tr>' +
          cells.map((c) => `<${tag}>${inlineMd(esc(c))}</${tag}>`).join('') +
          '</tr></table>'
      );
      i++;
      continue;
    }

    // empty line = paragraph boundary
    if (line.trim() === '') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }

    // list item
    const listM = line.match(/^(\s*)[-*\d.]\s+(.*)$/s);
    if (listM) {
      const indent = listM[1].length;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(/^(\s*)[-*\d.]\s+(.*)$/s);
        if (m && m[1].length <= indent && l.trim().length > 0) {
          items.push(l);
          i++;
        } else break;
      }
      out.push(flushList(items, false));
      continue;
    }

    // ordered list
    const ordM = line.match(/^(\s*)\d+\.\s+(.*)$/s);
    if (ordM) {
      const indent = ordM[1].length;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(/^(\s*)\d+\.\s+(.*)$/s);
        if (m && m[1].length <= indent && l.trim().length > 0) {
          items.push(l);
          i++;
        } else break;
      }
      out.push(flushList(items, true));
      continue;
    }

    // paragraph (everything else non-empty)
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && !lines[i].startsWith('|') && !/^[\s]*[-*_]{3,}/.test(lines[i]) && !/^(\s*)[-*\d.]\s+/.test(lines[i]) && !/^(\s*)\d+\.\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      const text = paraLines.join(' ').replace(/\s+/g, ' ').trim();
      out.push('<p>' + inlineMd(esc(text)) + '</p>');
    }
  }

  return out.join('\n');
}

@Controller('visa-guide')
export class VisaGuidePageController {
  constructor(
    private readonly appRepo: ApplicationRepository,
    private readonly leadRepo: LeadRepository,
    private readonly emailTracker: EmailTrackerService,
  ) {}

  @Get()
  async page(@Res() res: Response) {
    const guidePath = path.join(process.cwd(), 'VISA_SPONSORED_JOBS_GUIDE.md');
    const raw = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';

    // live DB stats
    const apps = await this.appRepo.findRecent(500);
    const leads = await this.leadRepo.findRecent(500);
    const submitted = apps.filter((a) => a.status === 'submitted').length;
    const failed = apps.filter((a) => a.status === 'failed').length;
    const needsInfo = apps.filter((a) => a.status === 'needs_info').length;
    const sandbox = apps.filter((a) => a.status === 'sandboxed').length;

    // split guide into head (metadata) + body at first --- hr
    const parts = raw.split(/\n---\n/);
    const head = parts[0] || '';
    const body = parts.slice(1).join('\n---\n');

    const guideHtml = mdToHtml(body);

    const badge = (label: string, cls: string) =>
      `<span class="badge ${cls}">${esc2(label)}</span>`;

    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>my-job-agent — Visa-Sponsored Jobs Guide</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--line:#2a2e38;--fg:#e8eaed;--dim:#9aa0aa;--ok:#3fb96f;--warn:#e0a83c;--bad:#e05c5c;--accent:#5b8cff}
body{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;padding:24px;max-width:960px;margin:auto}
a{color:var(--accent)}
.masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.masthead h1{font-size:24px;margin:0}
.meta{color:var(--dim);font-size:13px}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:90px;text-align:center}
.stat b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.stat small{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:var(--line);color:var(--dim);display:inline-block}
.badge.submitted{background:rgba(63,185,111,.18);color:var(--ok)}
.badge.failed{background:rgba(224,92,92,.18);color:var(--bad)}
.badge.needs_info{background:rgba(224,168,60,.18);color:var(--warn)}
.badge.sandboxed{background:rgba(154,160,170,.18);color:var(--dim)}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:13px}
td,th{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--card);color:var(--dim);font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
pre{background:var(--bg);padding:10px;border-radius:8px;overflow:auto;font:13px/1.5 system-ui;color:#c9ced6;white-space:pre-wrap}
code{font:13px/1.5 system-ui;color:#e0a83c;background:rgba(224,168,60,.1);padding:1px 4px;border-radius:4px}
pre code{background:none;padding:0;color:inherit}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:18px;margin:28px 0 8px;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:18px 0 4px;color:var(--accent)}
p{margin:6px 0}
ul,ol{margin:4px 0 12px 20px}
li{margin:3px 0}
hr{margin:20px 0}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
.toc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:16px 0}
.toc h3{margin-top:0}
.toc ul{margin:4px 0;padding-left:18px}
.toc li{margin:3px 0}
.focus{background:rgba(91,140,255,.08);border:1px solid rgba(91,140,255,.25);border-radius:10px;padding:12px 16px;margin:14px 0;font-size:14px}
.focus b{color:var(--accent)}
</style></head><body>
<div class="masthead">
  <div>
    <h1>📋 Visa-Sponsored Jobs Guide</h1>
    <div class="meta">Swarna Sekhar Dhar · Full-stack React/Node.js/TypeScript · 8+ yrs · Indian national · Updated 2026-08-31</div>
  </div>
  <div class="stats">
    <div class="stat"><b>${submitted}</b><small>submitted</small></div>
    <div class="stat"><b>${failed}</b><small>failed</small></div>
    <div class="stat"><b>${needsInfo}</b><small>needs info</small></div>
    <div class="stat"><b>${sandbox}</b><small>sandboxed</small></div>
    <div class="stat"><b>${leads.length}</b><small>leads</small></div>
  </div>
</div>
<div class="stats" style="margin-bottom:20px">
  <span class="badge submitted">${submitted} submitted</span>
  <span class="badge failed">${failed} failed</span>
  <span class="badge needs_info">${needsInfo} needs_info</span>
  <span class="badge sandboxed">${sandbox} sandboxed</span>
  <span class="badge">${leads.length} leads</span>
</div>
${guideHtml}
<div class="footer">
  <a href="/">← dashboard</a> · <a href="/applications-page">applications</a> · <a href="/docs">swagger</a><br>
  Page served live from <code>VISA_SPONSORED_JOBS_GUIDE.md</code> — edits to that file show up here on refresh.
</div>
</body></html>`);
  }
}

function esc2(s: string): string {
  return String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
}
