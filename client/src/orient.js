// The onboarding block: printed by the SessionStart hook and by `moderator orient`. Facts only. The handoff note is
// named by its path, never inlined, so the hook's size cap never cuts it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { branch, git, root } from './git.js';
import { handoffPath } from './handoff.js';
import { issueId, readEvents, workDir } from './work.js';

function openPr() {
  const r = spawnSync('gh', ['pr', 'view', '--json', 'number,state,url,mergeable,reviewDecision', '--jq', '"#\\(.number) \\(.state) \\(.mergeable) \\(.reviewDecision) \\(.url)"'], {
    cwd: root(),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.error) return 'unknown (gh not available)';
  return r.status === 0 ? r.stdout.trim() : 'none for this branch';
}

function lastEvents(n = 10) {
  return readEvents()
    .slice(-n)
    .map((e) => {
      const rest = Object.entries(e)
        .filter(([k]) => !['t', 'kind', 'branch'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      return `  ${String(e.t).slice(0, 16)} ${e.kind} ${rest}`.slice(0, 160);
    });
}

function running() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(workDir(), 'running.json'), 'utf8'));
    const ids = Object.keys(r);
    return ids.length ? ids.map((id) => `${r[id].agent_type}(${id.slice(0, 8)})`).join(', ') : 'none';
  } catch {
    return 'none';
  }
}

/** @param {{ source?: string }} [opts] */
export function orient({ source } = {}) {
  const out = [];
  const st = (git(['status', '--short']) || '').split('\n').filter(Boolean);
  if (source === 'compact') {
    out.push('Context was compacted. The handoff note is the ground truth for this task; continue from its "Next step". Re-read files before editing them, since what you remember of their contents is gone.');
    out.push('');
  }
  out.push(
    fs.existsSync(handoffPath())
      ? `Handoff: read ${path.relative(root(), handoffPath())} in full now, before anything else (Read, no offset or limit). It holds the goal, decisions, open questions, the next step and the last 25 turns of the conversation.`
      : 'No handoff note yet. One is created on the first compaction or stop; the handoff skill says what goes in it.',
  );
  out.push(`orient: branch ${branch()} (head ${git(['rev-parse', '--short', 'HEAD']) || '?'}), issue ${issueId() || 'not set'}, uncommitted: ${st.length} file${st.length === 1 ? '' : 's'}`);
  out.push(`PR for this branch: ${openPr()}`);
  out.push(`units running in this session: ${running()}`);
  const ev = lastEvents();
  if (ev.length) out.push('last events:', ...ev);
  return out.join('\n');
}

/**
 * Fit the session-start context under Claude Code's 10,000-character hook cap (over it, only a 2,000-character
 * preview reaches the session). The head and the tail are kept whole; the orient block in the middle is cut.
 * @param {{ head?: string, middle?: string, tail?: string }} parts
 * @param {number} [cap]
 */
export function fitSessionContext({ head = '', middle = '', tail = '' }, cap = 9500) {
  const join = (/** @type {string} */ m) => [head, m, tail].filter(Boolean).join('\n\n');
  if (join(middle).length <= cap) return join(middle);
  const marker = '\n… (orient cut to fit the hook limit; run moderator orient for the rest)';
  const room = Math.max(0, cap - join('').length - 2 - marker.length);
  return join(middle.slice(0, room) + marker);
}
