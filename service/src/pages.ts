import { html, raw } from 'hono/html';

import type { Finding, IntegrityRow } from './integrity';

const STYLE = raw(`
:root {
  --bg: #f6f7f9; --card: #fff; --text: #16181d; --muted: #6b7280; --line: #e5e7eb;
  --green: #15803d; --green-bg: #ecfdf3; --red: #b42318; --red-bg: #fef3f2; --amber: #b54708; --amber-bg: #fffaeb;
  --code-bg: #f9fafb; --add: #e6ffec; --del: #ffebe9; --accent: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --card: #161b22; --text: #e6edf3; --muted: #8b949e; --line: #30363d;
    --green: #3fb950; --green-bg: #0f2a19; --red: #f85149; --red-bg: #2d1214; --amber: #d29922; --amber-bg: #2b2111;
    --code-bg: #0d1117; --add: #12261e; --del: #2d1517; --accent: #58a6ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 32px 16px 120px; }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
.brand { font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 20px; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 24px; }
.chip { font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 6px 9px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--muted); }
.badge { font-size: 12px; font-weight: 600; padding: 6px 10px; border-radius: 999px; }
.badge.ok { color: var(--green); background: var(--green-bg); } .badge.bad { color: var(--red); background: var(--red-bg); } .badge.wait { color: var(--amber); background: var(--amber-bg); }
.banner { display: flex; gap: 12px; align-items: flex-start; padding: 16px 18px; border-radius: 12px; margin: 0 0 24px; border: 1px solid transparent; }
.banner b { display: block; margin-bottom: 2px; } .banner p { margin: 0; color: var(--muted); }
.banner.ok { background: var(--green-bg); border-color: color-mix(in srgb, var(--green) 30%, transparent); }
.banner.bad { background: var(--red-bg); border-color: color-mix(in srgb, var(--red) 30%, transparent); }
.banner .icon { font-size: 20px; line-height: 1.2; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; margin: 0 0 16px; overflow: hidden; }
.card header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.card header code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.card .why { padding: 10px 16px; color: var(--muted); font-size: 14px; }
.p { font: 12px ui-monospace, monospace; white-space: nowrap; color: var(--red); }
pre.diff { margin: 0; padding: 8px 0; background: var(--code-bg); overflow-x: auto; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; border-top: 1px solid var(--line); }
pre.diff span { display: block; padding: 0 16px; white-space: pre; }
pre.diff .add { background: var(--add); } pre.diff .del { background: var(--del); } pre.diff .hunk { color: var(--muted); }
.decide { position: sticky; bottom: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.12); }
.decide label { font-size: 13px; color: var(--muted); }
textarea { width: 100%; margin: 6px 0 12px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; resize: vertical; min-height: 64px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
button { font: 600 14px/1 inherit; font-family: inherit; padding: 11px 18px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
button.approve { background: var(--green); color: #fff; } button.reject { background: transparent; color: var(--red); border-color: var(--red); }
button:hover { filter: brightness(1.08); }
.hint { font-size: 12px; color: var(--muted); margin-left: auto; }
.empty { padding: 28px; text-align: center; color: var(--muted); }
.secret { font: 12px ui-monospace, monospace; padding: 10px 12px; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; word-break: break-all; white-space: pre-wrap; }
.step { margin: 0 0 20px; } .step h2 { font-size: 15px; margin: 0 0 8px; }
`);

