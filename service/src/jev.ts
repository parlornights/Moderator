import { z } from 'zod';

export type Question =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answers = Record<string, { noul?: number; score?: number }>;
export type Ask = (state: unknown, questions: Record<string, Question>) => Promise<Answers | null>;

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';

/** One request to Jev with several independent questions. Null when Jev is unreachable or errs. */
export const askJev =
  (key: string, fetcher: typeof fetch = fetch): Ask =>
  async (state, questions) => {
    try {
      const res = await fetcher(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { answers?: Answers };
      return data.answers ?? null;
    } catch {
      return null;
    }
  };

const T = { unitOpusScore: 2, riskNoul: 0.6, askNoul: 0.6, reviewerOpusNoul: 0.6, verdictBlock: 0.3, judgePass: 0.5 };
const p2 = (n = 0) => Math.round(n * 100) / 100;

/** Prose is judged against a few acceptable and unacceptable samples, never matched with patterns. */
export interface Samples {
  question: string;
  good: string[];
  bad: string[];
}

function judgeQuestions(samples: Record<string, Samples>) {
  const questions: Record<string, Question> = {};
  const state: Record<string, { acceptable: string[]; unacceptable: string[] }> = {};
  for (const [key, s] of Object.entries(samples)) {
    state[key] = { acceptable: s.good, unacceptable: s.bad };
    questions[key] = {
      type: 'noul',
      instructions: `${s.question} Judge against samples.${key}: acceptable when it does what the acceptable samples do, within their boundaries.`,
      criteria: { true: 'Acceptable within the boundaries of the acceptable samples', false: 'Falls short of the acceptable samples, or does what an unacceptable one does' },
    };
  }
  return { questions, samples: state };
}

function judgeResult(answers: Answers, keys: string[]) {
  const checks = Object.fromEntries(keys.map((k) => [k, { pass: (answers[k]?.noul ?? 0) >= T.judgePass, p: p2(answers[k]?.noul) }]));
  return { pass: Object.values(checks).every((c) => c.pass), checks };
}

interface Check<I extends z.ZodType> {
  input: I;
  build(i: z.infer<I>): { state: unknown; questions: Record<string, Question> };
  decide(answers: Answers, i: z.infer<I>): { pass?: boolean } & Record<string, unknown>;
}

const check = <I extends z.ZodType>(c: Check<I>) => c;

/** A check judged only by samples: `text` fields go to Jev as they are. */
const judged = <I extends z.ZodObject>(input: I, samples: Record<string, Samples>) =>
  check({
    input,
    build: (i) => {
      const { questions, samples: s } = judgeQuestions(samples);
      return { state: { ...i, samples: s }, questions };
    },
    decide: (a) => judgeResult(a, Object.keys(samples)),
  });

const QUESTION = `- Q1: The export test fails because the approved design removed the default file name; how should the test name its file?
  - A: the test types a name first, then checks the export exactly as strictly as now.
  - B: put the default name back, which contradicts the approved design.
  - Recommend: A, because the behaviour tested stays the same and only its outdated starting point moves.`;

const QUESTION_SAMPLES: Record<string, Samples> = {
  wellFormed: {
    question:
      'Is every question in open_questions one clear question, with at least two options that each say what they lead to, and a recommendation that names an option and gives its reason?',
    good: [QUESTION],
    bad: ['- Should I merge #12 now?', '- Q3: Which runner should checks use?\n  - Recommend: the fast one'],
  },
  repeated: {
    question:
      'Does last_message end with every question in open_questions in full: its question, every option and the recommendation with its reason (wording, markdown and line breaks may differ)?',
    good: [`#42 merged; the browser tests are re-running.\n\n${QUESTION}`],
    bad: ['#42 merged. Q1 is still waiting on you.', 'Q1: how should the export test name its file? Recommend A.'],
  },
  asksOwner: {
    question: 'Does last_message ask the owner for a new decision now, rather than only report or repeat the questions already in open_questions?',
    good: ['NEEDS DECISION: which icon for the filter? | A: star | B: grid | Recommend: A, because it reads at 16 px', `CI is out of minutes. Where should the checks run?\n\n${QUESTION}`],
    bad: ['#42 merged; the browser tests are re-running.', `Nothing new at this check-in; both PRs wait on CI.\n\n${QUESTION}`],
  },
};

export const LINEAR_SAMPLES = {
  issue: {
    question:
      'Is this a product task, or a problem in the owner\'s words, that says what "done" looks like, and not work on the agents\' own tooling?',
    good: [
      'Title: Players can rename a saved game\nDescription: From the game list a player renames a saved game. Done when the new name shows in the list and survives a reload.',
      'Title: Sign in does nothing on Android\nDescription: Owner: "I tap Sign in on my Pixel and nothing happens." Done when sign-in works on Android.',
    ],
    bad: ['Title: Fix the stop hook regex\nDescription: The harness stop hook misses the Decisions heading.', 'Title: Look into performance\nDescription: Things feel slow.'],
  },
  text: {
    question: 'Is this issue text product-level (what is wanted and what done looks like), not progress, logs or tooling detail?',
    good: ['From the game list a player renames a saved game. Done when the new name shows in the list and survives a reload.'],
    bad: ['Gate GREEN at tree 3f2a, oxlint passed, PR #41 open.', 'Working on it, half the tests pass.'],
  },
  comment: {
    question:
      'Is this a settled product update (an owner decision with its reason, an approval, a design link, what merged or shipped), and not a question, progress or tooling detail?',
    good: ['Owner decided: the filter shows All, Chess and Go, because those are the games live today.', 'Merged in #42: players can rename saved games. It ships with the next release.'],
    bad: ['Working on it, tests are running.', 'Should the filter include Go?', 'Gate GREEN at tree 3f2a; oxlint passed.'],
  },
} satisfies Record<string, Samples>;

export const checks = {
  pick: check({
    input: z.object({ issue: z.string().default(''), brief: z.string().min(1).max(12_000) }),
    build: (i) => ({
      state: {
        ...i,
        samples: {
          complexity: [
            { brief: 'Rename the Settings "Sign out" button to "Log out" and update its test', score: 0 },
            { brief: 'Move game rooms from one Durable Object per game to one per player; migrate open games', score: 3 },
          ],
          risky: [
            { brief: 'Release seeds the test accounts from a secret before its pre-flight', risky: true },
            { brief: 'The Home card shows whole names at 360 px', risky: false },
          ],
          ambiguous: [
            { brief: 'Add a filter to the Market', ambiguous: true, why: 'which filter and where are not said' },
            { brief: 'The Market gets a game filter (All, Chess, Go) as on the approved board', ambiguous: false },
          ],
        },
      },
      questions: {
        complexity: {
          type: 'score',
          instructions: 'How complex is the implementation this ticket asks for? samples.complexity shows a brief at each end of the scale.',
          criteria: [
            'Mechanical: one package, pattern already exists in the repo, no design choice',
            'Contained: one or two packages, some judgment, design is settled by the brief',
            'Cross-cutting: several packages, a contract or schema changes, ordering matters',
            'Architectural: a design decision shapes the rest; new subsystem, migration, or auth/data/money path',
          ],
        },
        risky: {
          type: 'noul',
          instructions: 'Does the ticket touch authentication, user data integrity, payments, deployments or infrastructure? samples.risky shows one of each.',
          criteria: { true: 'The brief names auth, sessions, migrations, payments, deploy or infra files', false: 'UI, content, tests or isolated logic only' },
        },
        ambiguous: {
          type: 'noul',
          instructions: 'Do the acceptance criteria leave a product or design choice open that would change the code? samples.ambiguous shows one of each.',
          criteria: { true: 'Two reasonable readings lead to different implementations and the brief does not settle it', false: 'The criteria determine the implementation' },
        },
      },
    }),
    decide: (a) => {
      const complexity = p2(a.complexity?.score);
      const risky = p2(a.risky?.noul);
      const ambiguous = p2(a.ambiguous?.noul);
      return { unit: complexity >= T.unitOpusScore || risky >= T.riskNoul ? 'unit-deep' : 'unit', ask: ambiguous >= T.askNoul, complexity, risky, ambiguous };
    },
  }),

  reviewer: check({
    input: z.object({ files: z.array(z.string()).max(200), numstat: z.array(z.string()).max(200), commits: z.array(z.string()).max(50) }),
    build: (i) => ({
      state: i,
      questions: {
        needs_strong_review: {
          type: 'noul',
          instructions: 'Does this change need the strongest available reviewer rather than a standard one?',
          criteria: {
            true: 'Touches auth, data integrity, migrations, payments, infra, concurrency, or a contract other packages depend on; or is large and cross-cutting',
            false: 'Local, well-scoped, pattern-following change with tests alongside',
          },
        },
      },
    }),
    decide: (a) => ({ opus: (a.needs_strong_review?.noul ?? 0) >= T.reviewerOpusNoul, p: p2(a.needs_strong_review?.noul) }),
  }),

  verdict: check({
    input: z.object({ criteria: z.array(z.string().min(1)).min(1).max(30), diff: z.string().max(24_000), summary: z.unknown().optional() }),
    build: (i) => ({
      state: {
        diff: i.diff,
        summary: i.summary,
        samples: {
          met: { criterion: 'A name longer than 24 characters is refused on save', diff: "validate.ts: if (name.length > 24) return error('name.tooLong')\nvalidate.test.ts: expect(save('x'.repeat(25))).toEqual(error('name.tooLong'))" },
          unmet: { criterion: 'A name longer than 24 characters is refused on save', diff: "validate.ts: if (name.length > 24) return error('name.tooLong')  (no test touches it)" },
        },
      },
      questions: Object.fromEntries(
        i.criteria.map((text, n) => [
          `c${n + 1}`,
          {
            type: 'noul',
            instructions: `Does the diff implement this acceptance criterion, with a test that exercises it? samples.met and samples.unmet show the line between them. Criterion: ${text}`,
            criteria: { true: 'The diff contains the behavior and a test that would fail without it', false: 'The behavior is missing, partial, or untested' },
          } satisfies Question,
        ]),
      ),
    }),
    decide: (a, i) => {
      const results = i.criteria.map((criterion, n) => ({ criterion, p: p2(a[`c${n + 1}`]?.noul) }));
      const block = results.filter((r) => r.p < T.verdictBlock);
      return { pass: block.length === 0, results, block };
    },
  }),

  'open-questions': check({
    input: z.object({ open_questions: z.string().max(20_000), last_message: z.string().max(8_000) }),
    build: (i) => {
      const keys = i.open_questions.trim() ? ['wellFormed', 'repeated', 'asksOwner'] : ['asksOwner'];
      const { questions, samples } = judgeQuestions(Object.fromEntries(keys.map((k) => [k, QUESTION_SAMPLES[k]])));
      return { state: { open_questions: i.open_questions.trim() || '(none)', last_message: i.last_message, samples }, questions };
    },
    decide: (a, i) => {
      const { checks } = judgeResult(a, i.open_questions.trim() ? ['wellFormed', 'repeated', 'asksOwner'] : ['asksOwner']);
      const { asksOwner, ...questions } = checks;
      // pass: the open questions are whole and repeated; asking: the message asks the owner for a decision.
      return { pass: Object.values(questions).every((c) => c.pass), asking: asksOwner.pass, checks };
    },
  }),

  'needs-decision': judged(z.object({ escalation: z.string().min(1).max(4_000) }), {
    decision: {
      question: 'Does this NEEDS DECISION line give one question, at least two options and a recommendation that names an option with its reason?',
      good: [
        'which icon for the All games filter? | options: A star / B grid | recommend: A because it reads at 16 px',
        'keep the 20-character heading cap or allow 24? | options: A 20 / B 24 | recommend: B because the approved board shows 24',
      ],
      bad: ['what should I do about the failing test?', 'which icon? | options: A star / B grid'],
    },
  }),

  'linear-issue': judged(z.object({ title: z.string(), description: z.string() }), { issue: LINEAR_SAMPLES.issue }),
  'linear-text': judged(z.object({ text: z.string() }), { text: LINEAR_SAMPLES.text }),
  'linear-comment': judged(z.object({ body: z.string() }), { comment: LINEAR_SAMPLES.comment }),
};

export type CheckName = keyof typeof checks;

/** Runs one check; null when Jev did not answer. */
export async function runCheck(ask: Ask, name: CheckName, input: unknown) {
  const c = checks[name] as Check<z.ZodType>;
  const i = c.input.parse(input);
  const { state, questions } = c.build(i);
  const answers = await ask(state, questions);
  return answers ? c.decide(answers, i) : null;
}
