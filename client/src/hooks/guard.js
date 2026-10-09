// PreToolUse. Refuses the few things no agent may do, whatever its prompt says:
//   Bash:        a push to main or master by any agent (a branch and a pull request instead); a force push (except
//                --force-with-lease); rm -rf at or above the repository; a unit checking out main; a unit's pure wait
//                (sleep, polling loop) once its measured waiting passed WAIT_CAP_SEC, so it hands back BLOCKED; a
//                subagent's pattern kill (pkill, killall), which can stop other agents' processes in a shared sandbox.
//   Edit/Write:  a subagent touching the repo's protectedPaths (the main session owns those).

import fs from 'node:fs';
import path from 'node:path';

import { config, matcher } from '../config.js';
import { root } from '../git.js';
import { isPureWait, isUnitType, waitsFile, WAIT_CAP_SEC } from '../units.js';

import { deny } from './io.js';

/**
 * The refusal for one git push, or null.
 * @param {string} s one shell segment, starting with `git push`
 */
function pushRefusal(s) {
  const refspecs = s.split(/\s+/).slice(2).filter((w) => !w.startsWith('-'));
  // A refspec starting with + forces that ref, flag or not.
  if (((/\s(-f|--force)(\s|$)/.test(s) && !/--force-with-lease/.test(s)) || refspecs.some((w) => w.startsWith('+')))) {
    return 'force push is not allowed; use --force-with-lease if you must, or rebase';
  }
  const toMain = refspecs.some((w) => /(^|:)(refs\/heads\/)?(main|master)$/.test(w));
  return toMain ? 'no agent pushes to main: push a branch and open a pull request' : null;
}

/**
 * A unit's waiting is measured: a command that only waits starts a clock, the unit's next tool call stops it. Once
 * the total passes the cap, the next such command is refused (one that also builds, tests or commits never is). The
 * SubagentStop hook clears the total.
 * @param {string} agentId
 * @param {string | null} cmd
 */
function capWaits(agentId, cmd) {
  const p = waitsFile(agentId);
  let w = { total: 0, since: /** @type {number | null} */ (null) };
  try {
    w = { ...w, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    /* fresh */
  }
  if (w.since) w.total += Math.max(0, (Date.now() - w.since) / 1000);
  w.since = null;
  let refusal = null;
  if (cmd !== null && isPureWait(cmd)) {
    if (w.total >= WAIT_CAP_SEC) {
      refusal = `you have waited ${Math.round(w.total / 60)} min on something outside your own work. Do not wait again: hand back now with "BLOCKED: waiting on <what, and since when>", so the parent can act`;
    } else w.since = Date.now();
  }
  fs.writeFileSync(p, JSON.stringify(w) + '\n');
  return refusal;
}

/** @param {any} input */
export default async function guard(input) {
  const agent = input.agent_type || 'main';
  const isUnit = isUnitType(agent);
  const tool = input.tool_name;

  if (tool === 'Bash') {
    const cmd = String(input.tool_input?.command || '');
    for (const seg of cmd.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
      const s = seg.trim().replace(/^(\w+=\S+\s+)+/, '');
      const refusal =
        (/^git\s+push\b/.test(s) && pushRefusal(s)) ||
        (/^git\s+checkout\s+(main|master)\b/.test(s) && agent !== 'main' && 'units stay on the task branch') ||
        (/^(pkill|killall)\b/.test(s) && agent !== 'main' && 'a pattern kill can stop other agents\' processes in this sandbox; kill the pid you started') ||
        (/^rm\s+(-\w*r\w*f|-\w*f\w*r)\b/.test(s) && atOrAbove(s.replace(/^rm\s+\S+\s*/, '').trim()) && 'recursive delete at or above the repository is not allowed');
      if (refusal) return deny(refusal);
    }
    const waited = isUnit ? capWaits(input.agent_id || agent, cmd) : null;
    return waited ? deny(waited) : undefined;
  }

  if (isUnit) capWaits(input.agent_id || agent, null);

  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && agent !== 'main') {
    const rel = path.relative(root(), String(input.tool_input?.file_path || input.tool_input?.notebook_path || '')).replace(/\\/g, '/');
    if (matcher(config()?.protectedPaths ?? [])(rel)) return deny(`${agent} may not edit ${rel}; it is the main session's. Put the suggestion in "papercuts" in your hand-back instead`);
  }
}

/** @param {string} target */
const atOrAbove = (target) => !target || target === '.' || target === '/' || target === '..' || target.startsWith('/') || target.startsWith('..');
