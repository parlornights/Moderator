import { html } from 'hono/html';

import type { Finding, IntegrityRow } from './integrity';

const page = (title: string, body: unknown) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        body { font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 16px; color: #1d1d1f; background: #fff; }
        pre, textarea { font: 12px/1.45 ui-monospace, monospace; background: #f5f5f7; border-radius: 6px; padding: 10px; overflow-x: auto; width: 100%; box-sizing: border-box; }
        .finding { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 12px 0; }
        button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 0; background: #0a7d32; color: #fff; cursor: pointer; margin-right: 8px; }
        button.reject { background: #b3261e; }
        .muted { color: #6e6e73; }
        @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } pre, textarea { background: #1c1c1e; color: #eee; } .finding { border-color: #333; } .muted { color: #999; } }
      </style>
    </head>
    <body>
      ${body}
    </body>
  </html>`;

export const setupPage = (org: string, manifest: object) =>
  page(
    'Create Moderator GitHub App',
    html`<h1>Create Moderator's GitHub App</h1>
      <p>One click creates the App in <b>${org}</b> with the permissions Moderator needs: read pull requests and code, write commit statuses.</p>
      <form action="https://github.com/organizations/${org}/settings/apps/new" method="post">
        <input type="hidden" name="manifest" value="${JSON.stringify(manifest)}" />
        <button type="submit">Create GitHub App</button>
      </form>`,
  );

export const createdPage = (app: { id: number; slug: string; pem: string; webhook_secret: string; html_url: string }) =>
  page(
    'Moderator GitHub App created',
    html`<h1>App created: ${app.slug}</h1>
      <p>Two steps, then Moderator posts <code>test-integrity</code> on every PR.</p>
      <h2>1. Paste these three secrets</h2>
      <p class="muted">Cloudflare dashboard → Workers &amp; Pages → moderator → Settings → Variables and Secrets → Add, type <b>Secret</b>. This page shows them only now.</p>
      <p><b>GITHUB_APP_ID</b></p>
      <pre>${app.id}</pre>
      <p><b>GITHUB_WEBHOOK_SECRET</b></p>
      <pre>${app.webhook_secret}</pre>
      <p><b>GITHUB_PRIVATE_KEY</b></p>
      <textarea rows="10" readonly>${app.pem}</textarea>
      <h2>2. Install it</h2>
      <p><a href="https://github.com/apps/${app.slug}/installations/new">Install ${app.slug}</a> on the repositories Moderator should check.</p>`,
  );

export const approvePage = (row: IntegrityRow, findings: Finding[]) =>
  page(
    `test-integrity ${row.repo}#${row.pr}`,
    html`<h1>${row.repo} #${row.pr}</h1>
      <p><a href="https://github.com/${row.repo}/pull/${row.pr}">${row.title}</a></p>
      <p class="muted">Commit ${row.sha.slice(0, 12)} · ticket ${row.issue ?? 'none named'} · ${row.decided_by ? `${row.state} by ${row.decided_by}` : row.state}</p>
      ${row.reason ? html`<p>Reason given: ${row.reason}</p>` : ''}
      ${findings.length ? '' : html`<p>Nothing flagged.</p>`}
      ${findings.map(
        (f) => html`<div class="finding">
          <p><b>${f.file}</b> <span class="muted">(${f.status}${f.p === null ? '' : `, sanctioned p=${f.p}`})</span></p>
          <p>${f.reason}</p>
          ${f.patch ? html`<pre>${f.patch}</pre>` : ''}
        </div>`,
      )}
      ${row.state === 'approved' || row.state === 'success'
        ? ''
        : html`<form method="post">
            <p><label for="reason">Reason for the agent (optional, posted on the PR when you reject)</label></p>
            <textarea id="reason" name="reason" rows="3"></textarea>
            <p>
              <button type="submit" name="decision" value="approve">Approve</button>
              <button type="submit" name="decision" value="reject" class="reject">Reject</button>
            </p>
            <p class="muted">Either decision holds for ${row.sha.slice(0, 12)} only; a new push is checked again.</p>
          </form>`}`,
  );
