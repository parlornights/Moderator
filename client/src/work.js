// The task's ledger: the issue named in the branch, .work/<issue>/ and its events. Hooks and scripts write events;
// agents only read them.

import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { branch, root } from './git.js';

/** The issue id pattern of this repo, case-insensitive; null without a config. */
export function issuePattern() {
  const c = config();
  return c ? new RegExp(c.issuePattern, 'i') : null;
}

/** The issue this checkout works on: the one its branch name carries, upper-cased; null when it carries none. */
export function issueId() {
  const re = issuePattern();
  const m = re && branch().match(re);
  return m ? m[0].toUpperCase() : null;
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
 * Append one fact to .work/<issue>/events.jsonl.
 * @param {string} kind
 * @param {Record<string, unknown>} [data]
 */
export function appendEvent(kind, data = {}) {
  const rec = { t: new Date().toISOString(), kind, branch: branch(), ...data };
  fs.mkdirSync(workDir(), { recursive: true });
  fs.appendFileSync(path.join(workDir(), 'events.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
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
