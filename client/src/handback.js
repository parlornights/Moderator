// A unit's final message: a HANDBACK block, or one escalation line. The only place the hand-back shape is defined.
// Whether a NEEDS DECISION line asks a whole question is prose, so Jev judges it (the SubagentStop hook), not this file.

import path from 'node:path';

import { matcher, requireConfig } from './config.js';
import { changedFiles, treeHash } from './diff.js';
import { computeRisk } from './risk.js';
import { issueId, readJson, workDir } from './work.js';

export const SHAPE = {
  done: '{"status":"done","issue":"ABC-1","branch":"abc-1-x","pr":0,"scope":["<package>"],"gate":"<tree hash from the GREEN gate line>","tests":"added 3 (path) | updated 2 | n/a: <why>","review":{"model":"sonnet","findings":0,"fixed":0,"declined":0,"declinedWhy":""},"proof":"https://claude.ai/... | none: <why nothing visible changed>","notes":"","papercuts":[]}',
  blocked: 'BLOCKED: <one line: what is outside your reach>',
  decision: 'NEEDS DECISION: <question> | options: A / B | recommend: A because <one line>',
};

const PROOF_URL = /^https:\/\/claude\.ai\/\S+$/;
const PROOF_NONE = /^none:\s*\S/;

/**
 * @typedef {{ status: 'done' | 'blocked' | 'partial', issue: string, branch: string, pr?: number, scope: string[], gate?: string, tests: string, review?: { model: string, findings: number, fixed: number, declined: number, declinedWhy: string }, proof?: string, notes: string, papercuts: string[] }} Handback
 * @typedef {{ ok: boolean, kind: 'none' | 'blocked' | 'decision' | 'handback', errors: string[], text?: string, handback?: Handback }} Parsed
 */

/**
 * Structure only; no repo checks.
 * @param {string} text
 * @returns {Parsed}
 */
export function parseHandback(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { ok: false, kind: 'none', errors: ['empty message'] };
  const last = trimmed.split('\n').at(-1)?.trim() ?? '';

  const esc = last.match(/^(BLOCKED|NEEDS DECISION):\s*(.+)$/);
  if (esc) return { ok: true, kind: esc[1] === 'BLOCKED' ? 'blocked' : 'decision', text: esc[2], errors: [] };

  const idx = trimmed.lastIndexOf('HANDBACK');
  if (idx < 0) return { ok: false, kind: 'none', errors: ['no HANDBACK block and no BLOCKED / NEEDS DECISION last line'] };
  const after = trimmed.slice(idx + 'HANDBACK'.length).trim();
  const jsonText = after.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  let hb;
  try {
    hb = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, kind: 'handback', errors: [`HANDBACK block is not valid JSON (${e instanceof Error ? e.message : e}). Shape: ${SHAPE.done}`] };
  }

  const errors = [];
  /**
   * @param {string} k
   * @param {string} type
   */
  const need = (k, type) => {
    if (hb[k] === undefined || hb[k] === null) errors.push(`missing "${k}"`);
    else if (typeof hb[k] !== type) errors.push(`"${k}" must be a ${type}`);
  };
  need('status', 'string');
  if (!['done', 'blocked', 'partial'].includes(hb.status)) errors.push('"status" must be done | blocked | partial');
  need('issue', 'string');
  need('branch', 'string');
  need('tests', 'string');
  need('notes', 'string');
  if (!Array.isArray(hb.scope)) errors.push('"scope" must be an array of package names');
  if (!Array.isArray(hb.papercuts)) errors.push('"papercuts" must be an array (may be empty)');
  if (hb.status === 'done') {
    if (typeof hb.pr !== 'number') errors.push('"done" needs a numeric "pr"');
    if (typeof hb.gate !== 'string') errors.push('"done" needs "gate": the tree hash printed by a GREEN gate run');
    if (!hb.review || !['opus', 'sonnet'].includes(hb.review.model)) errors.push('"done" needs review.model (opus or sonnet, from moderator risk): the parent runs the reviewer with it');
    if (hb.review && hb.review.declined > 0 && !hb.review.declinedWhy) errors.push('declined review findings need "declinedWhy"');
  }
  if (hb.proof !== undefined && hb.proof !== null && hb.proof !== '') {
    if (typeof hb.proof !== 'string' || !(PROOF_URL.test(hb.proof) || PROOF_NONE.test(hb.proof))) errors.push('"proof" must be an Artifact URL (https://claude.ai/...) or "none: <reason>"');
  }
  if (!/}\s*(```)?\s*$/.test(after)) errors.push('nothing may follow the HANDBACK block');
  return { ok: errors.length === 0, kind: 'handback', handback: hb, errors };
}

/**
 * Parse, then the repo checks of a `done`: a green gate for the tree as it is now, the reviewer the risk asks for,
 * tests for new source, the branch's issue, and a proof page when the diff touches `proofPaths`.
 * @param {string} text
 * @param {{ base?: string }} [opts]
 */
export function checkHandback(text, { base } = {}) {
  const res = parseHandback(text);
  /** @type {string[]} */
  const warnings = [];
  if (!res.ok || res.kind !== 'handback' || res.handback?.status !== 'done') return { ...res, warnings };
  const hb = /** @type {Handback} */ (res.handback);
  const errors = [];
  const gate = readJson(path.join(workDir(), 'gate.json'));
  const now = treeHash();
  if (!gate?.ok) errors.push('no GREEN gate result on this branch: run `moderator gate`');
  else if (gate.treeHash !== now) errors.push(`the tree changed after the last green gate (${gate.treeHash} -> ${now}): run \`moderator gate\` again`);
  else if (hb.gate !== gate.treeHash) warnings.push(`"gate" says ${hb.gate}, the green run is ${gate.treeHash}`);

  const risk = computeRisk({ base });
  if (risk.model === 'opus' && hb.review?.model !== 'opus') errors.push('moderator risk says this diff needs an opus review: set review.model to "opus"');
  if (risk.needsTests && !/^n\/a:\s*\S/.test(hb.tests)) errors.push(`${risk.srcAdded} source lines added and 0 test lines: add tests, or set "tests" to "n/a: <reason>"`);
  const c = requireConfig();
  if (c.proofPaths?.length) {
    const visible = changedFiles(base || c.base).files.filter(matcher(c.proofPaths));
    if (visible.length && !hb.proof) {
      const listed = `${visible.slice(0, 5).join(', ')}${visible.length > 5 ? ` +${visible.length - 5}` : ''}`;
      errors.push(`the diff touches proofPaths (${listed}): proof is missing: give the Artifact URL, or none: <reason> when nothing visible changed`);
    }
  }
  const id = issueId();
  if (id && hb.issue.toUpperCase() !== id) errors.push(`"issue" ${hb.issue} does not match the branch (${id})`);
  return { ...res, ok: errors.length === 0, errors, warnings };
}
