import * as audit from './audit';
import type { Env } from './env';
import { CONTEXT, type Check, type GitHub } from './github';
import { existingTestHunks, type Hunk } from './hunks';
import type { Answers, Ask, Question } from './jev';
import type { Linear, Ticket } from './linear';

/** A hunk is flagged when Jev's probability that the ticket sanctions it falls below this. */
export const SANCTIONED = 0.5;
/** Hunks go to Jev in requests of at most this many hunks and characters; every hunk is judged. */
const BATCH_HUNKS = 20;
const BATCH_CHARS = 40_000;

export interface Finding extends Hunk {
  p: number | null;
  reason: string;
}

export interface PullRequestEvent {
  installation: { id: number };
  repository: { name: string; full_name: string; owner: { login: string } };
  pull_request: { number: number; title: string; head: { sha: string }; user: { login: string }; created_at: string; changed_files: number };
}

/** Two of each, so the samples do not lean either way. */
const SAMPLES = [
  {
    ticket: 'Names may be 32 characters (was 24). Done when 32 is accepted and 33 refused.',
    hunk: "-  expect(valid('x'.repeat(25))).toBe(false);\n+  expect(valid('x'.repeat(33))).toBe(false);",
    sanctioned: true,
  },
  { ticket: 'Players can rename a saved game.', hunk: '-  expect(total).toBe(120);\n+  expect(total).toBeGreaterThan(0);', sanctioned: false },
  {
    ticket: 'Players can rename a saved game.',
    hunk: "-  const game = makeGame();\n+  const game = makeGame({ name: 'Old' });\n+  rename(game, 'New');\n+  expect(game.name).toBe('New');",
    sanctioned: true,
  },
  { ticket: 'Players can rename a saved game.', hunk: "-  it('rejects an expired token', async () => {\n+  it.skip('rejects an expired token', async () => {", sanctioned: false },
];

export const issueIdIn = (title: string) => title.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null;

const question = (n: number, h: Hunk): Question => ({
  type: 'noul',
  instructions: `Does the ticket sanction hunks[${n}], a change to an existing test, fixture or snapshot in ${h.file}? samples holds two sanctioned and two unsanctioned examples.`,
  criteria: {
    true: 'Sanctioned: the change keeps the test as strong as before, or makes the change the ticket asks for',
    false: 'Not sanctioned: the change weakens, removes, skips or bends the test in a way the ticket does not ask for',
  },
});

/** Splits hunks into Jev requests by count and size; a hunk larger than the limit goes alone. */
function batches(hunks: Hunk[]): Hunk[][] {
  const out: Hunk[][] = [];
  let size = 0;
  for (const h of hunks) {
    const last = out.at(-1);
    if (!last || last.length >= BATCH_HUNKS || size + h.patch!.length > BATCH_CHARS) {
      out.push([h]);
      size = h.patch!.length;
    } else {
      last.push(h);
      size += h.patch!.length;
    }
  }
  return out;
}

/**
 * Judges every hunk that changes an existing test against the PR's ticket. Null: Jev did not answer, so the caller
 * flags everything. A file GitHub shows no diff for is flagged: Jev cannot judge what it cannot read.
 */
export async function judge(ask: Ask, ticket: Ticket | null, hunks: Hunk[]): Promise<Finding[] | null> {
  const p = new Map<Hunk, number>();
  for (const batch of batches(hunks.filter((h) => h.patch !== null))) {
    const state = { ticket: ticket ?? '(no ticket text written before this work began)', hunks: batch.map((h) => ({ file: h.file, status: h.status, patch: h.patch })), samples: SAMPLES };
    const answers: Answers | null = await ask(state, Object.fromEntries(batch.map((h, n) => [`h${n + 1}`, question(n, h)])));
    if (!answers) return null;
    batch.forEach((h, n) => p.set(h, Math.round((answers[`h${n + 1}`]?.noul ?? 0) * 100) / 100));
  }
  return hunks.flatMap((h): Finding[] => {
    if (h.patch === null) return [{ ...h, p: null, reason: 'GitHub shows no diff for this file (binary or too large), so Jev could not read it' }];
    const ph = p.get(h)!;
    return ph < SANCTIONED ? [{ ...h, p: ph, reason: 'Jev does not read this change as sanctioned by the ticket' }] : [];
  });
}

