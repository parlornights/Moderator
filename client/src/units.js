// What the session's units are doing, read from the session transcript.
//
// A unit is running from its Agent call until a task notice with a final status, and again after a SendMessage to it
// that did not fail. Its idle time is the age of its own transcript; one silent for DEAD_MINUTES is taken as gone
// (its session died without a notice). Its PR is looked up by its worktree's branch. The Stop hook uses unitTodos()
// to hold the session until each running unit has a check-in and a watched PR, and while a watched PR is open: a
// check-in armed, and a merge conflict on it named.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UNIT_TYPES = new Set(['unit', 'unit-deep']);
export const IDLE_MINUTES = 20;
export const DEAD_MINUTES = 6 * 60;
const FINAL = new Set(['completed', 'killed', 'failed', 'stopped']);
const NOTICE = /<task-id>([\w-]+)<\/task-id>(?:(?!<task-id>)[\s\S])*?<status>(\w+)<\/status>/g;
const CHECK_IN = 'mcp__claude-code-remote__send_later';
const SUBSCRIBE = 'mcp__claude-code-remote__subscribe_pr_activity';
const UNSUBSCRIBE = 'mcp__claude-code-remote__unsubscribe_pr_activity';

/** A unit's measured waiting adds up; past this its next pure wait is refused and it hands back BLOCKED. */
export const WAIT_CAP_SEC = 20 * 60;

/**
 * Where a unit's measured waiting is kept: outside the repo, so no commit carries it.
 * @param {string} agentId
 */
