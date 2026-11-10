#!/usr/bin/env node
// Factory monitor: a live view of the software-factory workshop. It is read-only.
//
// It reads factory/, runs/, `git` (with optional locks off), `ps`, the Claude Code session
// transcripts of the headless `claude -p` stage runs and, optionally, `gh`.
// It never writes anything, so it cannot change what the workshop scripts or agents see.
//
// Usage:  node server.mjs [path-to-workshop-repo]
//         Default: the current directory if it is the workshop repo, otherwise ../woltora-factory
// Env:    PORT=4777  NO_GH=1 (skip GitHub)  TRANSCRIPTS_DIR=... (override)

import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const looksLikeWorkshop = (d) => existsSync(path.join(d, 'backlog')) || existsSync(path.join(d, 'factory'));
const REPO = path.resolve(
  process.argv[2] || process.env.FACTORY_REPO ||
  (looksLikeWorkshop(process.cwd()) ? process.cwd() : path.join(HERE, '..', 'woltora-factory')),
);
const PORT = Number(process.env.PORT || 4777);
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const TRANSCRIPTS = process.env.TRANSCRIPTS_DIR || path.join(CLAUDE_DIR, 'projects', REPO.replace(/[^a-zA-Z0-9]/g, '-'));
const USE_GH = !process.env.NO_GH;

// ---------- helpers ----------

function sh(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: REPO, timeout, maxBuffer: 16 * 1024 * 1024,
      // GIT_OPTIONAL_LOCKS=0: `git status` must never take index.lock while ship.sh/verify.sh run git.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    }, (err, stdout) => resolve({ ok: !err, out: stdout || '' }));
  });
}

async function readText(p, max = 64 * 1024) {
  try {
    const buf = await readFile(p);
    const s = buf.subarray(0, max).toString('utf8');
    return buf.length > max ? s + '\n…(truncated)' : s;
  } catch { return null; }
}

const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : s);
const rel = (p) => (typeof p === 'string' && p.startsWith(REPO + '/') ? p.slice(REPO.length + 1) : p);
const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
const normRun = (r) => String(r || '').replace(/^\.\//, '').replace(/^runs\//, '').replace(/\/+$/, '');

// ---------- factory/ ----------

async function readFactory() {
  const dir = path.join(REPO, 'factory');
  const files = {};
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name); } catch {}
  for (const n of names.sort()) {
    const p = path.join(dir, n);
    const st = await stat(p).catch(() => null);
    files[n] = { mtime: st?.mtimeMs ?? 0, content: await readText(p, 32 * 1024) };
  }
  return files;
}

function splitTools(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s || '') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Reads the per-stage tool allowlists from the `case` block in stage.sh.
function parseStageTools(src) {
  const out = {};
  for (const line of (src || '').split('\n')) {
    const m = line.match(/^\s*([^\s#()][^)]*)\)\s+tools="([^"]*)"(.*)$/);
    if (!m) continue;
    const deny = m[3].match(/deny="([^"]*)"/)?.[1] || '';
    const mcp = m[3].match(/mcp=([^\s;]+)/)?.[1] || '';
    for (const key of m[1].split('|').map((s) => s.trim())) out[key] = { tools: splitTools(m[2]), deny: splitTools(deny), mcp };
  }
  return out;
}

// ---------- runs/ ----------

async function readMdFiles(dir, prefix) {
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    const p = path.join(dir, n);
    const st = await stat(p).catch(() => null);
    out.push({ name: prefix + n, mtime: st?.mtimeMs ?? 0, content: await readText(p, 48 * 1024) });
  }
  return out;
}

async function readRuns() {
  const dir = path.join(REPO, 'runs');
  let ents = [];
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return { runs: [], loose: [] }; }
  const runs = [], loose = [];
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const st = await stat(p).catch(() => null);
      const files = [...await readMdFiles(p, ''), ...await readMdFiles(path.join(p, 'check'), 'check/')];
      const times = [st?.birthtimeMs || st?.ctimeMs || 0, ...files.map((f) => f.mtime)].filter(Boolean);
      runs.push({ name: e.name, created: Math.min(...times, Date.now()), updated: Math.max(0, ...files.map((f) => f.mtime)), files });
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const st = await stat(p).catch(() => null);
      loose.push({ name: e.name, mtime: st?.mtimeMs ?? 0, content: await readText(p, 16 * 1024) });
    }
  }
  runs.sort((a, b) => a.created - b.created);
  return { runs, loose };
}

