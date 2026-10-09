// What a Claude Code session transcript (JSONL) says about the main session: its tool calls, how full its context
// is, and its last turns. A unit's records (isSidechain) are never the session's.

import fs from 'node:fs';

/**
 * The main session's tool calls, oldest first; null when the transcript cannot be read.
 * @param {string} transcriptPath
 * @returns {{ name: string, input: any }[] | null}
 */
export function toolUses(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const calls = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    const rec = parse(line);
    const content = rec?.isSidechain ? null : rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) if (c?.type === 'tool_use') calls.push({ name: String(c.name || ''), input: c.input || {} });
  }
  return calls;
}

/**
 * Tokens the main session last sent as context (input + cache read + cache creation of its latest usage). Reads
 * only the file's tail, widening it until a usage turns up. Null when unknown.
 * @param {string} transcriptPath
 */
export function contextTokens(transcriptPath) {
  for (const tail of [64 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
    const found = lastUsage(transcriptPath, tail);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * @param {string} transcriptPath
 * @param {number} tailBytes
 * @returns {number | null | undefined} undefined: none in this tail; null: unreadable, or none in the whole file
 */
function lastUsage(transcriptPath, tailBytes) {
  let text;
  let whole;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    whole = len === size;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    const rec = parse(lines[i]);
    const u = rec?.isSidechain ? null : rec?.message?.usage;
    if (!u || typeof u.input_tokens !== 'number') continue;
    return u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return whole ? null : undefined;
}

/**
 * User entries that the harness wrote, not the owner: hook feedback, background notices and the compaction summary. An
 * interrupt stays: it says the owner stopped something.
 */
const NOT_OWNER = /^(?:Stop hook feedback:|<task-notification>|This session is being continued from a previous conversation)/;

/**
 * The last n owner and assistant turns: their text in full, without tool calls, tool output, system reminders, HTML
 * comments, or the user entries the harness wrote (NOT_OWNER).
 * @param {string} transcriptPath
 * @param {number} [n]
 * @returns {{ role: 'U' | 'A', text: string }[]}
 */
export function turns(transcriptPath, n = 25) {
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  /** @type {{ role: 'U' | 'A', text: string }[]} */
  const out = [];
  for (const line of lines) {
    const rec = parse(line);
    if (!rec || !['user', 'assistant'].includes(rec.type) || !rec.message || rec.isSidechain) continue;
    const content = typeof rec.message.content === 'string' ? [{ type: 'text', text: rec.message.content }] : rec.message.content || [];
    const text = content
      .filter((/** @type {any} */ c) => c.type === 'text' && c.text)
      .map((/** @type {any} */ c) => c.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim())
      .filter(Boolean)
      .join('\n');
    if (text && !(rec.type === 'user' && NOT_OWNER.test(text))) out.push({ role: rec.type === 'user' ? 'U' : 'A', text });
  }
  return out.slice(-n);
}

/** @param {string} line */
function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
