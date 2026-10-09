import { swaggerUI } from '@hono/swagger-ui';
import { Hono } from 'hono';
import { describeRoute, openAPIRouteHandler, validator } from 'hono-openapi';
import { bearerAuth } from 'hono/bearer-auth';
import { csrf } from 'hono/csrf';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'hono/utils/buffer';
import type { OpenAPIV3_1 } from 'openapi-types';
import { z } from 'zod';

import { accessEmail, type Verify } from './access';
import * as audit from './audit';
import type { Env } from './env';
import { appManifest, convertManifest, github, type GitHub } from './github';
import { branches, pushBody, pushHarness, type Branches } from './harness';
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
  /** Optional, so a test that does not move branches needs no fake. */
  branches?(env: Env): Branches;
}

export const realDeps: Deps = {
  jev: (env) => askJev(env.OPENROUTER_API_KEY),
  linear: (env) => linear(env.LINEAR_API_KEY),
  github,
  access: accessEmail,
  convertManifest: (code) => convertManifest(code),
  branches,
};

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

const issueBody = z.object({ id: z.uuid().optional(), team: z.string().min(1), title: z.string().min(1), description: z.string(), project: z.string().optional(), parent: z.string().optional() });
const patchBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  status: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  links: z.array(z.object({ url: z.url(), title: z.string().min(1) })).optional(),
});
const commentBody = z.object({ id: z.uuid().optional(), issue: z.string().min(1), body: z.string().min(1) });

const valid = <T extends z.ZodType>(target: 'json' | 'query', schema: T) =>
  validator(target, schema, (r, c) => (r.success ? undefined : c.json({ error: z.prettifyError(new z.ZodError(r.error as z.core.$ZodIssue[])) }, 400)));

const tool = (summary: string, description: string) => describeRoute({ tags: ['tools'], summary, description, security: [{ bearer: [] }] });
const owner = (summary: string, description: string) => describeRoute({ tags: ['owner pages (Cloudflare Access)'], summary, description, security: [] });