async function readLog() {
  const s = (await readText(path.join(REPO, 'runs', 'log.jsonl'), 8 * 1024 * 1024)) || '';
  return s.split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return { _i: i, ...JSON.parse(l) }; } catch { return { _i: i, raw: l }; }
  });
}

// ---------- Claude transcripts of the headless stage runs ----------

const tcache = new Map(); // file name -> { key, skip?, data? }

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x.type === 'text' ? x.text : x.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function summarizeInput(name, inp = {}) {
  switch (name) {
    case 'Read': return { target: rel(inp.file_path) + (inp.offset ? `:${inp.offset}` : '') };
    case 'Grep': return { target: `/${inp.pattern}/` + (inp.path ? `  in ${rel(inp.path)}` : '') + (inp.glob ? `  ${inp.glob}` : '') };
    case 'Glob': return { target: inp.pattern + (inp.path ? `  in ${rel(inp.path)}` : '') };
    case 'Edit': return { target: rel(inp.file_path), old: clip(inp.old_string, 3000), new: clip(inp.new_string, 3000) };
    case 'MultiEdit': return { target: rel(inp.file_path), old: clip((inp.edits || []).map((e) => e.old_string).join('\n…\n'), 3000), new: clip((inp.edits || []).map((e) => e.new_string).join('\n…\n'), 3000) };
    case 'Write': return { target: rel(inp.file_path), new: clip(inp.content, 3000) };
    case 'Bash': return { target: clip(inp.command, 400), desc: inp.description };
    default: {
      const v = Object.values(inp).find((x) => typeof x === 'string');
      return { target: clip(rel(v) || '', 300) };
    }
  }
}

async function headOf(p, n) {
  const fh = await open(p, 'r');
  try { const buf = Buffer.alloc(n); const { bytesRead } = await fh.read(buf, 0, n, 0); return buf.subarray(0, bytesRead).toString('utf8'); }
  finally { await fh.close(); }
}

async function parseTranscript(p) {
  // Only headless runs (entrypoint sdk-cli) count. Interactive sessions like this one are skipped for good.
  const head = await headOf(p, 128 * 1024);
  const eps = new Set([...head.matchAll(/"entrypoint":"([^"]+)"/g)].map((m) => m[1]));
  if (!eps.size) return { pending: true };
  if ([...eps].some((e) => e !== 'sdk-cli')) return { skip: true };

  const text = await readFile(p, 'utf8');
  let prompt = null, start = null, end = null, final = '', model = null, cost = null, budget = null, sessionId = null;
  const events = [], byId = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.includes('USD budget:')) {
      const m = line.match(/USD budget: \$([\d.]+)\/\$([\d.]+)/);
      if (m) budget = { used: +m[1], cap: +m[2] };
    }
    let d; try { d = JSON.parse(line); } catch { continue; }
    sessionId ||= d.sessionId;
    const ts = d.timestamp ? Date.parse(d.timestamp) : null;
    if (ts) end = Math.max(end || 0, ts);
    if (d.type === 'user' && d.message) {
      const c = d.message.content;
      if (prompt === null && typeof c === 'string') { prompt = c; start = ts; continue; }
      if (Array.isArray(c)) for (const b of c) {
        if (b.type !== 'tool_result') continue;
        const ev = byId.get(b.tool_use_id);
        if (ev) { ev.error = !!b.is_error; ev.out = clip(resultText(b.content), 2500); ev.done = ts; }
      }
    } else if (d.type === 'assistant' && d.message) {
      model = d.message.model || model;
      for (const b of d.message.content || []) {
        if (b.type === 'tool_use') {
          const ev = { t: ts, kind: 'tool', name: b.name, ...summarizeInput(b.name, b.input) };
          events.push(ev); byId.set(b.id, ev);
        } else if (b.type === 'text' && b.text?.trim()) {
          events.push({ t: ts, kind: 'text', text: clip(b.text, 6000) }); final = b.text;
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          events.push({ t: ts, kind: 'thinking', text: clip(b.thinking, 3000) });
        }
      }
    } else if (d.type === 'cost-state') {
      cost = { usd: d.totalCostUSD, ms: d.totalDuration, added: d.totalLinesAdded, removed: d.totalLinesRemoved };
    }
  }
  if (prompt === null) return { pending: true };
  // stage.sh puts `<input>` on a line of its own; prompts may also mention <input> inline.
  if (!/^<input>$/m.test(prompt)) return { skip: true }; // not a stage.sh prompt
  const promptHead = prompt.split(/^<input>$/m)[0].split(/\n# Felles kontekst/)[0].trim();
  return {
    data: {
      id: sessionId || path.basename(p, '.jsonl'), start, end, model, cost, budget,
      promptFirst: firstLine(promptHead), promptHead: clip(promptHead, 4000),
      stageWord: prompt.match(/Du er ([\p{L}\d-]+?)-steget/u)?.[1] || null,
      final: clip(final, 48 * 1024), events,
      tools: events.filter((e) => e.kind === 'tool').length,
      errors: events.filter((e) => e.kind === 'tool' && e.error).length,
    },
  };
}