export function waitsFile(agentId) {
  const dir = path.join(os.tmpdir(), 'moderator-waits');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(agentId).replace(/[^\w-]/g, '_')}.json`);
}

/**
 * The shell a command runs: `bash -c '<body>'` bodies unwrapped, other quoted text and heredocs dropped.
 * @param {string} cmd
 */
function shellOf(cmd) {
  return cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\2\b/g, ' ')
    .replace(/\b(?:bash|sh)\s+-c\s+(['"])([\s\S]*?)\1/g, ' ; $2 ; ')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' ');
}

const LOOP = /\b(?:while|until)\b[\s\S]*?\bdo\b[\s\S]*?\bdone\b/g;
const IDLE_WORDS = /\b(?:echo|printf)\s+[\w .:-]*|\b(?:sleep|timeout|echo|printf|date|true|ps|kill|test|exit)\b|\d*[<>]+&?\S*|\S+=\S+|[;&|()\s]+|\d+[smh]?\b|-\w+/g;

/**
 * Whether a command waits: a sleep, or a polling loop that sleeps.
 * @param {string} cmd
 */
export function isWait(cmd) {
  const sh = shellOf(cmd);
  return /\bsleep\s+\d/.test(sh) || [...sh.matchAll(LOOP)].some((m) => /\bsleep\b/.test(m[0]));
}

/**
 * A wait and nothing else: no build, test, git or other work rides along, so refusing it refuses no work.
 * @param {string} cmd
 */
export function isPureWait(cmd) {
  if (!isWait(cmd)) return false;
  return shellOf(cmd).replace(LOOP, ' ').replace(IDLE_WORDS, ' ').trim() === '';
}

/**
 * @typedef {{ number: number, state: string, merged: boolean, mergeable?: string }} Pr
 * @typedef {{ id: string, type: string, description: string, started: number | null, running: boolean, idleMin?: number | null, worktree?: string | null, branch?: string | null, pr?: Pr }} Unit
 * @typedef {{ units: Unit[], checkIns: number[], watched: Set<number>, prs?: Pr[] }} Session
 */

/**
 * Units, check-ins and watched PRs from a session transcript's lines. Pure: no file or network access.
 * @param {string[]} lines
 * @returns {Session}
 */
export function readSession(lines) {
  /** @type {Map<string, Unit>} */
  const units = new Map();
  /** @type {Map<string, Omit<Unit, 'id' | 'running'>>} */
  const spawnById = new Map();
  /** @type {Map<string, string>} */
  const messageById = new Map();
  /** @type {number[]} */
  const checkIns = [];
  /** @type {Set<number>} */
  const watched = new Set();
  for (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"') && !line.includes('<task-id>')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp || '') || null;
    const content = e.message?.content;
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'tool_use' && b.name === 'Agent' && UNIT_TYPES.has(b.input?.subagent_type)) {
        spawnById.set(b.id, { type: b.input.subagent_type, description: b.input.description || '', started: at });
      }
      if (b.type === 'tool_use' && b.name === 'SendMessage' && units.has(b.input?.to)) messageById.set(b.id, b.input.to);
      if (b.type === 'tool_result' && messageById.has(b.tool_use_id) && !b.is_error) /** @type {Unit} */ (units.get(/** @type {string} */ (messageById.get(b.tool_use_id)))).running = true;
      if (b.type === 'tool_use' && b.name === CHECK_IN) {
        const fire = b.input?.at ? Date.parse(b.input.at) : at && at + (Number(b.input?.delay_minutes) || 0) * 60_000;
        if (fire) checkIns.push(fire);
      }
      if (b.type === 'tool_use' && b.name === SUBSCRIBE && b.input?.pullNumber) watched.add(Number(b.input.pullNumber));
      if (b.type === 'tool_use' && b.name === UNSUBSCRIBE && b.input?.pullNumber) watched.delete(Number(b.input.pullNumber));
      if (b.type === 'tool_result' && spawnById.has(b.tool_use_id)) {
        const id = (JSON.stringify(b.content).match(/agentId: (\w+)/) || [])[1];
        const spawn = spawnById.get(b.tool_use_id);
        if (id && spawn) units.set(id, { id, ...spawn, running: true });
      }
    }
    for (const [, id, status] of line.matchAll(NOTICE)) {
      const u = units.get(id);
      if (u && FINAL.has(status)) u.running = false;
    }
  }
  return { units: [...units.values()], checkIns, watched };
}

/**
 * Running and not gone: a unit whose transcript has been silent for DEAD_MINUTES died without a notice.
 * @param {Unit} u
 */
export function alive(u) {
  return u.running && !(u.idleMin != null && u.idleMin >= DEAD_MINUTES);
}

/**
 * What the session must do before it stops, given each running unit's state. Pure.
 * @param {Session} session
 * @param {number} [now]
 */
export function unitTodos({ units, checkIns, watched, prs = [] }, now = Date.now()) {
  const running = units.filter(alive);
  const waiting = prs.filter((p) => p.state === 'open');
  if (!running.length && !waiting.length) return [];
  const todo = [];
  if (!checkIns.some((t) => t > now)) {
    const what = running.length ? 'a unit is running' : `watched PR ${waiting.map((p) => `#${p.number}`).join(', ')} is open`;
    todo.push(`${what} and no check-in is armed: call send_later (delay_minutes 45) with "Check-in: run moderator unit-watch and act on every flag; re-arm while a unit runs or a watched PR is open"`);
  }
  const inHand = new Set(running.map((u) => u.pr?.number).filter(Boolean));
  for (const p of waiting) {
    if (p.mergeable === 'dirty' && !inHand.has(p.number)) todo.push(`watched PR #${p.number} has a merge conflict with its base: merge the base into it now, or send it to a unit`);
  }
  for (const u of running) {
    const name = `unit ${u.id.slice(0, 8)} (${u.description})`;
    if (u.pr && u.pr.state === 'open' && !watched.has(u.pr.number)) todo.push(`${name} has PR #${u.pr.number} that is not watched: call subscribe_pr_activity for it`);
    if (u.pr && u.pr.merged) todo.push(`${name}: its PR #${u.pr.number} is already merged; stop the unit (TaskStop) unless it was asked to work after the merge`);
    else if (u.pr && u.pr.state === 'closed') todo.push(`${name}: its PR #${u.pr.number} is closed; stop the unit (TaskStop) or tell it why it goes on`);
    if (u.idleMin != null && u.idleMin >= IDLE_MINUTES) todo.push(`${name} has done nothing for ${u.idleMin} min: find out what it waits on and act`);
  }
  return todo;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 */
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/** The newest session transcript of this project, or null. */
export function newestTranscript(cwd = process.cwd()) {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^\w-]/g, '-'));
  try {
    return (
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null
    );
  } catch {
    return null;
  }
}

