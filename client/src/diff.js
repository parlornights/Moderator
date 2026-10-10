// What changed against the base: files, line counts, the package each file belongs to, and a hash of the tree.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { git, root } from './git.js';

/** The task's own ledger never counts as a change: the hooks commit it on every stop. */
const NOT_WORK = ['--', '.', ':(exclude).work'];

/**
 * Files changed against base: commits since the merge base, staged and unstaged edits, untracked files. Deleted
 * files are included (a deleted test is a scope fact).
 * @param {string} base
 */
export function changedFiles(base) {
  const mergeBase = git(['merge-base', base, 'HEAD']);
  const set = new Set();
  /** @param {string | null} out */
  const add = (out) => (out || '').split('\n').filter(Boolean).forEach((f) => set.add(f));
  if (mergeBase) add(git(['diff', '--name-only', '--diff-filter=ACMRD', mergeBase, 'HEAD', ...NOT_WORK]));
  add(git(['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD', ...NOT_WORK]));
  add(untracked().join('\n'));
  return { files: [...set].sort(), mergeBase };
}

/**
 * Added and removed lines per file: commits since the merge base, working-tree edits, and untracked files (every
 * line added).
 * @param {string | null} mergeBase
 * @returns {{ file: string, added: number, removed: number }[]}
 */
export function lineCounts(mergeBase) {
  const numstat = [mergeBase ? git(['diff', '--numstat', mergeBase, 'HEAD', ...NOT_WORK]) : null, git(['diff', '--numstat', 'HEAD', ...NOT_WORK])].filter(Boolean).join('\n');
  const out = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [a, d, file] = line.split('\t');
      return { file, added: Number(a) || 0, removed: Number(d) || 0 };
    });
  for (const file of untracked()) {
    let added = 0;
    try {
      added = fs.readFileSync(path.join(root(), file), 'utf8').split('\n').length;
    } catch {
      /* binary or gone */
    }
    out.push({ file, added, removed: 0 });
  }
  return out;
}

/** Untracked files outside .work/. */
function untracked() {
  return (git(['ls-files', '--others', '--exclude-standard', ...NOT_WORK]) || '').split('\n').filter(Boolean);
}

/** @type {Map<string, string | null>} */
const packages = new Map();

/**
 * The name of the nearest package.json owning a file; null for a file owned by the repository root.
 * @param {string} file repo-relative
 */
export function packageOf(file) {
  let dir = path.dirname(file);
  while (dir && dir !== '.') {
    const key = path.join(root(), dir);
    if (packages.has(key)) return packages.get(key) ?? null;
    const pj = path.join(key, 'package.json');
    if (fs.existsSync(pj)) {
      let name = null;
      try {
        name = JSON.parse(fs.readFileSync(pj, 'utf8')).name || null;
      } catch {
        /* unreadable: no name */
      }
      packages.set(key, name);
      return name;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * A short hash of the working tree: the id of the tree `git add -A` would commit (untracked files that are not
 * ignored included), built in a scratch copy of the index so the real one is untouched. Same tree, same hash, before
 * the commit and after it. .work/ is left out, so the gate's own logs and events never invalidate a green result.
 * Null when git fails: a null hash matches no gate result.
 * @returns {string | null}
 */
export function treeHash() {
  const index = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const scratch = path.join(os.tmpdir(), `moderator-index-${process.pid}-${crypto.randomUUID()}`);
  try {
    if (index && fs.existsSync(index)) fs.copyFileSync(index, scratch);
    const env = { ...process.env, GIT_INDEX_FILE: scratch };
    if (git(['add', '-A', ...NOT_WORK], root(), env) === null) return null;
    if (git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.work'], root(), env) === null) return null;
    return git(['write-tree'], root(), env)?.slice(0, 12) || null;
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}