async function readTranscripts() {
  let names = [];
  try { names = (await readdir(TRANSCRIPTS)).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const cached = tcache.get(n);
    if (cached?.skip) continue;
    const p = path.join(TRANSCRIPTS, n);
    const st = await stat(p).catch(() => null);
    if (!st) continue;
    const key = `${st.size}:${st.mtimeMs}`;
    let c = cached;
    if (!c || c.key !== key) {
      let r;
      try { r = await parseTranscript(p); } catch { r = { pending: true }; }
      if (r.pending) continue;
      c = { key, ...r };
      tcache.set(n, c);
    }
    if (c.data) out.push(c.data);
  }
  return out.sort((a, b) => (a.start || 0) - (b.start || 0));
}

// ---------- processes: which factory scripts are running right now ----------

const startSeen = new Map(); // `${pid}|${cmd}` -> first-seen start ms (keeps start stable between polls)
const cwdCache = new Map();

function parseEtime(s) {
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
}

async function cwdOf(pid) {
  if (cwdCache.has(pid)) return cwdCache.get(pid);
  let cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null); // Linux
  if (!cwd) { // macOS
    const r = await sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 3000);
    cwd = r.out.split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
  }
  cwdCache.set(pid, cwd);
  return cwd;
}

function parseClaudeCmd(cmd) {
  const grab = (flag) => cmd.match(new RegExp(`--${flag}\\s+(.+?)(?=\\s--[a-z]|$)`))?.[1];
  return { tools: splitTools(grab('allowedTools')), deny: splitTools(grab('disallowedTools')), budget: grab('max-budget-usd'), mcp: grab('mcp-config') };
}

