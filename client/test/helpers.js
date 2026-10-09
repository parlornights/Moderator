// Test helpers: a throwaway repository on a branch, the CLI and hooks run as Claude Code runs them, and a fake
// Moderator service.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// Git as a fresh machine has it, whatever this one's global config says; the hooks commit, so they need an identity.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
});

export const BIN = fileURLToPath(new URL('../bin/moderator.js', import.meta.url));

export const CONFIG = {
  issuePattern: '\\b(?:CD|PAR)-\\d+\\b',
  ignore: ['**/*.md', '.work/**'],
  global: ['package.json'],
  lintExtensions: ['.js'],
  checks: {},
};

/** The test's environment without the session's proxy settings, so a child reaches a local fake service. */
export function env(/** @type {Record<string, string>} */ extra = {}) {
  const { NODE_USE_ENV_PROXY: _a, HTTPS_PROXY: _b, HTTP_PROXY: _c, https_proxy: _d, http_proxy: _e, ...rest } = process.env;
  return { ...rest, NODE_NO_WARNINGS: '1', MODERATOR_API_KEY: 'test-key', ...extra };
}

/**
 * A git repository on `branch` with moderator.config.json and `files` committed; removed after the test file.
 * @param {{ branch?: string, config?: Record<string, unknown> | null, files?: Record<string, string>, remote?: boolean }} [opts]
 */
export function repo({ branch = 'cd-1-x', config = CONFIG, files = {}, remote = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-test-')));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const put = (/** @type {string} */ rel, /** @type {string} */ text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  git('init', '-q', '-b', branch);
  if (config) put('moderator.config.json', JSON.stringify(config, null, 2));
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  git('add', '-A');
  git('commit', '-qm', 'init', '--allow-empty');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  let bare = null;
  if (remote) {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-remote-'));
    after(() => fs.rmSync(/** @type {string} */ (bare), { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    git('remote', 'add', 'origin', bare);
    git('push', '-q', '-u', 'origin', branch);
  }
  // Outside the repository, as a session's transcript is.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moderator-scratch-')));
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const remoteHead = () => (bare ? execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: bare, encoding: 'utf8' }).trim() : null);
  return { dir, scratch, git, put, read, remoteHead };
}

/**
 * Run the CLI.
 * @param {string[]} args
 * @param {{ cwd: string, input?: string, env?: Record<string, string> }} opts
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
export function cli(args, { cwd, input = '', env: extra = {} }) {
  // Async, so a fake service in this process can answer while the child waits on it.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: env(extra) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * Run one hook the way Claude Code does: its JSON on stdin, the session's directory in `cwd`.
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @param {{ cwd: string, env?: Record<string, string>, args?: string[] }} opts
 */
export async function hook(name, input, { cwd, env: extra, args = [] }) {
  const r = await cli(['hook', name, ...args], { cwd, input: JSON.stringify({ cwd, ...input }), env: extra });
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

/**
 * A fake Moderator service. `answer(route, body)` returns the JSON reply, sent with `status`; every call is kept in
 * `calls`.
 * @param {(route: string, body: any) => unknown} answer
 * @param {{ status?: number }} [opts]
 */
export async function fakeModerator(answer, { status = 200 } = {}) {
  /** @type {{ route: string, body: any, auth: string | undefined }[]} */
  const calls = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (d) => (text += d));
    req.on('end', () => {
      const body = text ? JSON.parse(text) : undefined;
      const route = `${req.method} ${req.url}`;
      calls.push({ route, body, auth: req.headers.authorization });
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(answer(route, body)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  after(() => server.close());
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, calls };
}

/**
 * A session transcript of JSONL records; returns its path.
 * @param {string} dir
 * @param {unknown[]} records
 */
export function transcript(dir, records) {
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return p;
}

/**
 * A main-session tool call record.
 * @param {string} name
 * @param {unknown} input
 */
export const toolUse = (name, input) => ({ message: { content: [{ type: 'tool_use', name, input }] } });

/**
 * The transcript records of spawning a unit: the Agent call and its result naming the agent id.
 * @param {string} toolId
 * @param {string} agentId
 * @param {string} [type]
 */
export const spawnUnit = (toolId, agentId, type = 'unit') => [
  { timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: toolId, name: 'Agent', input: { subagent_type: type, description: `job ${agentId}` } }] } },
  { timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text: `Async agent launched.\nagentId: ${agentId} (internal ID)` }] }] } },
];
