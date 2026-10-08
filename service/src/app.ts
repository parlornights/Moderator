import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'hono/utils/buffer';
import { z } from 'zod';

import { accessEmail, type Verify } from './access';
import * as audit from './audit';
import type { Env } from './env';
import { appManifest, convertManifest, github, type GitHub } from './github';
import * as integrity from './integrity';
import { askJev, checks, runCheck, type Ask, type CheckName } from './jev';
import { linear, NotFound, type Linear } from './linear';
import { approvePage, createdPage, setupPage } from './pages';

export interface Deps {
  jev(env: Env): Ask;
  linear(env: Env): Linear;
  github(env: Env): GitHub;
  access(env: Env): Verify;
  convertManifest(code: string): ReturnType<typeof convertManifest>;
}

export const realDeps: Deps = {
  jev: (env) => askJev(env.OPENROUTER_API_KEY),
  linear: (env) => linear(env.LINEAR_API_KEY),
  github,
  access: accessEmail,
  convertManifest: (code) => convertManifest(code),
};

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

const issueBody = z.object({ team: z.string().min(1), title: z.string().min(1), description: z.string(), project: z.string().optional(), parent: z.string().optional() });
const patchBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  status: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  links: z.array(z.object({ url: z.url(), title: z.string().min(1) })).optional(),
});
const commentBody = z.object({ issue: z.string().min(1), body: z.string().min(1) });

const valid = <T extends z.ZodType>(target: 'json' | 'query', schema: T) =>
  zValidator(target, schema, (r, c) => (r.success ? undefined : c.json({ error: z.prettifyError(r.error) }, 400)));

