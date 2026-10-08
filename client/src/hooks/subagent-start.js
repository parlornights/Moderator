// SubagentStart (matcher: unit|unit-deep). Records the running unit in .work/<issue>/running.json.

import path from 'node:path';

import { appendEvent, readJson, workDir, writeJson } from '../work.js';

/** @param {any} input */
export default async function subagentStart(input) {
  const p = path.join(workDir(), 'running.json');
  const running = readJson(p, {});
  running[input.agent_id || `unknown-${Date.now()}`] = { agent_type: input.agent_type || 'unit', started: new Date().toISOString() };
  writeJson(p, running);
  appendEvent('unit:start', { agent: input.agent_type, id: String(input.agent_id || '').slice(0, 8) });
}
