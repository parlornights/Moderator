// Stop (the main session), on a branch whose name or open PR's title names an issue (a branch that names none blocks
// once per session, saying the task has no issue, and is left as it is):
//   1. commit whatever is uncommitted (code and .work/) as a checkpoint, unless a unit is still editing this checkout;
//   2. block once for what is left to do: units without a check-in or a watched PR, open questions that are not
//      whole or not repeated (judged by Jev), a stale handoff note, the issue never read on Linear, an artifact not
//      tied to an issue, a context past its hand-over share;
//   3. push the branch, so a dead VM loses nothing; a note-only change waits up to 30 minutes.
// On main it does nothing. It never blocks twice in a row (stop_hook_active), and never blocks on Jev: when Jev does
// not answer it says the check did not run.

import { jev } from '../api.js';
import { branch, git, isMainBranch } from '../git.js';
import { contextHandoffDue, handedOver, linearGaps, section, staleness, unlinkedArtifacts, writeHandoff } from '../handoff.js';
import { alive, approvalTodos, unitTodos, watch } from '../units.js';
import { appendEvent, issueFromPr, issueId, issuePattern, runningUnits } from '../work.js';

import { block } from './io.js';

/**
 * The unpushed commits touch only .work/ and the branch was pushed less than 30 minutes ago: hold the push. Every
 * push re-runs the PR's CI and cancels the run in progress, so a note-only push per turn kept a PR from ever
 * finishing CI. Code, and a note older than 30 minutes, still go out at once.
 */
function stateOnlyAndRecent() {
  const files = git(['diff', '--name-only', '@{u}..HEAD']);
  if (!files) return files === '';
  if (files.split('\n').some((f) => !f.startsWith('.work/'))) return false;
  const pushedAt = Number(git(['log', '-1', '--format=%ct', '@{u}']) || 0);
  return Date.now() / 1000 - pushedAt < 30 * 60;
}

/** A merge, cherry-pick or revert stopped half way: committing now would commit its conflict markers. */
function operationInProgress() {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((ref) => git(['rev-parse', '-q', '--verify', ref]) !== null) || Boolean(git(['diff', '--name-only', '--diff-filter=U']));
}

/**
 * What the open-question check asks for: Jev judges whether the note's open questions are whole and the last
 * message repeats them, and whether the message asks the owner for a decision.
 * @param {string} last
 */
async function questionCheck(last) {
  const open = section('Open questions').replace(/^\(none\)$/i, '');
  const r = await jev('open-questions', { open_questions: open.slice(0, 20_000), last_message: last.slice(-8000) });
  if (!r) return { ran: false, asking: false, todo: [] };
  const todo = [];
  if (r.checks?.wellFormed && !r.checks.wellFormed.pass) {
    todo.push('the open questions in the handoff note are not each one question with two or more options, each saying what it leads to, and a recommendation with its reason: "- Q<n>: <question>", indented "- A: …", "- B: …", "- Recommend: <letter>, because <reason>"');
  }
  if (r.checks?.repeated && !r.checks.repeated.pass) todo.push('end your message with every open question in full: its number, question, every option, and the recommendation with its reason');
  if (r.asking && !open) todo.push('this message asks the owner, but the handoff note has no open question: record it under "## Open questions" as "- Q<n>: <question>" with its options and "- Recommend: <letter>, because <reason>"');
  return { ran: true, asking: Boolean(r.asking), todo };
}

/**
 * Neither the branch nor its open PR names an issue: nothing is committed or pushed, and the session is told once, so
 * a task never goes on without its ledger unnoticed. Git config keeps which session was told.
 * @param {string} b
 * @param {any} input
 */
function noIssue(b, input) {
  if (input.stop_hook_active) return;
  const key = `branch.${b}.moderatorNoIssueSession`;
  const session = String(input.session_id || 'unknown');
  if (git(['config', '--get', key]) === session) return;
  git(['config', key, session]);
  return block(
    `This task has no issue: neither the branch "${b}" nor an open PR's title names one (${issuePattern()?.source}), so the Stop hook commits, pushes and checks nothing here. Put the issue id in the branch name (git branch -m) or in the PR's title; file the issue first with \`moderator linear issue\` if there is none. Then stop again.`,
  );
}

