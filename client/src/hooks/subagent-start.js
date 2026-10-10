// SubagentStart (matcher: unit|unit-deep). Records the running unit in .work/<issue>/running.json, with its session, and
// drops the entries of other sessions and of units started more than a day ago: their stop went unrecorded.

import path from 'node:path';

import { appendEvent, runningUnits, workDir, writeJson } from '../work.js';

/** @param {any} input */
export default async function subagentStart(input) {
  const session = input.session_id || null;
  const running = runningUnits({ session });
  running[input.agent_id || `unknown-${Date.now()}`] = { agent_type: input.agent_type || 'unit', started: new Date().toISOString(), session };
  writeJson(path.join(workDir(), 'running.json'), running);
  appendEvent('unit:start', { agent: input.agent_type, id: String(input.agent_id || '').slice(0, 8) });
}