/**
 * Fill in idle time, worktree and branch for each running unit, and with `remote` its PR and the watched PRs' state
 * (one GitHub call each, fail open).
 * @param {Session} session
 * @param {string} transcriptPath
 * @param {{ now?: number, remote?: boolean }} [opts]
 */
export function inspect(session, transcriptPath, { now = Date.now(), remote = true } = {}) {
  const subagents = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const repo = (sh('git', ['remote', 'get-url', 'origin']) || '').match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  for (const u of session.units.filter((x) => x.running)) {
    try {
      u.idleMin = Math.floor((now - fs.statSync(path.join(subagents, `agent-${u.id}.jsonl`)).mtimeMs) / 60_000);
    } catch {
      u.idleMin = null;
    }
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subagents, `agent-${u.id}.meta.json`), 'utf8'));
    } catch {
      /* none */
    }
    u.worktree = /** @type {{ worktreePath?: string }} */ (meta).worktreePath || null;
    u.branch = u.worktree ? sh('git', ['-C', u.worktree, 'rev-parse', '--abbrev-ref', 'HEAD']) : null;
    if (remote && repo && u.branch && !/^(HEAD|main|worktree-agent-)/.test(u.branch)) {
      const out = sh('gh', ['api', `repos/${repo}/pulls?head=${repo.split('/')[0]}:${u.branch}&state=all`, '--jq', '.[0] | [.number, .state, .merged_at] | @tsv']);
      if (out) {
        const [number, state, mergedAt] = out.split('\t');
        u.pr = { number: Number(number), state, merged: Boolean(mergedAt) };
      }
    }
  }
  session.prs = [];
  if (remote && repo) {
    for (const number of session.watched) {
      const out = sh('gh', ['api', `repos/${repo}/pulls/${number}`, '--jq', '[.state, .merged, .mergeable_state] | @tsv']);
      if (!out) continue;
      const [state, merged, mergeable] = out.split('\t');
      session.prs.push({ number, state, merged: merged === 'true', mergeable });
    }
  }
  return session;
}

/**
 * @param {string} transcriptPath
 * @param {{ now?: number, remote?: boolean }} [opts]
 */
export function watch(transcriptPath, opts = {}) {
  return inspect(readSession(fs.readFileSync(transcriptPath, 'utf8').split('\n')), transcriptPath, opts);
}

/** @param {Session} s */
export function formatUnits(s) {
  const lines = [];
  const running = s.units.filter(alive);
  if (!running.length) lines.push('unit-watch: no unit is running');
  for (const u of running) {
    const pr = u.pr ? `PR #${u.pr.number} ${u.pr.merged ? 'merged' : u.pr.state}${s.watched.has(u.pr.number) ? ' (watched)' : ''}` : 'no PR yet';
    lines.push(`unit ${u.id.slice(0, 8)} ${u.type} "${u.description}": idle ${u.idleMin ?? '?'} min, ${u.branch || 'no branch'}, ${pr}`);
  }
  for (const p of s.prs ?? []) lines.push(`watched PR #${p.number}: ${p.merged ? 'merged' : p.state}${p.state === 'open' ? `, ${p.mergeable}` : ''}`);
  for (const t of unitTodos(s)) lines.push(`FLAG: ${t}`);
  return lines.join('\n');
}
