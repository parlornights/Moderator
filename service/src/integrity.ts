import * as audit from './audit';
import type { Env } from './env';
import { CONTEXT, type GitHub } from './github';
import { existingTestHunks, type Hunk } from './hunks';
import type { Answers, Ask, Question } from './jev';
import type { Issue, Linear } from './linear';

/** A hunk is flagged when Jev's probability that it is sanctioned falls below this. */
export const SANCTIONED = 0.5;
/** More hunks than this are not judged one by one; the owner looks at the PR. */
export const MAX_HUNKS = 40;
const MAX_PATCH = 3_000;

export interface Finding extends Hunk {
  p: number | null;
  reason: string;
}

export interface PullRequestEvent {
  installation: { id: number };
  repository: { name: string; full_name: string; owner: { login: string } };
  pull_request: { number: number; title: string; head: { sha: string } };
}

const SAMPLES = {
  sanctioned: {
    ticket: 'Names may be 32 characters (was 24). Done when 32 is accepted and 33 refused.',
    hunk: "-  expect(valid('x'.repeat(25))).toBe(false);\n+  expect(valid('x'.repeat(33))).toBe(false);",
  },
  unsanctioned: [
    { ticket: 'Players can rename a saved game.', hunk: '-  expect(total).toBe(120);\n+  expect(total).toBeGreaterThan(0);', why: 'loosens an assertion the ticket does not touch' },
    { ticket: 'Players can rename a saved game.', hunk: "-  it('rejects an expired token', async () => {\n+  it.skip('rejects an expired token', async () => {", why: 'skips a test' },
  ],
};

export const issueIdIn = (title: string) => title.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null;

function questions(hunks: Hunk[]): Record<string, Question> {
  return Object.fromEntries(
    hunks.map((h, n) => [
      `h${n + 1}`,
      {
        type: 'noul',
        instructions: `Is hunks[${n}] (${h.file}) sanctioned? It is sanctioned when it does not weaken an existing test, or when the ticket asks for exactly this change. It is unsanctioned when it loosens an assertion, deletes or skips a test, or bends a test, fixture or snapshot to fit behaviour the ticket does not ask for. samples shows one sanctioned hunk and two unsanctioned ones.`,
        criteria: {
          true: 'Sanctioned: adds coverage, refactors without weakening, or makes the change the ticket asks for',
          false: 'Loosens, removes, skips or bends an existing test without the ticket asking for it',
        },
      } satisfies Question,
    ]),
  );
}

/** Judges each hunk that changes an existing test against the PR's ticket. Null findings: Jev did not answer. */
export async function judge(ask: Ask, ticket: Issue | null, hunks: Hunk[]): Promise<Finding[] | null> {
  const judged = hunks.filter((h) => h.patch !== null);
  let answers: Answers = {};
  if (judged.length) {
    const state = { ticket: ticket ?? '(the PR names no ticket)', hunks: judged.map((h) => ({ file: h.file, status: h.status, patch: h.patch!.slice(0, MAX_PATCH) })), samples: SAMPLES };
    const a = await ask(state, questions(judged));
    if (!a) return null;
    answers = a;
  }
  return hunks.flatMap((h): Finding[] => {
    if (h.patch === null) return [{ ...h, p: null, reason: 'GitHub shows no diff for this file (binary or too large), so Jev could not read it' }];
    const p = Math.round((answers[`h${judged.indexOf(h) + 1}`]?.noul ?? 0) * 100) / 100;
    return p < SANCTIONED ? [{ ...h, p, reason: 'Jev reads it as loosening, removing or bending an existing test the ticket does not ask to change' }] : [];
  });
}

export interface IntegrityDeps {
  github: GitHub;
  linear: Linear;
  jev: Ask;
}

const approveUrl = (env: Env, repo: string, sha: string) => `${env.PUBLIC_URL}/approve/${repo}/${sha}`;

/** Runs the check for one PR head and posts the `test-integrity` status. */
export async function check(env: Env, deps: IntegrityDeps, e: PullRequestEvent): Promise<void> {
  const { installation, repository, pull_request: pr } = e;
  const [owner, repo, sha] = [repository.owner.login, repository.name, pr.head.sha];
  const targetUrl = approveUrl(env, repository.full_name, sha);

  const prior = await env.DB.prepare('SELECT approved_by FROM integrity WHERE repo = ? AND sha = ?').bind(repository.full_name, sha).first<{ approved_by: string | null }>();
  if (prior?.approved_by) {
    await deps.github.setStatus(installation.id, owner, repo, sha, { state: 'success', description: `Approved by ${prior.approved_by}`, targetUrl });
    return;
  }

  const hunks = existingTestHunks(await deps.github.pullFiles(installation.id, owner, repo, pr.number));
  const issue = issueIdIn(pr.title);
  let findings: Finding[] | null;
  let description: string;
  if (!hunks.length) {
    findings = [];
    description = 'No existing test changed';
  } else if (hunks.length > MAX_HUNKS) {
    findings = [{ file: '(whole PR)', status: 'many', patch: null, p: null, reason: `${hunks.length} hunks change existing tests; more than ${MAX_HUNKS} are not judged one by one` }];
    description = `${hunks.length} test hunks changed: the owner's approval is needed`;
  } else {
    findings = await judge(deps.jev, issue ? await deps.linear.getIssue(issue) : null, hunks);
    description = findings === null ? "Jev did not answer: the owner's approval is needed" : findings.length ? `${findings.length} test change(s) need the owner's approval` : `${hunks.length} test change(s), all sanctioned`;
  }
  const state = findings !== null && findings.length === 0 ? 'success' : 'failure';

  await env.DB.prepare(
    `INSERT INTO integrity (repo, sha, installation_id, pr, title, issue, state, findings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, sha) DO UPDATE SET installation_id = excluded.installation_id, pr = excluded.pr, title = excluded.title, issue = excluded.issue, state = excluded.state, findings = excluded.findings, created_at = excluded.created_at`,
  )
    .bind(repository.full_name, sha, installation.id, pr.number, pr.title, issue, state, JSON.stringify(findings ?? hunks.map((h) => ({ ...h, p: null, reason: 'Jev did not answer' }))), new Date().toISOString())
    .run();
  await deps.github.setStatus(installation.id, owner, repo, sha, { state, description, targetUrl });
  await audit.record(env.DB, { action: `github/${CONTEXT}`, input: { repo: repository.full_name, pr: pr.number, sha, issue, hunks: hunks.length }, jev: findings, outcome: state, response: { description } });
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
  approved_by: string | null;
  approved_at: string | null;
}

export const getRow = (db: D1Database, repo: string, sha: string) => db.prepare('SELECT * FROM integrity WHERE repo = ? AND sha = ?').bind(repo, sha).first<IntegrityRow>();

/** The owner's sign for one SHA: the status turns green for it and stays green on reruns of that SHA. */
export async function approve(env: Env, gh: GitHub, row: IntegrityRow, email: string): Promise<void> {
  const [owner, repo] = row.repo.split('/');
  await gh.setStatus(row.installation_id, owner, repo, row.sha, { state: 'success', description: `Approved by ${email}`, targetUrl: approveUrl(env, row.repo, row.sha) });
  await env.DB.prepare("UPDATE integrity SET approved_by = ?, approved_at = ?, state = 'approved' WHERE repo = ? AND sha = ?").bind(email, new Date().toISOString(), row.repo, row.sha).run();
  await audit.record(env.DB, { action: `approve/${CONTEXT}`, input: { repo: row.repo, sha: row.sha, pr: row.pr }, outcome: 'approved', response: { by: email } });
}
