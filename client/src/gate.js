// Runs the check plan. One definition of "verified", used by a unit (self-check), the SubagentStop hook
// (enforcement) and CI (the same command). Writes .work/<issue>/gate.json, gate-<check>.log and one `gate` event.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { requireConfig } from './config.js';
import { treeHash } from './diff.js';
import { root } from './git.js';
import { computeScope } from './scope.js';
import { appendEvent, readJson, workDir, writeJson } from './work.js';

const FAIL_RE = /(✘|✗|×|✖|●|\bFAIL(ED)?\b|\bError\b|error TS\d+|\bfailed\b|AssertionError|\bExpected\b|\bReceived\b|Timeout|ELIFECYCLE)/;
const SEED_RE = /shuffled with seed|Running tests with seed/;

/**
 * The lines a model needs to see: the failure lines when there are some, else the raw tail; capped. A test run's
 * shuffle seed always stays, so a failure can be rerun in the same order.
 * @param {string} out
 * @param {number} [max]
 */
export function relevantTail(out, max = 40) {
  const lines = out.split('\n').filter((l) => l.trim());
  const hits = lines.filter((l) => FAIL_RE.test(l));
  const kept = (hits.length >= 3 ? hits : lines).slice(-max);
  const seeds = lines.filter((l) => SEED_RE.test(l) && !kept.includes(l));
  return [...kept, ...seeds].join('\n');
}

/**
 * A check's environment is CI's, so a session-only setting never changes a result (NODE_USE_ENV_PROXY warns on
 * stderr).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function checkEnv(env = process.env) {
  const { NODE_USE_ENV_PROXY: _proxy, ...rest } = env;
  return { ...rest, CI: env.CI || '1', FORCE_COLOR: '0' };
}

/**
 * Run one shell command at the repo root, its whole output into logFile. Never throws.
 * @param {string} cmd
 * @param {{ logFile: string, timeoutMs: number }} opts
 */
function run(cmd, { logFile, timeoutMs }) {
  const started = Date.now();
  const r = spawnSync('bash', ['-c', cmd], { cwd: root(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: checkEnv() });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(logFile, `$ ${cmd}\n\n${out}`);
  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code === 'ETIMEDOUT';
  return { code: r.status ?? 1, out, ms: Date.now() - started, timedOut };
}

/**
 * @typedef {{ id: string, status: 'pass' | 'fail' | 'timeout' | 'skipped', ms?: number, log?: string, tail?: string, reason?: string }} CheckResult
 * @typedef {{ ok: boolean, at: string, issue: string | null, treeHash: string | null, base: string, global: boolean, packages: string[], checks: CheckResult[], skipped: { id: string, reason: string }[], ms: number, cached?: boolean }} GateResult
 */

/**
 * @param {{ base?: string, only?: string, skip?: string, ifChanged?: boolean }} [opts]
 * @returns {GateResult}
 */
export function runGate(opts = {}) {
  const c = requireConfig();
  const scope = computeScope({ base: opts.base });
  const dir = workDir();
  fs.mkdirSync(dir, { recursive: true });
  const resultPath = path.join(dir, 'gate.json');
  const hash = treeHash();
  const only = opts.only ? opts.only.split(',') : null;
  const skip = opts.skip ? opts.skip.split(',') : [];
  const partial = !!only || skip.length > 0;
  const checks = scope.checks.filter((k) => (!only || only.includes(k.id)) && !skip.includes(k.id));

  if (opts.ifChanged && !partial) {
    const prev = readJson(resultPath);
    if (hash && prev?.ok && prev.treeHash === hash) return { ...prev, cached: true };
  }

  const t0 = Date.now();
  /** @type {CheckResult[]} */
  const results = [];
  let ok = true;
  for (const k of checks) {
    const def = c.checks[k.id];
    if (!ok && def.skipAfterFailure) {
      results.push({ id: k.id, status: 'skipped', reason: 'earlier check failed' });
      continue;
    }
    const log = path.join(dir, `gate-${k.id}.log`);
    const r = run(k.cmd, { logFile: log, timeoutMs: def.timeoutSec * 1000 });
    const status = r.code === 0 ? 'pass' : r.timedOut ? 'timeout' : 'fail';
    if (status !== 'pass') ok = false;
    results.push({ id: k.id, status, ms: r.ms, log: path.relative(root(), log), ...(status !== 'pass' ? { tail: relevantTail(r.out) } : {}) });
  }

  /** @type {GateResult} */
  const result = {
    ok,
    at: new Date().toISOString(),
    issue: scope.issue,
    treeHash: hash,
    base: scope.base,
    global: scope.global,
    packages: scope.packages,
    checks: results,
    skipped: scope.skipped,
    ms: Date.now() - t0,
  };
  // A partial run (--only / --skip) is never the green result a hook can trust.
  if (!partial) writeJson(resultPath, result);
  appendEvent('gate', { ok, partial, treeHash: hash, checks: results.map((r) => `${r.id}:${r.status}`) });
  return result;
}

/** @param {GateResult} r */
export function formatGate(r) {
  const sec = (/** @type {number | undefined} */ ms) => `${Math.round((ms || 0) / 1000)}s`;
  const head = r.cached ? `gate: GREEN (cached, tree ${r.treeHash} unchanged since ${r.at})` : `gate: ${r.ok ? 'GREEN' : 'FAIL'} (${sec(r.ms)}) ${r.issue || ''} tree ${r.treeHash}`;
  const row = r.checks
    .map((c) => (c.status === 'pass' ? `✓ ${c.id} ${sec(c.ms)}` : c.status === 'skipped' ? `- ${c.id} skipped: ${c.reason}` : `✗ ${c.id} ${c.status} ${sec(c.ms)}`))
    .concat((r.skipped || []).map((k) => `- ${k.id} skipped: ${k.reason}`))
    .join('   ');
  const lines = [head, `  ${row}`];
  for (const c of r.checks) {
    if (c.status === 'pass' || c.status === 'skipped') continue;
    lines.push(`--- ${c.id} (${c.status}; relevant lines, full log: ${c.log})`);
    lines.push(c.tail || '(no output)');
  }
  return lines.join('\n');
}
