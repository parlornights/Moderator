// PreCompact (auto | manual). Writes the handoff note's auto block from the transcript and commits the note on a
// task branch; never blocks. SessionStart (compact) then points the new context at it.

import { branch, git, isMainBranch } from '../git.js';
import { writeHandoff } from '../handoff.js';
import { appendEvent, issueId } from '../work.js';

/** @param {any} input */
export default async function preCompact(input) {
  const issue = issueId();
  if (!issue) return;
  const p = writeHandoff({ transcriptPath: input.transcript_path, source: `precompact:${input.trigger || 'auto'}` });
  if (!isMainBranch(branch())) {
    git(['add', '--', p]);
    git(['commit', '-q', '-m', `wip(${issue}): handoff before compaction`, '--', p]);
  }
  appendEvent('compact', { trigger: input.trigger || 'auto' });
}
