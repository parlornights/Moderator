// GitHub, read with `gh api` (REST). A Claude Code cloud session cannot reach GitHub's GraphQL API, so `gh pr view`
// and the other GraphQL commands fail there; every lookup here is a REST route.

import { spawnSync } from 'node:child_process';

import { branch, git, root } from './git.js';

/**
 * owner/name of the origin remote: a github.com URL, or the cloud session's git proxy (`…/git/<owner>/<name>`); null
 * otherwise.
 * @param {string | null} [url]
 */
export function repoSlug(url = git(['remote', 'get-url', 'origin'])) {
  return (url || '').match(/(?:github\.com[/:]|\/git\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}

/**
 * `gh api <route>`, parsed. Never throws.
 * @param {string} route
 * @returns {{ ok: true, data: any } | { ok: false, why: string }}
 */
export function ghApi(route) {
  const r = spawnSync('gh', ['api', route], { cwd: root(), encoding: 'utf8', timeout: 10_000 });
  if (r.error) return { ok: false, why: 'gh not available' };
  if (r.status !== 0) return { ok: false, why: (r.stderr || '').trim().split('\n')[0].slice(0, 160) || `gh exited ${r.status}` };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, why: 'gh answered with no JSON' };
  }
}

/** @typedef {{ number: number, title: string, url: string, draft: boolean }} OpenPr */

/**
 * The open pull request whose head is `b` in the origin repository: `pr` is null when there is none. A failed lookup,
 * or several open PRs for one head, says why, so it is never read as "none" or as one of them.
 * @param {string} [b]
 * @returns {{ ok: true, pr: OpenPr | null, slug: string } | { ok: false, why: string }}
 */
export function openPr(b = branch()) {
  const slug = repoSlug();
  if (!slug) return { ok: false, why: 'origin is not a GitHub repository' };
  const r = ghApi(`repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${slug.split('/')[0]}:${b}`)}`);
  if (!r.ok) return r;
  const all = Array.isArray(r.data) ? r.data : [];
  if (all.length > 1) return { ok: false, why: `several open PRs for the branch: ${all.map((x) => `#${x.number}`).join(', ')}` };
  const p = all[0];
  return { ok: true, slug, pr: p ? { number: p.number, title: String(p.title || ''), url: p.html_url, draft: Boolean(p.draft) } : null };
}
