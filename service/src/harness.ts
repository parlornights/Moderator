import { App } from '@octokit/app';
import { z } from 'zod';

import type { Env } from './env';
import { pkcs8 } from './github';

/**
 * A repository's agent tooling reaching its default branch without a pull request. The agent merges the default branch
 * into its commit, pushes it to a scratch branch and calls `POST /tool/harness/push`. The default branch's own
 * `moderator.config.json` lists the paths that may go this way (`directToMain`), so widening the list needs a pull
 * request, and the config itself never goes this way. Every changed path, and every path a file was renamed from, must
 * be one of them, and the commit must be a fast-forward of the default branch. Moderator's GitHub App then moves the
 * branch without forcing it and deletes the scratch branch, only while it still points at the commit.
 */
export interface Branches {
  /** The App's installation on the repository, its default branch and that branch's tip; null when the App is not installed. */
  tip(owner: string, repo: string): Promise<{ installation: number; branch: string; sha: string } | null>;
  /** A file's text at `ref`, or null when it does not exist there. */
  file(installation: number, owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  /** How `head` stands to `base` (ahead, behind, diverged, identical), the paths it changes, and whether GitHub listed all of them (fails closed). */
  compare(installation: number, owner: string, repo: string, base: string, head: string): Promise<{ status: string; paths: string[]; complete: boolean }>;
  /**
   * Moves `branch` to `sha` only as a fast-forward: 'done'; 'moved' when it is no longer one (the branch moved
   * meanwhile); `{refused}` with GitHub's message when a branch protection or ruleset refuses it.
   */
  move(installation: number, owner: string, repo: string, branch: string, sha: string): Promise<'done' | 'moved' | { refused: string }>;
  /** The commit a branch points at, or null when it does not exist. */
  head(installation: number, owner: string, repo: string, branch: string): Promise<string | null>;
  /** Deletes a branch. */
  remove(installation: number, owner: string, repo: string, branch: string): Promise<void>;
}

export const pushBody = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
  sha: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
  /** The scratch branch the commit was pushed to; nothing else is ever deleted. */
  branch: z.string().regex(/^harness\/[0-9a-f]{7,40}$/, 'harness/<short sha>').optional(),
});
export type PushBody = z.infer<typeof pushBody>;

export type PushResult =
  | { status: 200; body: { outcome: 'done'; branch: string; sha: string; paths: string[] } }
  | { status: 403 | 404 | 409 | 422; body: { outcome: 'refused'; reason: string; paths?: string[] } };

const refused = (status: 403 | 404 | 409 | 422, reason: string, paths?: string[]): PushResult => ({ status, body: { outcome: 'refused', reason, ...(paths ? { paths } : {}) } });

const CONFIG = 'moderator.config.json';

/**
 * Whether a path is one of `direct`: an entry ending in `/` is a folder and takes everything under it, any other entry
 * is one file. The config itself never is, whatever it lists: widening it needs a pull request.
 */
export const isDirect = (path: string, direct: string[]) => path !== CONFIG && direct.some((d) => (d.endsWith('/') ? path.startsWith(d) : path === d));