const LINEAR_OUTCOME =
  'Answers `{outcome: "done", id, url}`, or `{outcome: "ask_owner", reason: "jev_refused" | "jev_down", jev?}` and writes nothing. 404 when a team, project, status or label does not exist; 502 when Linear fails.';

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

  app.post('/github/webhook', describeRoute({ tags: ['GitHub'], summary: 'GitHub App webhook', description: 'pull_request events (opened, synchronize, reopened, ready_for_review, and edited when the base branch changed) run the test-integrity check run. Signed by GitHub with GITHUB_WEBHOOK_SECRET.', security: [] }), async (c) => {
    const body = await c.req.text();
    const signature = c.req.header('X-Hub-Signature-256');
    if (!signature || !(await deps.github(c.env).verifyWebhook(body, signature))) return c.json({ error: 'bad signature' }, 401);
    const event = JSON.parse(body) as integrity.PullRequestEvent & { action?: string };
    const rerun = PR_ACTIONS.has(event.action ?? '') || (event.action === 'edited' && event.changes?.base !== undefined);
    if (c.req.header('X-GitHub-Event') !== 'pull_request' || !rerun) return c.json({ ignored: true });
    const gh = deps.github(c.env);
    const run = integrity
      .check(c.env, { github: gh, linear: deps.linear(c.env), jev: deps.jev(c.env) }, event)
      .catch((err) => integrity.errored(c.env, gh, event, err))
      .catch((err) => console.error('test-integrity failed and could not report it', err));
    c.executionCtx.waitUntil(run);
    return c.json({ queued: true }, 202);
  });

  app.get('/github/setup', owner('Create the GitHub App', 'A one-click manifest form that creates Moderator\'s GitHub App.'), (c) => c.html(setupPage(c.env.GITHUB_ORG, appManifest(c.env.PUBLIC_URL))));

  app.get('/github/created', owner('GitHub App created', 'GitHub redirects here after creating the App; shows its secrets once.'), async (c) => {
    const code = c.req.query('code');
    if (!code) return c.text('Missing code', 400);
    return c.html(createdPage(await deps.convertManifest(code)));
  });

  app.get('/approve/:owner/:repo/:pr/:sha', owner('test-integrity findings', 'The flagged test hunks of one commit, with an Approve button.'), async (c) => {
    const row = await integrity.getRow(c.env.DB, { repo: `${c.req.param('owner')}/${c.req.param('repo')}`, pr: Number(c.req.param('pr')), sha: c.req.param('sha') });
    if (!row) return c.text('No test-integrity run for this commit', 404);
    return c.html(approvePage(row, JSON.parse(row.findings), c.req.query('done')));
  });

  app.post('/approve/:owner/:repo/:pr/:sha', owner('Approve or reject a commit', 'Form fields `decision` (approve | reject) and optional `reason`. Approve: the check turns green for this commit only. Reject: it fails and the App comments the reason on the PR.'), async (c) => {
    const row = await integrity.getRow(c.env.DB, { repo: `${c.req.param('owner')}/${c.req.param('repo')}`, pr: Number(c.req.param('pr')), sha: c.req.param('sha') });
    if (!row) return c.text('No test-integrity run for this commit', 404);
    const form = await c.req.parseBody();
    const decision = form.decision;
    if (decision !== 'approve' && decision !== 'reject') return c.text('decision must be approve or reject', 400);
    const reason = typeof form.reason === 'string' ? form.reason.slice(0, 2_000) : undefined;
    if (row.state === 'approved' || row.state === 'rejected') return c.redirect(c.req.path, 303);
    await integrity.decide(c.env, deps.github(c.env), row, { by: c.get('owner'), approve: decision === 'approve', reason });
    return c.redirect(`${c.req.path}?done=${decision === 'approve' ? 'approved' : 'rejected'}`, 303);
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

  app.post(
    '/tool/jev/:check',
    describeRoute({
      tags: ['tools'],
      summary: 'Run a Jev check',
      description: 'Answers `{outcome: "done", result}` or `{outcome: "not_run", reason: "jev_down"}`. The body depends on the check; each schema below is titled with its check name.',
      security: [{ bearer: [] }],
      parameters: [{ name: 'check', in: 'path', required: true, schema: { type: 'string', enum: Object.keys(checks) } }],
      requestBody: {
        required: true,
        // zod's JSON Schema is OpenAPI 3.1 schema; only its TypeScript types differ.
        content: { 'application/json': { schema: { oneOf: Object.entries(checks).map(([name, c]) => ({ title: name, ...z.toJSONSchema(c.input, { io: 'input' }) }) as OpenAPIV3_1.SchemaObject) } } },
      },
    }),
    async (c) => {
    const name = c.req.param('check');
    if (!Object.hasOwn(checks, name)) return c.json({ error: `unknown check ${name}` }, 404);
    const input = await c.req.json().catch(() => undefined);
    const parsed = checks[name as CheckName].input.safeParse(input);
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const result = await runCheck(deps.jev(c.env), name as CheckName, parsed.data);
    const response = result ? { outcome: 'done', result } : { outcome: 'not_run', reason: 'jev_down' };
    await audit.record(c.env.DB, { action: `jev/${name}`, input, jev: result, outcome: response.outcome, response });
    return c.json(response);
    },
  );

  app.post('/tool/linear/issue', tool('File a Linear issue', `Jev checks it is a product task with what done looks like. ${LINEAR_OUTCOME}`), valid('json', issueBody), async (c) => {
    const i = c.req.valid('json');
    return c.json(await gatedWrite(c.env, 'linear/issue', i, { check: 'linear-issue', text: { title: i.title, description: i.description } }, () => deps.linear(c.env).createIssue(i)));
  });

  app.patch('/tool/linear/issue/:id', tool('Update a Linear issue', `Jev checks only a changed title or description; status, priority, labels and links need no Jev. ${LINEAR_OUTCOME}`), valid('json', patchBody), async (c) => {
    const p = c.req.valid('json');
    const id = c.req.param('id');
    const changed = p.title !== undefined || p.description !== undefined;
    const gate = changed ? { check: 'linear-text' as const, text: { text: [p.title, p.description].filter((t) => t !== undefined).join('\n\n') } } : null;
    return c.json(await gatedWrite(c.env, 'linear/issue.update', { id, ...p }, gate, () => deps.linear(c.env).updateIssue(id, p)));
  });

  app.post('/tool/linear/comment', tool('Comment on a Linear issue', `Jev checks it is a settled product update. ${LINEAR_OUTCOME}`), valid('json', commentBody), async (c) => {
    const i = c.req.valid('json');
    return c.json(await gatedWrite(c.env, 'linear/comment', i, { check: 'linear-comment', text: { body: i.body } }, () => deps.linear(c.env).comment(i.issue, i.body, i.id)));
  });

  app.post(
    '/tool/harness/push',
    tool(
      'Move the default branch to a harness-only commit',
      'Body `{repo: "owner/name", sha, branch?}`: `sha` is pushed to the scratch branch `branch`, `harness/<short sha>`. The default branch\'s own `moderator.config.json` lists `directToMain` paths (an entry ending in `/` is a folder). ' +
        'Answers 200 `{outcome: "done", branch, sha, paths}` once Moderator\'s GitHub App moved the default branch to `sha` without forcing it, or when it is already there (`paths` empty); the scratch branch is then deleted while it still points at `sha`. ' +
        'Otherwise `{outcome: "refused", reason, paths?}` and nothing moves: 403 when the default branch\'s config is not valid JSON or lists no `directToMain`, when a changed or renamed-from path is outside it (`paths` lists them; those need a pull request, as does the config itself), or when a branch protection or ruleset refuses the App; ' +
        '404 when the App is not installed on the repo; 409 when `sha` is not a fast-forward of the default branch, or the branch moved meanwhile (merge it and push again); ' +
        '422 when the scratch branch is the default branch, or GitHub did not list every changed file. 501 when the service cannot move branches; 502 when GitHub fails. Every call is in the audit log.',
    ),
    valid('json', pushBody),
    async (c) => {
      if (!deps.branches) return c.json({ error: 'this service cannot move branches' }, 501);
      const input = c.req.valid('json');
      let r;
      try {
        r = await pushHarness(deps.branches(c.env), input);
      } catch (e) {
        await audit.record(c.env.DB, { action: 'harness/push', input, outcome: 'error', response: { error: String(e) } });
        throw e;
      }
      try {
        await audit.record(c.env.DB, { action: 'harness/push', input, outcome: r.body.outcome, response: r.body });
      } catch (e) {
        // The branch may already have moved; a 502 here would tell the caller it did not.
        console.error('audit insert failed', 'harness/push', e);
      }
      return c.json(r.body, r.status);
    },
  );

  app.get('/audit', tool('The audit log', 'Every tool call, webhook run and approval, newest first. Page back with `before=<id>`.'), valid('query', z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await audit.list(c.env.DB, q.limit, q.before));
  });

  app.get(
    '/openapi.json',
    openAPIRouteHandler(app, {
      documentation: {
        info: { title: 'Moderator', version: '1.0.0', description: 'Jev checks, Linear writes behind Jev, the audit log, and the test-integrity GitHub check.' },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'One of MODERATOR_API_KEYS' } } },
      },
      exclude: ['/openapi.json', '/docs'],
    }),
  );
  app.get('/docs', swaggerUI({ url: '/openapi.json' }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    return c.json({ error: err.message }, err instanceof NotFound ? 404 : 502);
  });

  return app;
}
