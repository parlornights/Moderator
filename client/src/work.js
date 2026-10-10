// The task's ledger: the issue named in the branch (or, when the branch names none, in its open PR's title),
// .work/<issue>/ and its events. Hooks and scripts write events; agents only read them.

import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { branch, git, isMainBranch, root } from './git.js';
import { openPr } from './github.js';

/** The issue id pattern of this repo, case-insensitive; null without a config. */
export function issuePattern() {
  const c = config();
  return c ? new RegExp(c.issuePattern, 'i') : null;
}

/** Where a branch keeps the issue its open PR's title named: git config, so it stays with the clone and no commit. */
const prIssueKey = (/** @type {string} */ b) => `branch.${b}.moderatorIssue`;

/**
 * The issue this checkout works on, upper-cased: the one its branch name carries, else the one issueFromPr() found
 * for the branch; null when neither names one.
 */
export function issueId() {
  const re = issuePattern();
  if (!re) return null;
  const b = branch();
  const m = b.match(re) || (isMainBranch(b) ? null : (git(['config', '--get', prIssueKey(b)]) || '').match(re));
  return m ? m[0].toUpperCase() : null;
}

/**
 * The branch names no issue: the one issue its open PR's title names, kept for the branch so every hook after reads it
 * through issueId(). Otherwise `issue` is null and `why` says what was found: no open PR, a title naming none or
 * several, or the lookup that failed.
 * @returns {{ issue: string | null, why: string }}
 */
export function issueFromPr() {
  const re = issuePattern();
  const b = branch();
  if (!re || isMainBranch(b)) return { issue: null, why: 'no issue pattern, or the main branch' };
  const r = openPr(b);
  if (!r.ok) return { issue: null, why: `the PR lookup failed: ${r.why}` };
  if (!r.pr) return { issue: null, why: 'no open PR for the branch' };
  const ids = [...new Set([...r.pr.title.matchAll(new RegExp(re.source, 'gi'))].map((m) => m[0].toUpperCase()))];
  if (ids.length !== 1) return { issue: null, why: ids.length ? `PR #${r.pr.number}'s title names more than one issue: ${ids.join(', ')}` : `PR #${r.pr.number}'s title names none` };
  git(['config', prIssueKey(b), ids[0]]);
  return { issue: ids[0], why: `PR #${r.pr.number}'s title` };
}

/** .work/<issue>/ (or .work/_unassigned/) of this checkout. Created by the first write, so reading creates nothing. */
export function workDir() {
  return path.join(root(), '.work', issueId() || '_unassigned');
}

/** @typedef {{ t: string, kind: string, branch: string, [k: string]: any }} Event */

/**
 * Events of one kind (or all) from .work/<issue>/events.jsonl, oldest first.
 * @param {string} [kind]
 * @returns {Event[]}
 */
export function readEvents(kind) {
  let text;
  try {
    text = fs.readFileSync(path.join(workDir(), 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && (!kind || e.kind === kind));
}

/**
 * Append one fact to .work/<issue>/events.jsonl, or to the events of the ledger `dir`.
 * @param {string} kind
 * @param {Record<string, unknown>} [data]
 * @param {string} [dir]
 */
export function appendEvent(kind, data = {}, dir = workDir()) {
  const rec = { t: new Date().toISOString(), kind, branch: branch(), ...data };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}

/** A running.json entry older than this is from a unit long gone: its stop went unrecorded. */
const RUNNING_MAX_MS = 24 * 60 * 60 * 1000;

/** @typedef {{ agent_type?: string, started?: string, session?: string | null }} RunningEntry */

/**
 * The units .work/<issue>/running.json holds as running: an entry of another session (when `session` is known) or
 * one started more than a day ago is left out, and with `prune` removed from the file. An entry with no session (the
 * previous client's) is judged by its age alone.
 * @param {{ session?: string | null, now?: number, prune?: boolean }} [opts]
 * @returns {Record<string, RunningEntry>}
 */
export function runningUnits({ session = null, now = Date.now(), prune = false } = {}) {
  const p = path.join(workDir(), 'running.json');
  /** @type {Record<string, RunningEntry>} */
  const all = readJson(p, {}) || {};
  const live = Object.fromEntries(Object.entries(all).filter(([, u]) => (!session || !u?.session || u.session === session) && now - (Date.parse(u?.started ?? '') || 0) < RUNNING_MAX_MS));
  if (prune && Object.keys(live).length < Object.keys(all).length) writeJson(p, live);
  return live;
}

/** This checkout's root and, from a linked worktree, the main checkout's: a unit in a worktree started in the latter. */
function ledgerRoots() {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common && path.basename(common) === '.git' ? path.dirname(common) : null;
  return [...new Set([root(), main].filter((r) => r !== null))];
}

/**
 * Take a unit out of every running.json that holds it, in this checkout and the main one. Its SubagentStop runs where
 * the unit worked (its worktree, on its own branch) while its SubagentStart wrote the session's ledger. Returns the
 * first ledger directory that held it, or null.
 * @param {string} id
 */
export function forgetUnit(id) {
  /** @type {string | null} */
  let found = null;
  for (const r of ledgerRoots()) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(path.join(r, '.work'));
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = path.join(r, '.work', d, 'running.json');
      const running = readJson(p);
      if (!running || !Object.hasOwn(running, id)) continue;
      delete running[id];
      writeJson(p, running);
      found ??= path.dirname(p);
    }
  }
  return found;
}

/**
 * @param {string} p
 * @param {any} [fallback]
 */
export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} p
 * @param {unknown} obj
 */
export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
