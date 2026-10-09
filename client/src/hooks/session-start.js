// SessionStart (startup | resume | clear | compact | fork). The role (role.md: every session is an orchestrator),
// then the orient block, then the lines that send the agent to the issue, the repo's start docs and the papercut log.
// After a compaction it first refreshes the handoff note's auto block, so the turns the new context reads are the
// ones that were just summarized away.

import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { root } from '../git.js';
import { writeHandoff } from '../handoff.js';
import { fitSessionContext, orient } from '../orient.js';
import { papercutPointer } from '../papercut.js';
import { appendEvent, issueId } from '../work.js';

import { context } from './io.js';

const ROLE = new URL('../../role.md', import.meta.url);

/** The line that sends the agent to the repo's start docs that exist; empty when none does. */
export function docsPointer() {
  const present = (config()?.readAtStart ?? []).filter((d) => fs.existsSync(path.join(root(), d.path)));
  if (!present.length) return '';
  return `Docs: read ${present.map((d) => d.path).join(' and ')} in full now, right after CLAUDE.md. ${present.map((d) => d.why).join('; ')}.`;
}

/** @param {any} input */
export default async function sessionStart(input) {
  const source = input.source || 'startup';
  const issue = issueId();
  if (issue && source === 'compact') writeHandoff({ transcriptPath: input.transcript_path, source: 'compact' });
  if (issue) appendEvent('session-start', { source, session: input.session_id || null });

  const tail = [];
  if (issue && source !== 'compact') {
    tail.push(`Linear: read ${issue} first (get_issue, list_comments); it is the task's context. Product decisions, approvals, designs and what shipped go back to it with \`moderator linear\`. The Stop hook checks the read.`);
  }
  // A missing doc or an unreadable log never costs the orient block.
  for (const line of [docsPointer, papercutPointer]) {
    try {
      tail.push(line());
    } catch {
      /* left out */
    }
  }
  const text = fitSessionContext({ head: fs.readFileSync(ROLE, 'utf8').trim(), middle: orient({ source }), tail: tail.filter(Boolean).join('\n\n') });
  const extra = ['startup', 'resume', 'fork'].includes(source) && !input.session_title && issue ? { sessionTitle: issue } : {};
  return context('SessionStart', text, extra);
}
