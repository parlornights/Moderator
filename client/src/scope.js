// The current diff as a check plan, from moderator.config.json. Deterministic: same tree, same plan.

import fs from 'node:fs';
import path from 'node:path';

import { matcher, requireConfig } from './config.js';
import { changedFiles, packageOf } from './diff.js';
import { root } from './git.js';
import { quote } from './shell.js';
import { issueId } from './work.js';

/**
 * @typedef {{ id: string, cmd: string, order: number }} PlannedCheck
 * @typedef {{ issue: string | null, base: string, mergeBase: string | null, global: boolean, files: string[], ignored: number, packages: string[], rules: string[], checks: PlannedCheck[], skipped: { id: string, reason: string }[] }} Scope
 */

/**
 * @param {{ base?: string }} [opts]
 * @returns {Scope}
 */
export function computeScope({ base } = {}) {
  const c = requireConfig();
  base = base || c.base;
  const { files, mergeBase } = changedFiles(base);
  const ignored = matcher(c.ignore);
  const considered = files.filter((f) => !ignored(f));
  const global = considered.some(matcher(c.global));

  // Packages touched. A root-owned file (no package) matters only when it is global.
  const packages = new Set(considered.map(packageOf).filter((p) => p !== null));

  const asked = new Set();
  const rules = [];
  for (const rule of c.rules) {
    if (!considered.some(matcher(rule.match))) continue;
    rules.push(rule.name);
    rule.checks.forEach((id) => asked.add(id));
  }

  const lintFiles = considered.filter((f) => c.lintExtensions.some((ext) => f.endsWith(ext)) && fs.existsSync(path.join(root(), f)));
  const filters = global ? '-r' : [...packages].map((p) => `--filter ${quote(`...${p}`)}`).join(' ');

  /** @type {PlannedCheck[]} */
  const checks = [];
  const skipped = [];
  for (const [id, def] of Object.entries(c.checks)) {
    const [wanted, reason] = {
      files: [lintFiles.length > 0, 'no lintable files changed'],
      packages: [global || packages.size > 0, 'no workspace package changed'],
      rule: [global || asked.has(id), 'no rule asked for it'],
      always: [true, ''],
    }[def.when];
    if (!wanted) {
      skipped.push({ id, reason: String(reason) });
      continue;
    }
    const cmd = def.cmd.replaceAll('{files}', lintFiles.map(quote).join(' ')).replaceAll('{filters}', filters);
    checks.push({ id, cmd, order: def.order });
  }
  checks.sort((a, b) => a.order - b.order);

  return { issue: issueId(), base, mergeBase, global, files: considered, ignored: files.length - considered.length, packages: [...packages], rules, checks, skipped };
}

/** @param {Scope} s */
export function formatScope(s) {
  const lines = [];
  lines.push(
    `scope ${s.issue || '(no issue)'}: ${s.files.length} files, ${s.packages.length} packages, global: ${s.global ? 'YES' : 'no'}, base ${s.base}${s.mergeBase ? '' : ' (merge-base not found: working tree only)'}`,
  );
  if (s.packages.length) lines.push(`  packages: ${s.packages.join(', ')}`);
  if (s.rules.length) lines.push(`  rules:    ${s.rules.join(', ')}`);
  lines.push(`  run:      ${s.checks.map((c) => c.id).join(', ') || '(nothing)'}`);
  for (const k of s.skipped) lines.push(`  skip:     ${k.id} (${k.reason})`);
  return lines.join('\n');
}
