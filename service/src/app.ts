import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { timingSafeEqual } from 'hono/utils/buffer';
import { z } from 'zod';

import * as audit from './audit';
import type { Env } from './env';
import { askJev, checks, runCheck, type Ask, type CheckName } from './jev';
import { linear, type Linear } from './linear';

export interface Deps {
  jev(env: Env): Ask;
  linear(env: Env): Linear;
}

export const realDeps: Deps = { jev: (env) => askJev(env.OPENROUTER_API_KEY), linear: (env) => linear(env.LINEAR_API_KEY) };

const issueBody = z.object({ team: z.string().min(1), title: z.string().min(1), description: z.string(), project: z.string().optional(), parent: z.string().optional() });
const patchBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  addLabels: z.array(z.string()).optional(),
  removeLabels: z.array(z.string()).optional(),
  links: z.array(z.object({ url: z.url(), title: z.string().min(1) })).optional(),
});
const commentBody = z.object({ issue: z.string().min(1), body: z.string().min(1) });

export function createApp(deps: Deps = realDeps) {
  const app = new Hono<{ Bindings: Env }>();

  app.use(
    '*',
    bearerAuth({
      verifyToken: async (token, c) => {
        const keys = ((c.env as Env).MODERATOR_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        const matches = await Promise.all(keys.map((k) => timingSafeEqual(k, token)));
        return matches.includes(true);
      },
    }),
  );

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
    await audit.record(env.DB, { action, input, jev, outcome: String(response.outcome), response });
    return response;
  }

  app.post('/tool/jev/:check', async (c) => {
    const name = c.req.param('check');
    if (!(name in checks)) return c.json({ error: `unknown check ${name}` }, 404);
    const input = await c.req.json().catch(() => undefined);
    const parsed = checks[name as CheckName].input.safeParse(input);
    if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
    const result = await runCheck(deps.jev(c.env), name as CheckName, parsed.data);
    const response = result ? { outcome: 'done', result } : { outcome: 'not_run', reason: 'jev_down' };
    await audit.record(c.env.DB, { action: `jev/${name}`, input, jev: result, outcome: response.outcome, response });
    return c.json(response);
  });

  app.post('/tool/linear/issue', zValidator('json', issueBody), async (c) => {
    const i = c.req.valid('json');
    return c.json(await gatedWrite(c.env, 'linear/issue', i, { check: 'linear-issue', text: { title: i.title, description: i.description } }, () => deps.linear(c.env).createIssue(i)));
  });

  app.patch('/tool/linear/issue/:id', zValidator('json', patchBody), async (c) => {
    const p = c.req.valid('json');
    const id = c.req.param('id');
    const text = [p.title, p.description].filter(Boolean).join('\n\n');
    const gate = text ? { check: 'linear-text' as const, text: { text } } : null;
    return c.json(await gatedWrite(c.env, 'linear/issue.update', { id, ...p }, gate, () => deps.linear(c.env).updateIssue(id, p)));
  });

  app.post('/tool/linear/comment', zValidator('json', commentBody), async (c) => {
    const i = c.req.valid('json');
    return c.json(await gatedWrite(c.env, 'linear/comment', i, { check: 'linear-comment', text: { body: i.body } }, () => deps.linear(c.env).comment(i.issue, i.body)));
  });

  app.get('/audit', zValidator('query', z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().optional() })), async (c) => {
    const q = c.req.valid('query');
    return c.json(await audit.list(c.env.DB, q.limit, q.before));
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err) }, 400);
    if ('getResponse' in err) return (err as { getResponse(): Response }).getResponse();
    return c.json({ error: err.message }, 502);
  });

  return app;
}
