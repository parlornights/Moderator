#!/usr/bin/env node
// moderator: the session's local tools and its hooks. `moderator help` lists the commands.

import fs from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `moderator <command>

  scope [--base <ref>] [--json]                 what the current diff needs checked (nothing runs)
  gate [--plan] [--only a,b] [--skip a,b] [--if-changed] [--base <ref>] [--json]
                                                run those checks; failures only; a GREEN line carries the tree hash
  risk [--base <ref>] [--json]                  the reviewer model for this diff, and whether tests are missing
  pick --issue <ID> --file <brief>              Jev routes the ticket to unit or unit-deep, and flags an open choice
  handback --file <message>                     check a unit's final message (exit 1 when invalid)
  handoff [--write [--transcript <p>] [--source <s>] | --stale]
                                                print the handoff note; refresh its auto block; or say why it is stale
  orient                                        where this task stands: branch, PR, units, last events
  papercut <gate|scope|protocol|repo|flake> "<what> -> <fix>" | --list | --mark
                                                log a learning; list the open ones; mark them consolidated
  unit-watch [--transcript <p>]                 the session's running units, their PRs, and what needs doing
  linear issue --team <key> --title <t> --description-file <f|-> [--project <name>] [--parent <ID>]
  linear update <ID> [--title <t>] [--description-file <f|->] [--status <s>] [--priority <0-4>]
                [--add-label <l>]... [--remove-label <l>]... [--link <url> --link-title <t>]
  linear comment <ID> --body-file <f|->         Linear writes through Moderator, judged by Jev
  hook <name>                                   a Claude Code hook (reads its JSON on stdin)`;

/**
 * @template {import('node:util').ParseArgsOptionsConfig} T
 * @param {string[]} args
 * @param {T} options
 */
const opts = (args, options) => parseArgs({ args, options, allowPositionals: true, strict: true });

/** @param {string} p */
const readText = (p) => fs.readFileSync(p === '-' ? 0 : p, 'utf8');