function parse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function pushHarness(b: Branches, { repo, sha, branch: scratch }: PushBody): Promise<PushResult> {
  const [owner, name] = repo.split('/');
  const tip = await b.tip(owner, name);
  if (!tip) return refused(404, `Moderator's GitHub App is not installed on ${repo}`);
  if (scratch === tip.branch) return refused(422, `the scratch branch cannot be ${tip.branch} itself`);
  const config = parse(await b.file(tip.installation, owner, name, CONFIG, tip.sha));
  if (config === undefined) return refused(403, `${tip.branch}'s ${CONFIG} is not valid JSON`);
  const direct = z.object({ directToMain: z.array(z.string().min(1)).min(1) }).safeParse(config);
  if (!direct.success) return refused(403, `${tip.branch}'s ${CONFIG} lists no directToMain paths`);
  // Removes the scratch branch only while it still points at the commit; a failure leaves it, and the push stands.
  const cleanUp = async () => {
    if (!scratch) return;
    try {
      if ((await b.head(tip.installation, owner, name, scratch)) === sha) await b.remove(tip.installation, owner, name, scratch);
    } catch (e) {
      console.error('scratch branch not removed', scratch, e);
    }
  };
  const cmp = await b.compare(tip.installation, owner, name, tip.sha, sha);
  // Already there, as after a retry of a push that went through.
  if (cmp.status === 'identical') {
    await cleanUp();
    return { status: 200, body: { outcome: 'done', branch: tip.branch, sha, paths: [] } };
  }
  if (cmp.status !== 'ahead') return refused(409, `${sha.slice(0, 7)} is not a fast-forward of ${tip.branch} (${cmp.status}): merge origin/${tip.branch} into it and push again`);
  if (!cmp.complete) return refused(422, 'GitHub did not list every changed file, so the paths cannot all be checked');
  const outside = cmp.paths.filter((p) => !isDirect(p, direct.data.directToMain));
  if (outside.length) return refused(403, `outside ${tip.branch}'s directToMain paths: these need a pull request`, outside);
  const moved = await b.move(tip.installation, owner, name, tip.branch, sha);
  if (moved === 'moved') return refused(409, `${tip.branch} moved meanwhile: merge origin/${tip.branch} and push again`);
  if (moved !== 'done') return refused(403, `GitHub refused to move ${tip.branch}: ${moved.refused}`);
  await cleanUp();
  return { status: 200, body: { outcome: 'done', branch: tip.branch, sha, paths: cmp.paths } };
}

export function branches(env: Env): Branches {
  const app = new App({ appId: env.GITHUB_APP_ID, privateKey: pkcs8(env.GITHUB_PRIVATE_KEY ?? ''), webhooks: { secret: env.GITHUB_WEBHOOK_SECRET } });
  const kit = (installation: number) => app.getInstallationOctokit(installation);
  const status = (e: unknown) => (e as { status?: number }).status;
  return {
    async tip(owner, repo) {
      let installation: number;
      try {
        installation = (await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo })).data.id;
      } catch (e) {
        if (status(e) === 404) return null;
        throw e;
      }
      const o = await kit(installation);
      const branch = (await o.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
      const sha = (await o.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` })).data.object.sha;
      return { installation, branch, sha };
    },
    async file(installation, owner, repo, path, ref) {
      try {
        const { data } = await (await kit(installation)).request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref, headers: { accept: 'application/vnd.github.raw+json' } });
        return String(data);
      } catch (e) {
        if (status(e) === 404) return null;
        throw e;
      }
    },
    async compare(installation, owner, repo, base, head) {
      // per_page pages the commits; GitHub lists at most 300 files, on the first page.
      const { data } = await (await kit(installation)).request('GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${base}...${head}`, per_page: 100 });
      const files = data.files ?? [];
      return {
        status: data.status,
        paths: [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter((p): p is string => !!p)))],
        complete: data.files !== undefined && files.length < 300 && (files.length > 0 || data.status !== 'ahead'),
      };
    },
    async move(installation, owner, repo, branch, sha) {
      try {
        await (await kit(installation)).request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}`, sha, force: false });
        return 'done';
      } catch (e) {
        if (status(e) !== 422) throw e;
        // Not a fast-forward any more; any other 422 is a branch protection or ruleset, which waiting does not fix.
        const message = (e as { response?: { data?: { message?: string } } }).response?.data?.message ?? String(e);
        return /not a fast.forward/i.test(message) ? 'moved' : { refused: message };
      }
    },
    async head(installation, owner, repo, branch) {
      try {
        return (await (await kit(installation)).request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` })).data.object.sha;
      } catch (e) {
        if (status(e) === 404) return null;
        throw e;
      }
    },
    async remove(installation, owner, repo, branch) {
      await (await kit(installation)).request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}` });
    },
  };
}
