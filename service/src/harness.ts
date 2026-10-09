import { App } from '@octokit/app';
import { z } from 'zod';

import type { Env } from './env';
import { pkcs8 } from './github';

/**
 * A repository's agent tooling reaching its default branch without a pull request. The agent merges the default branch
 * into its commit, pushes it to a scratch branch and calls `POST /tool/harness/push`. The default branch's own
 * `moderator.config.json` lists the paths that may go this way (`directToMain`), so widening the list needs a pull
 * request. Every changed path, and every path a file was renamed from, must be one of them, and the commit must be a
 * fast-forward of the default branch. Moderator's GitHub App then moves the branch without forcing it and deletes the
 * scratch branch.
 */
export interface Branches {
  /** The App's installation on the repository, its default branch and that branch's tip; null when the App is not installed. */
  tip(owner: string, repo: string): Promise<{ installation: number; branch: string; sha: string } | null>;
  /** A file's text at `ref`, or null when it does not exist there. */
  file(installation: number, owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  /** How `head` stands to `base` (ahead, behind, diverged, identical), the paths it changes, and whether GitHub listed all of them. */
  compare(installation: number, owner: string, repo: string, base: string, head: string): Promise<{ status: string; paths: string[]; complete: boolean }>;
  /** Moves `branch` to `sha` only as a fast-forward; false when GitHub refuses (the branch moved meanwhile). */
  move(installation: number, owner: string, repo: string, branch: string, sha: string): Promise<boolean>;
  /** Deletes a branch. */
  remove(installation: number, owner: string, repo: string, branch: string): Promise<void>;
}

export const pushBody = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
  sha: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
  branch: z.string().min(1).optional(),
});
export type PushBody = z.infer<typeof pushBody>;

export type PushResult =
  | { status: 200; body: { outcome: 'done'; branch: string; sha: string; paths: string[] } }
  | { status: 403 | 404 | 409 | 422; body: { outcome: 'refused'; reason: string; paths?: string[] } };

const refused = (status: 403 | 404 | 409 | 422, reason: string, paths?: string[]): PushResult => ({ status, body: { outcome: 'refused', reason, ...(paths ? { paths } : {}) } });

/** Whether a path is one of `direct`: an entry ending in `/` is a folder and takes everything under it, any other entry is one file. */
export const isDirect = (path: string, direct: string[]) => direct.some((d) => (d.endsWith('/') ? path.startsWith(d) : path === d));

export async function pushHarness(b: Branches, { repo, sha, branch: scratch }: PushBody): Promise<PushResult> {
  const [owner, name] = repo.split('/');
  const tip = await b.tip(owner, name);
  if (!tip) return refused(404, `Moderator's GitHub App is not installed on ${repo}`);
  if (scratch === tip.branch) return refused(422, `the scratch branch cannot be ${tip.branch} itself`);
  const config = await b.file(tip.installation, owner, name, 'moderator.config.json', tip.sha);
  const direct = z.object({ directToMain: z.array(z.string().min(1)).min(1) }).safeParse(config === null ? null : JSON.parse(config));
  if (!direct.success) return refused(403, `${tip.branch}'s moderator.config.json lists no directToMain paths`);
  const cmp = await b.compare(tip.installation, owner, name, tip.sha, sha);
  if (cmp.status === 'identical') return refused(409, `${sha.slice(0, 7)} is already ${tip.branch}'s tip`);
  if (cmp.status !== 'ahead') return refused(409, `${sha.slice(0, 7)} is not a fast-forward of ${tip.branch} (${cmp.status}): merge origin/${tip.branch} into it and push again`);
  if (!cmp.complete) return refused(422, 'GitHub did not list every changed file, so the paths cannot all be checked');
  const outside = cmp.paths.filter((p) => !isDirect(p, direct.data.directToMain));
  if (outside.length) return refused(403, `outside ${tip.branch}'s directToMain paths: these need a pull request`, outside);
  if (!(await b.move(tip.installation, owner, name, tip.branch, sha))) return refused(409, `${tip.branch} moved meanwhile: merge origin/${tip.branch} and push again`);
  if (scratch) await b.remove(tip.installation, owner, name, scratch).catch((e) => console.error('scratch branch not removed', scratch, e));
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
      const { data } = await (await kit(installation)).request('GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${base}...${head}`, per_page: 300 });
      const files = data.files ?? [];
      return {
        status: data.status,
        paths: [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter((p): p is string => !!p)))],
        complete: files.length < 300,
      };
    },
    async move(installation, owner, repo, branch, sha) {
      try {
        await (await kit(installation)).request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}`, sha, force: false });
        return true;
      } catch (e) {
        if (status(e) === 422) return false;
        throw e;
      }
    },
    async remove(installation, owner, repo, branch) {
      await (await kit(installation)).request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${branch}` });
    },
  };
}
