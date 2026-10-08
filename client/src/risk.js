// The risk of the current diff. Deterministic facts (sensitive paths, size, test delta) set the floor; Jev, through
// the service, can raise the reviewer to opus on top, never lower it.

import { jev } from './api.js';
import { matcher, requireConfig } from './config.js';
import { changedFiles, lineCounts } from './diff.js';
import { git } from './git.js';

/**
 * @typedef {{ level: 'high' | 'normal', model: 'opus' | 'sonnet', reasons: string[], files: number, added: number, removed: number, srcAdded: number, testAdded: number, needsTests: boolean, mergeBase: string | null, jev?: Record<string, any> | null }} Risk
 */

/**
 * @param {{ base?: string }} [opts]
 * @returns {Risk}
 */
export function computeRisk({ base } = {}) {
  const c = requireConfig();
  const r = c.risk;
  const { files, mergeBase } = changedFiles(base || c.base);
  const ignored = matcher(c.ignore);
  const considered = files.filter((f) => !ignored(f));
  const isTest = matcher(r.testGlobs);
  const isSrc = (/** @type {string} */ f) => c.lintExtensions.some((e) => f.endsWith(e));

  const reasons = [];
  const high = considered.filter(matcher(r.highPaths));
  if (high.length) reasons.push(`sensitive path: ${high.slice(0, 3).join(', ')}${high.length > 3 ? ` +${high.length - 3}` : ''}`);

  let added = 0;
  let removed = 0;
  let srcAdded = 0;
  let testAdded = 0;
  for (const n of lineCounts(mergeBase)) {
    if (!n.file || ignored(n.file)) continue;
    added += n.added;
    removed += n.removed;
    if (isTest(n.file)) testAdded += n.added;
    else if (isSrc(n.file)) srcAdded += n.added;
  }
  if (added + removed >= r.linesHigh) reasons.push(`${added + removed} lines changed`);
  if (considered.length >= r.filesHigh) reasons.push(`${considered.length} files changed`);

  const level = reasons.length ? 'high' : 'normal';
  return {
    level,
    model: level === 'high' ? 'opus' : 'sonnet',
    reasons,
    files: considered.length,
    added,
    removed,
    srcAdded,
    testAdded,
    needsTests: srcAdded >= r.srcLinesNeedingTests && testAdded === 0,
    mergeBase,
  };
}

/**
 * A compact description of the diff for Jev: paths, line counts, commit subjects. No file contents.
 * @param {{ base?: string }} [opts]
 */
export function diffSummary({ base } = {}) {
  const c = requireConfig();
  const { files, mergeBase } = changedFiles(base || c.base);
  const ignored = matcher(c.ignore);
  const numstat = lineCounts(mergeBase).map((n) => `${n.added}\t${n.removed}\t${n.file}`);
  const commits = mergeBase ? git(['log', '--format=%s', `${mergeBase}..HEAD`]) || '' : '';
  return { files: files.filter((f) => !ignored(f)).slice(0, 80), numstat: numstat.slice(0, 80), commits: commits.split('\n').filter(Boolean).slice(0, 30) };
}

/**
 * The deterministic risk, raised to opus when Jev reads the diff as needing the strongest reviewer.
 * @param {{ base?: string }} [opts]
 * @returns {Promise<Risk>}
 */
export async function computeRiskWithJev(opts = {}) {
  const x = computeRisk(opts);
  const j = await jev('reviewer', diffSummary(opts));
  x.jev = j;
  if (j?.opus && x.level !== 'high') {
    x.level = 'high';
    x.model = 'opus';
    x.reasons.push(`jev: strong review (p=${j.p})`);
  }
  return x;
}

/** @param {Risk} x */
export function formatRisk(x) {
  const why = x.reasons.length ? ` (${x.reasons.join('; ')})` : '';
  const tests = x.needsTests ? `tests: +${x.testAdded} against +${x.srcAdded} source -> NEEDS TESTS` : `tests: +${x.testAdded} test lines, +${x.srcAdded} source lines`;
  return `risk: ${x.level}${why} -> reviewer: ${x.model}. ${tests}`;
}
