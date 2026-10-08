// The checkout the session works in: its root, git, and the branch.

import { execFileSync } from 'node:child_process';

/** @type {Map<string, string>} */
const roots = new Map();

/**
 * The repository root of the current directory (a worktree resolves to the worktree); the directory itself outside git.
 * @returns {string}
 */
export function root() {
  const cwd = process.cwd();
  let r = roots.get(cwd);
  if (r === undefined) {
    r = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
    roots.set(cwd, r);
  }
  return r;
}

/**
 * Run git and return its trimmed stdout, or null on any error.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function git(args, cwd = root()) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

export function branch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
}

/** @param {string} b */
export const isMainBranch = (b) => ['main', 'master', 'HEAD'].includes(b);