export interface IntegrityDeps {
  github: GitHub;
  linear: Linear;
  jev: Ask;
}

const approveUrl = (env: Env, repo: string, sha: string) => `${env.PUBLIC_URL}/approve/${repo}/${sha}`;

/**
 * When the PR's work began: the earliest of GitHub's own PR creation time and every commit date. Commit dates are set
 * by whoever commits; backdating one only makes this earlier, which counts less ticket text.
 */
export async function workStart(gh: GitHub, e: PullRequestEvent): Promise<Date> {
  const dates = await gh.commitDates(e.installation.id, e.repository.owner.login, e.repository.name, e.pull_request.number);
  return new Date(Math.min(Date.parse(e.pull_request.created_at), ...dates.map(Date.parse).filter((d) => !Number.isNaN(d))));
}

interface Run {
  state: 'success' | 'failure';
  title: string;
  flagged: Finding[];
  hunks: number;
  issue: string | null;
}

/** Records a run unless the owner already decided this commit; false when they had. */
async function save(env: Env, e: PullRequestEvent, run: Run): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    `INSERT INTO integrity (repo, sha, installation_id, pr, title, issue, state, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, sha) DO UPDATE SET installation_id = excluded.installation_id, pr = excluded.pr, title = excluded.title, issue = excluded.issue, state = excluded.state, findings = excluded.findings, created_at = excluded.created_at
     WHERE integrity.state NOT IN ('approved', 'rejected')`,
  )
    .bind(e.repository.full_name, e.pull_request.head.sha, e.installation.id, e.pull_request.number, e.pull_request.title, run.issue, run.state, JSON.stringify(run.flagged), new Date().toISOString())
    .run();
  return meta.changes > 0;
}

/** Posts the check for a run, comments on the PR when it needs the owner, and audits it. */
async function publish(env: Env, gh: GitHub, e: PullRequestEvent, run: Run): Promise<void> {
  const { installation, repository, pull_request: pr } = e;
  const [owner, repo, sha] = [repository.owner.login, repository.name, pr.head.sha];
  const detailsUrl = approveUrl(env, repository.full_name, sha);
  if (!(await save(env, e, run))) {
    // The owner decided this commit while the run was in flight: their decision stands.
    const row = await getRow(env.DB, repository.full_name, sha);
    if (row) await gh.setCheck(installation.id, owner, repo, sha, decisionCheck(env, row));
    return;
  }
  const summary = run.flagged.map((f) => `- \`${f.file}\`${f.p === null ? '' : ` (sanctioned p=${f.p})`}: ${f.reason}`).join('\n') || run.title;
  await gh.setCheck(installation.id, owner, repo, sha, { conclusion: run.state === 'success' ? 'success' : 'action_required', title: run.title, summary, detailsUrl });
  await audit.record(env.DB, { action: `github/${CONTEXT}`, input: { repo: repository.full_name, pr: pr.number, sha, issue: run.issue, hunks: run.hunks }, jev: run.flagged, outcome: run.state, response: { title: run.title } });
  if (run.state === 'failure') await commentSafely(gh, installation.id, owner, repo, pr.number, `@${pr.user.login} **test-integrity** on ${short(sha)}: ${run.title}.\n\n${summary}\n\nApprove or reject: ${detailsUrl}`);
}

/** Runs the check for one PR head and posts the `test-integrity` check run. */
export async function check(env: Env, deps: IntegrityDeps, e: PullRequestEvent): Promise<void> {
  const { installation, repository, pull_request: pr } = e;
  const prior = await getRow(env.DB, repository.full_name, pr.head.sha);
  if (prior?.state === 'approved' || prior?.state === 'rejected') {
    await deps.github.setCheck(installation.id, repository.owner.login, repository.name, pr.head.sha, decisionCheck(env, prior));
    return;
  }

  const files = await deps.github.pullFiles(installation.id, repository.owner.login, repository.name, pr.number);
  const hunks = existingTestHunks(files);
  const issue = issueIdIn(pr.title);
  const ticket = issue && hunks.length ? await deps.linear.ticketBefore(issue, await workStart(deps.github, e)) : null;
  const findings = hunks.length ? await judge(deps.jev, ticket, hunks) : [];
  const flagged = findings ?? hunks.map((h): Finding => ({ ...h, p: null, reason: 'Jev did not answer' }));
  if (files.length < pr.changed_files)
    flagged.push({ file: '(whole PR)', status: 'unlisted', patch: null, p: null, reason: `GitHub listed ${files.length} of the PR's ${pr.changed_files} files, so the rest were not checked` });
  const title = flagged.length
    ? findings === null
      ? "Jev did not answer: the owner's decision is needed"
      : `${flagged.length} test change(s) need the owner's decision`
    : hunks.length
      ? `${hunks.length} test change(s), all sanctioned`
      : 'No existing test changed';
  await publish(env, deps.github, e, { state: flagged.length ? 'failure' : 'success', title, flagged, hunks: hunks.length, issue });
}