const page = (title: string, body: unknown) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        ${STYLE}
      </style>
    </head>
    <body>
      <main>
        <div class="brand">Moderator</div>
        ${body}
      </main>
    </body>
  </html>`;

export const setupPage = (org: string, manifest: object) =>
  page(
    'Create the Moderator GitHub App',
    html`<h1>Create Moderator's GitHub App</h1>
      <p class="why">One click creates the App in <b>${org}</b>. It can read pull requests and code, comment on pull requests, and write check runs.</p>
      <form action="https://github.com/organizations/${org}/settings/apps/new" method="post">
        <input type="hidden" name="manifest" value="${JSON.stringify(manifest)}" />
        <div class="actions"><button class="approve" type="submit">Create GitHub App</button></div>
      </form>`,
  );

export const createdPage = (app: { id: number; slug: string; pem: string; webhook_secret: string; html_url: string }) =>
  page(
    'Moderator GitHub App created',
    html`<h1>App created: ${app.slug}</h1>
      <div class="step">
        <h2>1. Paste these three secrets</h2>
        <p class="why">Cloudflare dashboard → Workers &amp; Pages → moderator → Settings → Variables and Secrets → Add, type Secret. This page shows them only now. The key can be pasted as one line.</p>
        <p><b>GITHUB_APP_ID</b></p>
        <div class="secret">${app.id}</div>
        <p><b>GITHUB_WEBHOOK_SECRET</b></p>
        <div class="secret">${app.webhook_secret}</div>
        <p><b>GITHUB_PRIVATE_KEY</b></p>
        <div class="secret">${app.pem}</div>
      </div>
      <div class="step">
        <h2>2. Install it</h2>
        <p><a href="https://github.com/apps/${app.slug}/installations/new">Install ${app.slug}</a> on the repositories Moderator should check.</p>
      </div>`,
  );

const diff = (patch: string) =>
  html`<pre class="diff">${patch.split('\n').map((l) => html`<span class="${l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}">${l || ' '}</span>`)}</pre>`;

const when = (iso: string | null) => (iso ? new Date(iso).toUTCString().replace(' GMT', ' UTC') : '');

/** `done`: the decision just made on this page, shown as its confirmation. */
export const approvePage = (row: IntegrityRow, findings: Finding[], done?: string) => {
  const decided = row.state === 'approved' || row.state === 'rejected';
  const badge =
    row.state === 'approved' || row.state === 'success'
      ? html`<span class="badge ok">${row.state === 'success' ? 'Passed' : 'Approved'}</span>`
      : row.state === 'rejected'
        ? html`<span class="badge bad">Rejected</span>`
        : html`<span class="badge wait">Needs your decision</span>`;
  const banner =
    row.state === 'approved'
      ? html`<div class="banner ok">
          <span class="icon">✓</span>
          <div><b>${done === 'approved' ? 'Approved.' : 'Approved'} The check is green for this commit.</b><p>By ${row.decided_by}, ${when(row.decided_at)}. A new push is checked again.</p></div>
        </div>`
      : row.state === 'rejected'
        ? html`<div class="banner bad">
            <span class="icon">✕</span>
            <div>
              <b>${done === 'rejected' ? 'Rejected.' : 'Rejected'} The check fails for this commit, and the PR has been told.</b>
              <p>By ${row.decided_by}, ${when(row.decided_at)}.${row.reason ? html` Reason: “${row.reason}”` : ' No reason given.'} A new push is checked again.</p>
            </div>
          </div>`
        : '';
  return page(
    `test-integrity · ${row.repo}#${row.pr}`,
    html`<h1><a href="https://github.com/${row.repo}/pull/${row.pr}">${row.title}</a></h1>
      <div class="meta">
        ${badge}<span class="chip">${row.repo} #${row.pr}</span><span class="chip">${row.sha.slice(0, 7)}</span><span class="chip">ticket ${row.issue ?? 'none'}</span>
      </div>
      ${banner}
      ${findings.length
        ? findings.map(
            (f) => html`<section class="card">
              <header><code>${f.file}</code>${f.p === null ? '' : html`<span class="p">sanctioned p=${f.p}</span>`}</header>
              <div class="why">${f.reason}</div>
              ${f.patch ? diff(f.patch) : ''}
            </section>`,
          )
        : html`<div class="card empty">Nothing was flagged on this commit.</div>`}
      ${decided || row.state === 'success'
        ? ''
        : html`<form class="decide" method="post">
            <label for="reason">Reason for the agent (optional; posted on the PR if you reject)</label>
            <textarea id="reason" name="reason" placeholder="e.g. Keep the exact total; fix the scoring instead."></textarea>
            <div class="actions">
              <button class="approve" type="submit" name="decision" value="approve">Approve</button>
              <button class="reject" type="submit" name="decision" value="reject">Reject</button>
              <span class="hint">Applies to ${row.sha.slice(0, 7)} only</span>
            </div>
          </form>`}`,
  );
};