export function createApp(deps: Deps = realDeps) {
  const app = new Hono<{ Bindings: Env; Variables: { owner: string } }>();

  const apiKey = bearerAuth({
      verifyToken: async (token, c) => {
        const keys = ((c.env as Env).MODERATOR_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        const matches = await Promise.all(keys.map((k) => timingSafeEqual(k, token)));
        return matches.includes(true);
      },
  });
  app.use('/tool/*', apiKey);
  app.use('/audit', apiKey);

  /** Pages for the owner only: Cloudflare Access stands in front of them, and its token is checked here too. */
  const ownerOnly = createMiddleware<{ Bindings: Env; Variables: { owner: string } }>(async (c, next) => {
    const email = await deps.access(c.env)(c.req.raw);
    if (!email) return c.text('Forbidden: sign in through Cloudflare Access', 403);
    c.set('owner', email);
    await next();
  });
  app.use('/approve/*', ownerOnly, csrf());
  app.use('/github/setup', ownerOnly);
  app.use('/github/created', ownerOnly);

  app.post('/github/webhook', async (c) => {
    const body = await c.req.text();
    const signature = c.req.header('X-Hub-Signature-256');
    if (!signature || !(await deps.github(c.env).verifyWebhook(body, signature))) return c.json({ error: 'bad signature' }, 401);
    const event = JSON.parse(body) as integrity.PullRequestEvent & { action?: string };
    if (c.req.header('X-GitHub-Event') !== 'pull_request' || !PR_ACTIONS.has(event.action ?? '')) return c.json({ ignored: true });
    const run = integrity.check(c.env, { github: deps.github(c.env), linear: deps.linear(c.env), jev: deps.jev(c.env) }, event).catch((e) => console.error('test-integrity failed', e));
    c.executionCtx.waitUntil(run);
    return c.json({ queued: true }, 202);
  });

  app.get('/github/setup', (c) => c.html(setupPage(c.env.GITHUB_ORG, appManifest(c.env.PUBLIC_URL))));

  app.get('/github/created', async (c) => {
    const code = c.req.query('code');
    if (!code) return c.text('Missing code', 400);
    return c.html(createdPage(await deps.convertManifest(code)));
  });

  app.get('/approve/:owner/:repo/:sha', async (c) => {
    const row = await integrity.getRow(c.env.DB, `${c.req.param('owner')}/${c.req.param('repo')}`, c.req.param('sha'));
    if (!row) return c.text('No test-integrity run for this commit', 404);
    return c.html(approvePage(row, JSON.parse(row.findings)));
  });

  app.post('/approve/:owner/:repo/:sha', async (c) => {
    const row = await integrity.getRow(c.env.DB, `${c.req.param('owner')}/${c.req.param('repo')}`, c.req.param('sha'));
    if (!row) return c.text('No test-integrity run for this commit', 404);
    await integrity.approve(c.env, deps.github(c.env), row, c.get('owner'));
    return c.redirect(c.req.path, 303);
  });

  /**
   * A Linear write behind a Jev check. Jev passes: the write is done. Jev refuses or does not answer: nothing is
   * written and the caller is told to ask the owner, who decides at the Linear connector's own prompt.
   */
  async function gatedWrite(env: Env, action: string, input: unknown, gate: { check: CheckName; text: unknown } | null, write: () => Promise<unknown>) {
    const jev = gate ? await runCheck(deps.jev(env), gate.check, gate.text) : undefined;
    let response: Record<string, unknown>;
    if (jev === null) response = { outcome: 'ask_owner', reason: 'jev_down' };
    else if (jev && !jev.pass) response = { outcome: 'ask_owner', reason: 'jev_refused', jev };
    else {
      try {
        response = { outcome: 'done', ...((await write()) as object) };
      } catch (e) {
        await audit.record(env.DB, { action, input, jev, outcome: 'error', response: { error: String(e) } });
        throw e;
      }
    }
    try {
      await audit.record(env.DB, { action, input, jev, outcome: String(response.outcome), response });
    } catch (e) {
      // The write already happened; a 502 here would make the caller retry it.
      console.error('audit insert failed', action, e);
    }
    return response;
  }

  app.post('/tool/jev/:check', async (c) => {
    const name = c.req.param('check');
    if (!Object.hasOwn(checks, name)) return c.json({ error: `unknown check ${name}` }, 404);
    const input = await c.req.json().catch(() => undefined);
    const parsed = checks[name as CheckName].input.safeParse(input);
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const result = await runCheck(deps.jev(c.env), name as CheckName, parsed.data);
    const response = result ? { outcome: 'done', result } : { outcome: 'not_run', reason: 'jev_down' };
    await audit.record(c.env.DB, { action: `jev/${name}`, input, jev: result, outcome: response.outcome, response });
    return c.json(response);
  });

  app.post('/tool/linear/issue', valid('json', issueBody), async (c) => {
    const i = c.req.valid('json');
    return c.json(await gatedWrite(c.env, 'linear/issue', i, { check: 'linear-issue', text: { title: i.title, description: i.description } }, () => deps.linear(c.env).createIssue(i)));
  });

  app.patch('/tool/linear/issue/:id', valid('json', patchBody), async (c) => {
    const p = c.req.valid('json');
    const id = c.req.param('id');
    const changed = p.title !== undefined || p.description !== undefined;
    const gate = changed ? { check: 'linear-text' as const, text: { text: [p.title, p.description].filter((t) => t !== undefined).join('\n\n') } } : null;
    return c.json(await gatedWrite(c.env, 'linear/issue.update', { id, ...p }, gate, () => deps.linear(c.env).updateIssue(id, p)));
  });

  app.post('/tool/linear/comment', valid('json', commentBody), async (c) => {
    const i = c.req.valid('json');
    return c.json(await gatedWrite(c.env, 'linear/comment', i, { check: 'linear-comment', text: { body: i.body } }, () => deps.linear(c.env).comment(i.issue, i.body)));
  });

  app.get('/audit', valid('query', z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await audit.list(c.env.DB, q.limit, q.before));
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    return c.json({ error: err.message }, err instanceof NotFound ? 404 : 502);
  });

  return app;
}