/** A run that threw still leaves a red check and a row, so the PR does not wait forever and the owner can decide. */
export async function errored(env: Env, gh: GitHub, e: PullRequestEvent, err: unknown): Promise<void> {
  const reason = `The check errored: ${err instanceof Error ? err.message : String(err)}`;
  await publish(env, gh, e, { state: 'failure', title: "The check errored: the owner's decision is needed", flagged: [{ file: '(check)', status: 'error', patch: null, p: null, reason }], hunks: 0, issue: issueIdIn(e.pull_request.title) });
}

const short = (sha: string) => sha.slice(0, 7);

/** The check and the record are what count; a comment that fails is logged, not retried. */
async function commentSafely(gh: GitHub, installationId: number, owner: string, repo: string, pr: number, body: string) {
  try {
    await gh.comment(installationId, owner, repo, pr, body);
  } catch (e) {
    console.error('test-integrity comment failed', `${owner}/${repo}#${pr}`, e);
  }
}

function decisionCheck(env: Env, row: IntegrityRow): Check {
  const detailsUrl = approveUrl(env, row.repo, row.sha);
  return row.state === 'approved'
    ? { conclusion: 'success', title: `Approved by ${row.decided_by}`, summary: `The owner approved the test changes in ${row.sha}.`, detailsUrl }
    : { conclusion: 'failure', title: `Rejected by the owner${row.reason ? `: ${row.reason}` : ''}`, summary: row.reason ?? 'Rejected without a reason.', detailsUrl };
}

export interface IntegrityRow {
  repo: string;
  sha: string;
  installation_id: number;
  pr: number;
  title: string;
  issue: string | null;
  state: string;
  findings: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

export const getRow = (db: D1Database, repo: string, sha: string) => db.prepare('SELECT * FROM integrity WHERE repo = ? AND sha = ?').bind(repo, sha).first<IntegrityRow>();

/**
 * The owner's decision on one commit. Approve: the status turns green for that commit only. Reject: it stays red, and
 * the App comments on the PR with the reason so the agent working on it sees it.
 */
export async function decide(env: Env, gh: GitHub, row: IntegrityRow, d: { by: string; approve: boolean; reason?: string }): Promise<void> {
  const decided: IntegrityRow = { ...row, state: d.approve ? 'approved' : 'rejected', decided_by: d.by, decided_at: new Date().toISOString(), reason: d.reason?.trim() || null };
  const [owner, repo] = row.repo.split('/');
  await env.DB.prepare('UPDATE integrity SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE repo = ? AND sha = ?')
    .bind(decided.state, decided.decided_by, decided.decided_at, decided.reason, row.repo, row.sha)
    .run();
  await gh.setCheck(row.installation_id, owner, repo, row.sha, decisionCheck(env, decided));
  if (!d.approve) {
    const body = [`The owner **rejected** the test changes in ${short(row.sha)}.`, decided.reason ? `\n> ${decided.reason.replace(/\n/g, '\n> ')}` : '', '\nRevert or rework them, then push; the new commit is checked again.'].join('\n');
    await commentSafely(gh, row.installation_id, owner, repo, row.pr, body);
  }
  await audit.record(env.DB, { action: `${d.approve ? 'approve' : 'reject'}/${CONTEXT}`, input: { repo: row.repo, sha: row.sha, pr: row.pr, reason: decided.reason }, outcome: decided.state, response: { by: d.by } });
}