async function readProcs() {
  const r = await sh('ps', ['-A', '-ww', '-o', 'pid=,ppid=,etime=,args='], 5000); // same flags on macOS and Linux
  if (!r.ok) return [];
  const rows = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], etime: parseEtime(m[3]), cmd: m[4] });
  }
  const byPid = new Map(rows.map((x) => [x.pid, x]));
  const kids = new Map();
  for (const x of rows) { if (!kids.has(x.ppid)) kids.set(x.ppid, []); kids.get(x.ppid).push(x); }
  const now = Date.now();
  const startOf = (x) => {
    const k = `${x.pid}|${x.cmd}`;
    if (!startSeen.has(k)) startSeen.set(k, Math.round((now - x.etime * 1000) / 1000) * 1000);
    return startSeen.get(k);
  };

  const re = /^(?:\S*\/)?(?:bash|sh|zsh|dash)\s+(?:-\S+\s+)*(\S*factory\/([\w.-]+)\.sh)(?:\s+(.*))?$/;
  const scripts = new Map();
  for (const x of rows) {
    const m = x.cmd.match(re);
    if (!m) continue;
    const parent = byPid.get(x.ppid);
    if (parent && parent.cmd === x.cmd) continue; // $( ) subshell of the same script
    const scriptPath = m[1];
    const full = path.isAbsolute(scriptPath) ? scriptPath : path.join((await cwdOf(x.pid)) || '/nonexistent', scriptPath);
    if (!full.startsWith(REPO + '/')) continue;
    scripts.set(x.pid, { pid: x.pid, ppid: x.ppid, script: `${m[2]}.sh`, args: (m[3] || '').trim().split(/\s+/).filter(Boolean), start: startOf(x) });
  }
  for (const pid of [...cwdCache.keys()]) if (!byPid.has(pid)) cwdCache.delete(pid);
  if (startSeen.size > 5000) startSeen.clear();

  const noise = /^(?:\S*\/)?(cat|grep|sed|tee|date|head|tail|tr|cut|awk|perl|basename|dirname|rg|ps|lsof)\b/;
  const out = [];
  for (const s of scripts.values()) {
    // nearest ancestor that is also a factory script (e.g. run.sh -> stage.sh)
    let p = byPid.get(s.ppid), parent = null, guard = 0;
    while (p && guard++ < 50) { if (scripts.has(p.pid)) { parent = p.pid; break; } p = byPid.get(p.ppid); }
    // descendants that are not factory scripts themselves: claude -p, npm test, gh, vite preview, sleep …
    const children = [], claude = [];
    const walk = (pid, depth) => {
      for (const c of kids.get(pid) || []) {
        if (scripts.has(c.pid)) continue;
        const own = byPid.get(c.ppid);
        const dup = own && own.cmd === c.cmd;
        if (!dup && !noise.test(c.cmd)) {
          // `claude -p …`, or `node …/claude-code/cli.js -p …` on npm installs
          const isClaude = /claude/.test(c.cmd.split(/\s+-/)[0]) && /\s-p(\s|$)/.test(c.cmd);
          if (isClaude) claude.push({ pid: c.pid, start: startOf(c), ...parseClaudeCmd(c.cmd) });
          else if (children.length < 12) children.push({ pid: c.pid, depth, start: startOf(c), cmd: clip(c.cmd, 240) });
        }
        if (depth < 8) walk(c.pid, depth + 1);
      }
    };
    walk(s.pid, 0);
    out.push({ ...s, parent, children, claude });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------- git (read-only, no locks) ----------

let gitCache = { at: 0, data: null };
async function readGit() {
  if (Date.now() - gitCache.at < 2500 && gitCache.data) return gitCache.data;
  const [st, log, diff, stash, branches] = await Promise.all([
    sh('git', ['status', '--porcelain=v1', '-b', '--untracked-files=all']),
    sh('git', ['log', '--format=%h%x09%ct%x09%s', '-12']),
    sh('git', ['diff', '--no-color', '--', 'src']),
    sh('git', ['stash', 'list']),
    sh('git', ['branch', '--list', 'factory/*', '--format=%(refname:short)']),
  ]);
  const lines = st.out.split('\n').filter(Boolean);
  const data = {
    ok: st.ok,
    branch: (lines[0] || '').replace(/^## /, ''),
    changes: lines.slice(1).map((l) => ({ code: l.slice(0, 2), file: l.slice(3) })),
    commits: log.out.split('\n').filter(Boolean).map((l) => { const [h, t, ...s] = l.split('\t'); return { hash: h, time: +t * 1000, subject: s.join('\t') }; }),
    diff: clip(diff.out, 60 * 1024),
    stashes: stash.out.split('\n').filter(Boolean),
    branches: branches.out.split('\n').filter(Boolean),
  };
  gitCache = { at: Date.now(), data };
  return data;
}

// ---------- GitHub (read-only, cached, never blocks a poll) ----------

let ghState = { at: 0, data: { loading: true }, busy: false };
function readGitHub() {
  if (!USE_GH) return { disabled: true };
  if (!ghState.busy && Date.now() - ghState.at > 30000) {
    ghState.busy = true;
    (async () => {
      const j = (r) => { try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; } };
      const [issues, prs, runs] = await Promise.all([
        sh('gh', ['issue', 'list', '--state', 'all', '--limit', '25', '--json', 'number,title,state,labels,updatedAt,url'], 20000),
        sh('gh', ['pr', 'list', '--state', 'all', '--limit', '15', '--json', 'number,title,state,headRefName,url,updatedAt'], 20000),
        sh('gh', ['run', 'list', '--limit', '10', '--json', 'databaseId,displayTitle,status,conclusion,headBranch,event,createdAt,url,workflowName'], 20000),
      ]);
      const data = { issues: j(issues), prs: j(prs), runs: j(runs) };
      data.error = !data.issues && !data.prs && !data.runs;
      ghState = { at: Date.now(), data: { ...data, fetchedAt: Date.now() }, busy: false };
    })().catch(() => { ghState = { at: Date.now(), data: { error: true }, busy: false }; });
  }
  return ghState.data;
}

// ---------- snapshot ----------

async function snapshot() {
  const [factory, { runs, loose }, log, sessions, procs, git] = await Promise.all([
    readFactory(), readRuns(), readLog(), readTranscripts(), readProcs(), readGit(),
  ]);

  // Which prompt file does each session come from? (first line of factory/<stage>.md)
  const promptFirst = {};
  for (const [n, f] of Object.entries(factory)) if (/^\d+-[\w-]+\.md$/.test(n)) promptFirst[firstLine(f.content).trim()] = n.replace(/\.md$/, '');

  // Which run file did each session write? stage.sh writes exactly the final answer to <run>/<stage>.md.
  const byOutput = new Map();
  for (const r of runs) for (const f of r.files) {
    const k = (f.content || '').trim();
    if (k) byOutput.set(k, { run: r.name, file: f.name });
  }

  const summaries = sessions.map((s) => {
    const m = byOutput.get((s.final || '').trim());
    return {
      id: s.id, start: s.start, end: s.end, model: s.model, cost: s.cost, budget: s.budget,
      stage: promptFirst[s.promptFirst.trim()] || (m ? m.file.replace(/^check\//, '').replace(/\.md$/, '') : null),
      stageWord: s.stageWord, tools: s.tools, errors: s.errors,
      run: m?.run || null, file: m?.file || null, live: false,
      finalFirst: firstLine(s.final),
    };
  });

  // Attach running stage.sh processes to their (still growing) transcript.
  const active = procs.map((p) => ({ ...p }));
  for (const p of active) {
    if (p.script !== 'stage.sh') continue;
    const [stage, run] = p.args;
    const want = firstLine(factory[`${stage}.md`]?.content).trim();
    const cand = summaries.filter((s) => !s.live && (s.start || 0) >= p.start - 5000 && (!want || s.stage === stage));
    const s = cand[0];
    if (s) { s.live = true; s.run = normRun(run); s.stage = stage; p.session = s.id; }
  }

  const live = summaries.filter((s) => s.live).at(-1);
  const focusId = live?.id || summaries.at(-1)?.id || null;
  const focus = sessions.find((s) => s.id === focusId);

  return {
    repo: REPO, transcripts: TRANSCRIPTS, now: Date.now(),
    factory, stageTools: parseStageTools(factory['stage.sh']?.content),
    runs, loose, log, sessions: summaries, active, git, gh: readGitHub(),
    focus: focus ? { ...summaries.find((s) => s.id === focusId), events: focus.events.slice(-250), promptHead: focus.promptHead } : null,
  };
}

// ---------- http ----------

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to localhost (blocks DNS-rebinding from other sites).
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
  const url = new URL(req.url, 'http://localhost');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); };
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(200, 'text/html; charset=utf-8', await readFile(path.join(HERE, 'index.html')));
    }
    if (url.pathname === '/api/state') return send(200, 'application/json', JSON.stringify(await snapshot()));
    if (url.pathname === '/api/session') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-f-]{36}$/.test(id)) return send(400, 'application/json', '{"error":"bad id"}');
      await readTranscripts();
      const s = [...tcache.values()].find((c) => c.data?.id === id)?.data;
      return s ? send(200, 'application/json', JSON.stringify(s)) : send(404, 'application/json', '{"error":"not found"}');
    }
    send(404, 'text/plain', 'not found');
  } catch (e) {
    send(500, 'application/json', JSON.stringify({ error: String(e?.message || e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Factory monitor  →  http://localhost:${PORT}`);
  console.log(`  repo:         ${REPO}`);
  console.log(`  transcripts:  ${TRANSCRIPTS}`);
  console.log('  read-only: nothing is written to the repo.');
  if (!looksLikeWorkshop(REPO)) console.log(`\n  ⚠ ${REPO} has no backlog/ or factory/ yet. Pass the workshop repo path: node server.mjs <path>`);
});
