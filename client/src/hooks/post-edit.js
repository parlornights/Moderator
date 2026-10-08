// PostToolUse (matcher: Edit|Write|MultiEdit). Runs the repo's lintOnEdit command on the file just written; on a
// failure it exits 2, so the agent sees the lint output at once instead of at gate time.

import { spawnSync } from 'node:child_process';

import { config } from '../config.js';
import { root } from '../git.js';

/** @param {string} s */
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** @param {any} input */
export default async function postEdit(input) {
  const c = config();
  const file = String(input.tool_input?.file_path || '');
  if (!c?.lintOnEdit || !c.lintExtensions.some((ext) => file.endsWith(ext))) return;
  const r = spawnSync('bash', ['-c', c.lintOnEdit.replaceAll('{file}', quote(file))], { cwd: root(), encoding: 'utf8', timeout: 60_000, env: { ...process.env, FORCE_COLOR: '0' } });
  if (r.status === 0) return;
  const out = ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => l.trim()).slice(-30).join('\n');
  return { stderr: `lint: ${file}\n${out}\n`, exit: 2 };
}