/** @param {any} input */
export default async function stop(input) {
  const b = branch();
  if (isMainBranch(b) || !issuePattern()) return;
  const issue = issueId() || issueFromPr();
  if (!issue) return noIssue(b, input);
  // The agent stopped in the middle of a merge (to ask about a conflict, say): the checks run, but nothing is
  // committed or pushed until the merge ends, so no conflict marker leaves the machine.
  const midMerge = operationInProgress();

  // Running units, read from the session transcript: each needs an armed check-in and a watched PR, and one that
  // stalled or whose PR merged is named. The second pass skips GitHub. running.json is the fallback.
  let session = null;
  /** @type {string[]} */
  let unitTodo = [];
  try {
    if (input.transcript_path) session = watch(input.transcript_path, { remote: !input.stop_hook_active });
    if (session && !input.stop_hook_active) unitTodo = [...unitTodos(session, Date.now(), { handedOver: handedOver() }), ...approvalTodos(session, String(input.last_assistant_message || ''))];
  } catch (e) {
    process.stderr.write(`moderator: unit check skipped: ${e instanceof Error ? e.message : e}\n`);
  }

  // A unit still editing this checkout (no worktree of its own): leave the index alone, ask only about the units.
  const running = session ? session.units.filter((u) => alive(u) && !u.worktree).length : Object.keys(runningUnits({ session: input.session_id || null })).length;
  if (running > 0) return unitTodo.length ? block(`Before stopping (units):\n- ${unitTodo.join('\n- ')}\nThen stop again.`) : undefined;

  if (!midMerge) {
    git(['add', '-A']);
    git(['commit', '-q', '-m', `wip(${issue}): checkpoint`]);
  }

  const why = staleness();
  /** @type {string | undefined} */
  let notice;
  if (!input.stop_hook_active) {
    const todo = [...unitTodo];
    const questions = await questionCheck(String(input.last_assistant_message || ''));
    if (!questions.ran) notice = 'Moderator: the open-question check did not run (Jev or the service did not answer).';
    todo.push(...questions.todo);
    // A turn that asks the owner is held only for its questions; the note and Linear wait for the answer.
    if (!questions.asking) {
      if (why) todo.push(`update .work/${issue}/handoff.md (${why}): fill Next step, Decisions and Criteria as they stand now, keep it under 60 lines above the auto block; if the task is finished, set "status: done" at the top`);
      const due = contextHandoffDue({ sessionId: input.session_id });
      if (due) todo.push(due);
      todo.push(...linearGaps({ transcriptPath: input.transcript_path }));
      const unlinked = unlinkedArtifacts();
      if (unlinked.length) {
        todo.push(`published but not tied to a Linear issue: ${unlinked.join(', ')}. Add each URL to its issue (moderator linear update <ID> --link <url> --link-title <title>; file one if none exists) and put the URL and the issue id on one line of .work/${issue}/handoff.md`);
      }
    }
    if (todo.length) return block(`Before stopping:\n- ${todo.join('\n- ')}\nThen stop again.`, notice ? { systemMessage: notice } : {});
  }

  // Nothing new since the last push (a turn that only read): write nothing, so no commit re-runs the PR's CI.
  if (!midMerge && git(['rev-list', '--count', '@{u}..HEAD']) !== '0') {
    // The event goes in before the commit, so the turn ends on a clean tree; only a failed push leaves a line.
    appendEvent('stop', { stale: why || null });
    writeHandoff({ transcriptPath: input.transcript_path, source: 'stop' });
    git(['add', '-A']);
    git(['commit', '-q', '-m', `wip(${issue}): handoff`]);
    if (!stateOnlyAndRecent() && git(['push', '-u', 'origin', b]) === null) appendEvent('push-failed', {});
  }
  return notice ? { json: { systemMessage: notice } } : undefined;
}
