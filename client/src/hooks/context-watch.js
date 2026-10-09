// PostToolUse (every tool). Reads how full the context is from the transcript and, past the handoff share of the
// window, tells the session once to finish its step, write the handoff note for the next session and stop; once
// more, firmer, at the urgent share. The Stop hook holds the turn until the note has changed after the crossing.

import { config } from '../config.js';
import { noteHash } from '../handoff.js';
import { contextTokens } from '../transcript.js';
import { appendEvent, issueId, readEvents } from '../work.js';

import { context } from './io.js';

/** @param {any} input */
export default async function contextWatch(input) {
  // A unit's tool call carries the parent's session id: the budget is the parent's, and so is the handoff.
  if (input.agent_type || input.agent_id) return;
  const issue = issueId();
  const c = config();
  if (!issue || !c) return;
  const tokens = contextTokens(input.transcript_path);
  if (tokens === null) return;
  const { window, handoffShare } = c.context;
  const urgent = Math.min(0.95, handoffShare + 0.15);
  const share = tokens / window;
  if (share < handoffShare) return;
  const level = share >= urgent ? 'urgent' : 'handoff';
  const session = input.session_id || null;
  // Once per level, and again after a compaction (session-start records one), so a session that ignored the
  // warning and was compacted is warned again when it fills up.
  const lastWarn = readEvents('context-high').filter((e) => e.session === session && e.level === level).at(-1);
  const lastCompact = readEvents('session-start').filter((e) => e.session === session && e.source === 'compact').at(-1);
  if (lastWarn && !(lastCompact && lastCompact.t > lastWarn.t)) return;
  appendEvent('context-high', { session, level, tokens, note: noteHash() });
  return context(
    'PostToolUse',
    `${level === 'urgent' ? 'URGENT: c' : 'C'}ontext is at ${Math.round(share * 100)}% of the ${Math.round(window / 1000)}k window (handoff at ${Math.round(handoffShare * 100)}%). Start nothing new, but finish what is in hand including its trivial wrap-up (a ready merge, a closing note, a one-line follow-up); hand over only what genuinely needs a new session. Then write .work/${issue}/handoff.md for the next session: status, Next step, every decision with its reason, open questions for the owner, PRs and units in flight with their state. Commit and push, tell the owner in one line that a new session should take over from that note, and stop.`,
  );
}
