// moderator push-main: a harness-only commit reaches the default branch through Moderator's GitHub App, which checks
// every path against directToMain in the default branch's moderator.config.json. Anything else needs a pull request.

import { spawnSync } from 'node:child_process';

import { harness } from './api.js';
import { git, root } from './git.js';

/**
 * owner/name from a remote URL: https, ssh, scp-like (git@host:owner/name.git) or a proxy path ending in owner/name.
 * @param {string} url
 */
export function repoOf(url) {
  const m = url.trim().match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The default branch origin names (its HEAD), or null when origin cannot be read. */
function defaultBranch() {
  const out = git(['ls-remote', '--symref', 'origin', 'HEAD']);
  return out?.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? null;
}

/**
 * Checks the commit locally, pushes it to harness/<short sha> (never forced), and asks Moderator to move the default
 * branch to it. Prints the outcome; 0 when the branch moved, 1 when anything refused it.
 * @returns {Promise<number>}
 */
export async function pushMain() {
  const fail = (/** @type {string} */ why) => (console.log(`push-main: ${why}`), 1);
  if (git(['status', '--porcelain']) !== '') return fail('the working tree is not clean: commit or stash first, then push the commit');
  const remote = git(['remote', 'get-url', 'origin']);
  const repo = remote && repoOf(remote);
  if (!repo) return fail(`cannot read owner/name from the origin remote${remote ? ` (${remote})` : ''}`);
  const main = defaultBranch();
  if (!main) return fail("cannot read origin's default branch");
  if (git(['fetch', '-q', 'origin', main]) === null) return fail(`git fetch origin ${main} failed`);
  if (git(['merge-base', '--is-ancestor', `origin/${main}`, 'HEAD']) === null) return fail(`HEAD does not contain origin/${main}: merge origin/${main} first, then run push-main again`);
  const sha = /** @type {string} */ (git(['rev-parse', 'HEAD']));
  const scratch = `harness/${git(['rev-parse', '--short', 'HEAD'])}`;
  const push = spawnSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${scratch}`], { cwd: root(), encoding: 'utf8' });
  if (push.status !== 0) return fail(`git push to ${scratch} failed: ${push.stderr.trim()}`);
  const r = await harness.push({ repo, sha, branch: scratch });
  if (r.outcome === 'done') {
    console.log(`done: ${r.branch} is now ${sha.slice(0, 7)}${r.paths.length ? `\n${r.paths.map((/** @type {string} */ p) => `  ${p}`).join('\n')}` : ''}`);
    return 0;
  }
  console.log(`refused: ${r.reason}${r.paths?.length ? `\n${r.paths.map((/** @type {string} */ p) => `  ${p}`).join('\n')}` : ''}`);
  return 1;
}
