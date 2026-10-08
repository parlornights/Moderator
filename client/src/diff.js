// What changed against the base: files, line counts, the package each file belongs to, and a hash of the tree.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { git, root } from './git.js';

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
  if (mergeBase) add(git(['diff', '--name-only', '--diff-filter=ACMRD', mergeBase, 'HEAD']));
  add(git(['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD']));
  add(git(['ls-files', '--others', '--exclude-standard']));
  return { files: [...set].sort(), mergeBase };
}

/**
 * Added and removed lines per file: commits since the merge base, working-tree edits, and untracked files (every
 * line added).
 * @param {string | null} mergeBase
 * @returns {{ file: string, added: number, removed: number }[]}
 */
export function lineCounts(mergeBase) {
  const numstat = [mergeBase ? git(['diff', '--numstat', mergeBase, 'HEAD']) : null, git(['diff', '--numstat', 'HEAD'])].filter(Boolean).join('\n');
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
  return (git(['ls-files', '--others', '--exclude-standard', '--', '.', ':(exclude).work']) || '').split('\n').filter(Boolean);
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
 * A short hash of the working tree: HEAD, the diff against it and the untracked files. Same tree, same hash.
 * .work/ is left out, so the gate's own logs and events never invalidate a green result.
 */
export function treeHash() {
  const h = crypto.createHash('sha1');
  h.update(git(['rev-parse', 'HEAD']) || '');
  h.update(git(['diff', 'HEAD', '--binary', '--', '.', ':(exclude).work']) || '');
  for (const f of untracked()) h.update(`${f}:${git(['hash-object', '--', f]) || ''}`);
  return h.digest('hex').slice(0, 12);
}