/** @type {Record<string, (args: string[]) => Promise<number | void>>} */
const commands = {
  async scope(args) {
    const { values } = opts(args, { base: { type: 'string' }, json: { type: 'boolean' } });
    const { computeScope, formatScope } = await import('../src/scope.js');
    const s = computeScope({ base: values.base });
    console.log(values.json ? JSON.stringify(s, null, 2) : formatScope(s));
  },

  async gate(args) {
    const { values } = opts(args, {
      base: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      plan: { type: 'boolean' },
      'if-changed': { type: 'boolean' },
      json: { type: 'boolean' },
    });
    if (values.plan) return commands.scope(values.base ? ['--base', values.base] : []);
    const { formatGate, runGate } = await import('../src/gate.js');
    const r = runGate({ base: values.base, only: values.only, skip: values.skip, ifChanged: values['if-changed'] });
    console.log(values.json ? JSON.stringify(r, null, 2) : formatGate(r));
    return r.ok ? 0 : 1;
  },

  async risk(args) {
    const { values } = opts(args, { base: { type: 'string' }, json: { type: 'boolean' } });
    const { computeRiskWithJev, formatRisk } = await import('../src/risk.js');
    const x = await computeRiskWithJev({ base: values.base });
    console.log(values.json ? JSON.stringify(x, null, 2) : formatRisk(x));
  },

  async pick(args) {
    const { values } = opts(args, { issue: { type: 'string' }, file: { type: 'string' }, json: { type: 'boolean' } });
    if (!values.file) throw new Error('pick needs --file <brief>');
    const { jev } = await import('../src/api.js');
    const r = await jev('pick', { issue: values.issue ?? '', brief: readText(values.file).slice(0, 12_000) });
    if (values.json) console.log(JSON.stringify(r));
    else if (!r) console.log('pick: unit (Jev did not answer: unit by default; brief unit-deep yourself if the ticket is architectural or touches auth, data or infra)');
    else console.log(`pick: ${r.unit} (complexity ${r.complexity}/3, risky ${r.risky}, ambiguous ${r.ambiguous})${r.ask ? ' -> ASK THE OWNER before briefing: the criteria leave a choice open' : ''}`);
  },

  async handback(args) {
    const { values } = opts(args, { file: { type: 'string' }, base: { type: 'string' } });
    const { checkHandback } = await import('../src/handback.js');
    const r = checkHandback(readText(values.file ?? '-'), { base: values.base });
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  },

  async handoff(args) {
    const { values } = opts(args, { write: { type: 'boolean' }, stale: { type: 'boolean' }, transcript: { type: 'string' }, source: { type: 'string' } });
    const { handoffPath, staleness, writeHandoff } = await import('../src/handoff.js');
    if (values.write) return void console.log(writeHandoff({ transcriptPath: values.transcript, source: values.source }));
    if (values.stale) {
      const why = staleness();
      console.log(why || 'current');
      return why ? 1 : 0;
    }
    console.log(fs.existsSync(handoffPath()) ? fs.readFileSync(handoffPath(), 'utf8') : '(no handoff note)');
  },

  async orient() {
    const { orient } = await import('../src/orient.js');
    console.log(orient());
  },

  async papercut(args) {
    const { values, positionals } = opts(args, { list: { type: 'boolean' }, mark: { type: 'boolean' } });
    const { add, CATEGORIES, mark, unconsolidated } = await import('../src/papercut.js');
    if (values.mark) return void console.log(`marked ${mark()} entries as consolidated`);
    if (values.list) {
      const entries = unconsolidated();
      if (!entries.length) console.log('no unconsolidated papercuts');
      for (const c of CATEGORIES) {
        const mine = entries.filter((l) => l.split('|')[2]?.trim() === c);
        if (mine.length) console.log(`${c} (${mine.length}):\n${mine.map((l) => `  ${l}`).join('\n')}`);
      }
      return;
    }
    const [category, ...rest] = positionals;
    if (!category || !rest.length) throw new Error(`usage: moderator papercut <${CATEGORIES.join('|')}> "<what> -> <fix>"`);
    console.log(add(category, rest.join(' ')));
  },

  async 'unit-watch'(args) {
    const { values } = opts(args, { transcript: { type: 'string' } });
    const { formatUnits, newestTranscript, watch } = await import('../src/units.js');
    const transcript = values.transcript || newestTranscript();
    console.log(transcript ? formatUnits(watch(transcript)) : 'unit-watch: no session transcript found');
  },

  async linear(args) {
    const [action, ...rest] = args;
    const { linear } = await import('../src/api.js');
    let r;
    if (action === 'issue') {
      const { values } = opts(rest, {
        team: { type: 'string' },
        title: { type: 'string' },
        'description-file': { type: 'string' },
        project: { type: 'string' },
        parent: { type: 'string' },
      });
      if (!values.team || !values.title || !values['description-file']) throw new Error('linear issue needs --team, --title and --description-file');
      r = await linear.createIssue({ team: values.team, title: values.title, description: readText(values['description-file']), project: values.project, parent: values.parent });
    } else if (action === 'update') {
      const { values, positionals } = opts(rest, {
        title: { type: 'string' },
        'description-file': { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'string' },
        'add-label': { type: 'string', multiple: true },
        'remove-label': { type: 'string', multiple: true },
        link: { type: 'string' },
        'link-title': { type: 'string' },
      });
      const [id] = positionals;
      if (!id) throw new Error('linear update needs the issue id');
      if (values.link && !values['link-title']) throw new Error('--link needs --link-title');
      if (values.priority !== undefined && !/^[0-4]$/.test(values.priority)) throw new Error('--priority is 0 (none) to 4 (low)');
      r = await linear.updateIssue(id, {
        title: values.title,
        description: values['description-file'] ? readText(values['description-file']) : undefined,
        status: values.status,
        priority: values.priority === undefined ? undefined : Number(values.priority),
        addLabels: values['add-label'],
        removeLabels: values['remove-label'],
        links: values.link ? [{ url: values.link, title: /** @type {string} */ (values['link-title']) }] : undefined,
      });
    } else if (action === 'comment') {
      const { values, positionals } = opts(rest, { 'body-file': { type: 'string' } });
      const [issue] = positionals;
      if (!issue || !values['body-file']) throw new Error('linear comment needs the issue id and --body-file');
      r = await linear.comment(issue, readText(values['body-file']));
    } else throw new Error('linear needs issue, update or comment');

    if (r.outcome === 'done') return void console.log(`done: ${r.id} ${r.url}`);
    const why = r.reason === 'jev_refused' ? 'Jev read it as not a product-level write' : 'Jev did not answer';
    console.log(
      `not written: ${why}. If it belongs on Linear as it is, write it with the Linear connector's own tool (save_issue or save_comment) and the same text; the owner approves or refuses it at that prompt. Otherwise leave it out of Linear.`,
    );
    return 3;
  },

  async hook(args) {
    const [name] = args;
    const hooks = ['session-start', 'stop', 'subagent-start', 'subagent-stop', 'pre-compact', 'guard', 'post-edit', 'post-artifact', 'context-watch'];
    if (!hooks.includes(name)) throw new Error(`hook needs one of ${hooks.join(', ')}`);
    let input = {};
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
      /* no input */
    }
    /** @type {any} */
    const i = input;
    // Claude may be working in a worktree, which is not the directory the hook was started in.
    if (i.cwd) {
      try {
        process.chdir(i.cwd);
      } catch {
        /* keep the current directory */
      }
    }
    /** @type {import('../src/hooks/io.js').HookResult | void} */
    let r;
    try {
      r = await (await import(`../src/hooks/${name}.js`)).default(i);
    } catch (e) {
      // A bug in a hook, or a broken config, never stops the session; the user is told, since the protocol is off.
      process.stderr.write(`moderator hook ${name} failed: ${e instanceof Error ? e.stack : e}\n`);
      process.stdout.write(JSON.stringify({ systemMessage: `moderator hook ${name} failed: ${e instanceof Error ? e.message : e}` }));
      return 0;
    }
    if (r?.json) process.stdout.write(JSON.stringify(r.json));
    if (r?.stderr) process.stderr.write(r.stderr);
    return r?.exit ?? 0;
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || !Object.hasOwn(commands, cmd)) {
  console.log(HELP);
  process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0;
} else {
  try {
    process.exitCode = (await commands[cmd](rest)) ?? 0;
  } catch (e) {
    console.error(`moderator ${cmd}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
