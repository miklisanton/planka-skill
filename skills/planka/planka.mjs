#!/usr/bin/env node
// Read-only Planka v1 client. Board/card endpoints only answer over the Sails
// socket (plain HTTP returns 400), and the socket handshake requires an Origin header.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const CONFIG_DIR = join(homedir(), '.config', 'planka');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const config = loadConfig();
const normalizeUrl = (u) => (/^https?:\/\//.test(u) ? u : `http://${u}`).replace(/\/+$/, '');
let BASE = process.env.PLANKA_URL ? normalizeUrl(process.env.PLANKA_URL) : config.url;

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function die(msg) {
  console.error(`planka: ${msg}`);
  process.exit(1);
}

if (typeof WebSocket === 'undefined' || !Map.groupBy) die(`Node 22+ required (running ${process.version})`);

const LOGIN_HINT = `not logged in. Run \`node ${import.meta.filename} login\` in the background: it opens a login form in the browser and waits up to 5 minutes.`;

function readToken() {
  if (process.env.PLANKA_TOKEN) return BASE ? process.env.PLANKA_TOKEN.trim() : die('PLANKA_TOKEN needs PLANKA_URL');
  return BASE && config.token;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function askHidden(question) {
  process.stderr.write(question);
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let input = '';
  return new Promise((resolve) => {
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(input);
        }
        input = ch === '\u007f' ? input.slice(0, -1) : input + ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Planka v1 tokens carry the bare user id as the JWT payload.
function userIdFromToken(token) {
  const part = token.split('.')[1];
  // Keep it a string: ids are 19-digit snowflakes that lose precision as numbers.
  return Buffer.from(part, 'base64url').toString().replace(/"/g, '');
}

class Socket {
  constructor(token) {
    this.token = token;
    this.seq = 0;
    this.pending = new Map();
  }

  open() {
    const url = `${BASE.replace(/^http/, 'ws')}/socket.io/?__sails_io_sdk_version=1.2.1&__sails_io_sdk_platform=node&__sails_io_sdk_language=javascript&EIO=3&transport=websocket`;
    this.ws = new WebSocket(url, { headers: { Origin: BASE } });
    return new Promise((resolve, reject) => {
      this.ws.onerror = () => reject(new Error(`socket connection to ${BASE} failed`));
      this.ws.onclose = () => {
        for (const { reject: r } of this.pending.values()) r(new Error('socket closed'));
      };
      this.ws.onmessage = ({ data }) => {
        const frame = String(data);
        if (frame.startsWith('40')) resolve();
        else if (frame.startsWith('43')) {
          const [, id, body] = frame.match(/^43(\d+)(.*)$/s);
          const waiter = this.pending.get(Number(id));
          this.pending.delete(Number(id));
          waiter?.resolve(JSON.parse(body)[0]);
        }
      };
    });
  }

  async get(path) {
    const id = this.seq++;
    const res = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(`42${id}${JSON.stringify(['get', {
        method: 'get',
        url: `/api${path}`,
        headers: { Authorization: `Bearer ${this.token}` },
        data: {},
      }])}`);
    });
    if (res.statusCode === 401) die('token rejected (401). Run login again.');
    if (res.statusCode !== 200) die(`GET ${path} -> ${res.statusCode} ${JSON.stringify(res.body).slice(0, 200)}`);
    return res.body;
  }

  close() {
    this.ws.close();
  }

  // Board and card responses omit users; project listing carries all of them.
  async userNames() {
    const { included } = await this.get('/projects');
    return new Map(included.users.map((u) => [u.id, u.name]));
  }
}

// Accepts a raw id or any Planka URL ending in /boards/<id> or /cards/<id>.
function idArg(arg, kind) {
  if (!arg) die(`missing ${kind} id`);
  const m = arg.match(new RegExp(`/${kind}s/(\\d+)`));
  if (m) return m[1];
  if (/^\d+$/.test(arg)) return arg;
  die(`not a ${kind} id or URL: ${arg}`);
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) flags._.push(a);
    else if (['--json', '--mine', '--all'].includes(a)) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return flags;
}

const byId = (items = []) => new Map(items.map((x) => [x.id, x]));
const date = (s) => (s ? s.slice(0, 10) : '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const cardUrl = (id) => `${BASE}/cards/${id}`;

// Returns null on bad credentials; throws on anything else (unreachable host, not Planka).
async function requestToken(url, email, password) {
  let res;
  try {
    res = await fetch(`${url}/api/access-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername: email, password }),
    });
  } catch (e) {
    throw new Error(`cannot reach ${url} (${e.cause?.code ?? e.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.item) return body.item;
  if (res.status === 401) return null;
  throw new Error(`${url} answered ${res.status}. Is it a Planka v1 server?`);
}

async function saveLogin(url, token) {
  BASE = url;
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ url, token }, null, 2)}\n`, { mode: 0o600 });
  const sock = new Socket(token);
  await sock.open();
  const me = (await sock.get('/users/me')).item;
  sock.close();
  console.error(`Logged in as ${me.name} (${me.email}). Saved to ${CONFIG_FILE}`);
  return me;
}

async function loginFromEnv(email) {
  if (!BASE) die('PLANKA_URL is required with PLANKA_PASSWORD');
  const token = await requestToken(BASE, email, process.env.PLANKA_PASSWORD).catch((e) => die(e.message));
  if (!token) die('invalid email or password');
  await saveLogin(BASE, token);
  return token;
}

async function loginInTerminal(emailArg) {
  const url = BASE ?? normalizeUrl(await ask('Planka URL (e.g. planka.example.com): '));
  console.error(`Logging in to ${url}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const email = emailArg || (await ask('Email or username: '));
    const token = await requestToken(url, email, await askHidden('Password: ')).catch((e) => die(e.message));
    if (token) {
      await saveLogin(url, token);
      return token;
    }
    console.error('Invalid email or password, try again.');
  }
  die('invalid email or password');
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage({ url = '', email = '', error = '', done = '' }) {
  const body = done
    ? `<h1>Planka</h1><p class="ok">${escapeHtml(done)}</p><p>You can close this tab.</p>`
    : `<h1>Planka login</h1>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post">
<label>Planka URL<input name="url" value="${escapeHtml(url)}" placeholder="planka.example.com" required></label>
<label>Email or username<input name="email" value="${escapeHtml(email)}" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button>Log in</button>
</form>
<p class="note">Credentials go straight to your Planka server. Only the token is saved, to ${escapeHtml(CONFIG_FILE)}.</p>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Planka login</title>
<style>
body{font:15px system-ui,sans-serif;max-width:380px;margin:12vh auto;padding:0 16px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}input{background:#161b22;color:inherit;border-color:#30363d}}
h1{font-size:20px}label{display:block;margin:12px 0}input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:8px;font:inherit;border:1px solid #d0d7de;border-radius:6px}
button{margin-top:8px;padding:8px 16px;font:inherit;border:0;border-radius:6px;background:#0969da;color:#fff;cursor:pointer}
.err{color:#cf222e}.ok{color:#1a7f37}.note{font-size:13px;opacity:.7}
</style>${body}`;
}

function openBrowser(url) {
  const [cmd, args] = { darwin: ['open', [url]], win32: ['cmd', ['/c', 'start', '', url]] }[process.platform] ?? ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// For agents without a TTY: a one-shot local form, guarded by a random key in its URL.
function loginInBrowser() {
  const key = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const send = (status, page) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
      if (reqUrl.searchParams.get('k') !== key) return send(403, 'Forbidden');
      if (req.method !== 'POST') return send(200, loginPage({ url: BASE ?? '' }));

      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const url = normalizeUrl(form.get('url').trim());
      const email = form.get('email').trim();
      try {
        const token = await requestToken(url, email, form.get('password'));
        if (!token) return send(200, loginPage({ url, email, error: 'Invalid email or password.' }));
        const me = await saveLogin(url, token);
        res.on('finish', () => {
          server.close();
          server.closeAllConnections();
          resolve(token);
        });
        send(200, loginPage({ done: `Logged in as ${me.name}.` }));
      } catch (e) {
        send(200, loginPage({ url, email, error: e.message }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?k=${key}`;
      console.log(`Open this page to log in to Planka (waiting 5 minutes):\n${url}`);
      openBrowser(url);
    });
    setTimeout(() => die('login timed out after 5 minutes'), 5 * 60_000).unref();
  });
}

function login(email = process.env.PLANKA_EMAIL) {
  if (process.env.PLANKA_PASSWORD) return loginFromEnv(email);
  return process.stdin.isTTY ? loginInTerminal(email) : loginInBrowser();
}

async function ensureToken() {
  const token = readToken();
  if (token) return token;
  if (!process.stdin.isTTY) die(LOGIN_HINT);
  console.error('No Planka token found.');
  return loginInTerminal();
}

async function projects(sock, flags) {
  const { items, included } = await sock.get('/projects');
  if (flags.json) return console.log(JSON.stringify({ items, included }, null, 2));
  for (const p of items) {
    console.log(`${p.name}  (project ${p.id})`);
    for (const b of included.boards.filter((b) => b.projectId === p.id)) {
      console.log(`  board ${b.id}  ${b.name}`);
    }
  }
}

function boardView(body, users, flags, me) {
  const inc = body.included;
  const labels = byId(inc.labels);
  const cardLabels = Map.groupBy(inc.cardLabels, (x) => x.cardId);
  const members = Map.groupBy(inc.cardMemberships, (x) => x.cardId);
  const tasks = Map.groupBy(inc.tasks, (x) => x.cardId);

  const cards = inc.cards.map((c) => {
    const t = tasks.get(c.id) || [];
    return {
      id: c.id,
      name: c.name,
      listId: c.listId,
      position: c.position,
      dueDate: c.dueDate,
      labels: (cardLabels.get(c.id) || []).map((x) => labels.get(x.labelId)?.name).filter(Boolean),
      memberIds: (members.get(c.id) || []).map((x) => x.userId),
      members: (members.get(c.id) || []).map((x) => users.get(x.userId) ?? x.userId),
      tasks: { done: t.filter((x) => x.isCompleted).length, total: t.length },
      updatedAt: c.updatedAt || c.createdAt,
    };
  });

  const q = flags.search?.toLowerCase();
  const keep = (c) =>
    (!flags.mine || c.memberIds.includes(me)) &&
    (!flags.label || c.labels.some((l) => l.toLowerCase() === flags.label.toLowerCase())) &&
    (!q || c.name.toLowerCase().includes(q));

  const lists = [...inc.lists]
    .sort((a, b) => a.position - b.position)
    .filter((l) => !flags.list || l.name.toLowerCase() === flags.list.toLowerCase())
    .map((l) => ({
      id: l.id,
      name: l.name,
      cards: cards.filter((c) => c.listId === l.id && keep(c)).sort((a, b) => a.position - b.position),
    }));
  if (flags.list && lists.length === 0) {
    die(`no list "${flags.list}". Lists: ${inc.lists.map((l) => l.name).join(', ')}`);
  }
  return { board: { id: body.item.id, name: body.item.name }, lists };
}

async function board(sock, flags, me) {
  const id = idArg(flags._[1], 'board');
  const view = boardView(await sock.get(`/boards/${id}`), await sock.userNames(), flags, me);
  if (flags.json) return console.log(JSON.stringify(view, null, 2));
  console.log(`# ${view.board.name} (board ${view.board.id})`);
  for (const l of view.lists) {
    if (!l.cards.length && (flags.mine || flags.label || flags.search)) continue;
    console.log(`\n## ${l.name} (${l.cards.length})`);
    for (const c of l.cards) {
      const meta = [
        c.labels.length && `[${c.labels.join(', ')}]`,
        c.members.length && `@${c.members.join(', @')}`,
        c.tasks.total && `tasks ${c.tasks.done}/${c.tasks.total}`,
        c.dueDate && `due ${date(c.dueDate)}`,
      ].filter(Boolean).join('  ');
      console.log(`- ${c.id}  ${c.name}${meta ? `  ${meta}` : ''}`);
    }
  }
}

async function allActions(sock, cardId) {
  const all = [];
  for (let before = ''; ; ) {
    const { items } = await sock.get(`/cards/${cardId}/actions${before && `?beforeId=${before}`}`);
    all.push(...items);
    if (!items.length || items.at(-1).id === before) return all;
    before = items.at(-1).id;
  }
}

async function card(sock, flags) {
  const id = idArg(flags._[1], 'card');
  const c = (await sock.get(`/cards/${id}`)).item;
  const [boardRes, actions, users] = await Promise.all([
    sock.get(`/boards/${c.boardId}`),
    allActions(sock, id),
    sock.userNames(),
  ]);
  const binc = boardRes.included;
  const labels = byId(binc.labels);
  const userName = (uid) => users.get(uid) ?? uid;

  const view = {
    id: c.id,
    url: cardUrl(c.id),
    name: c.name,
    board: boardRes.item.name,
    list: binc.lists.find((l) => l.id === c.listId)?.name,
    dueDate: c.dueDate,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    labels: binc.cardLabels.filter((x) => x.cardId === id).map((x) => labels.get(x.labelId)?.name),
    members: binc.cardMemberships.filter((x) => x.cardId === id).map((x) => userName(x.userId)),
    description: c.description || '',
    tasks: binc.tasks
      .filter((t) => t.cardId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => ({ name: t.name, done: t.isCompleted })),
    attachments: binc.attachments.filter((a) => a.cardId === id).map((a) => ({ name: a.name, url: a.url })),
    comments: actions
      .filter((a) => a.type === 'commentCard')
      .map((a) => ({ author: userName(a.userId), at: a.createdAt, text: a.data.text }))
      .reverse(),
  };
  if (flags.json) return console.log(JSON.stringify(view, null, 2));

  console.log(`# ${view.name}`);
  console.log(`${view.url}\nboard: ${view.board}  list: ${view.list}`);
  if (view.labels.length) console.log(`labels: ${view.labels.join(', ')}`);
  if (view.members.length) console.log(`members: ${view.members.join(', ')}`);
  if (view.dueDate) console.log(`due: ${date(view.dueDate)}`);
  console.log(`created: ${date(view.createdAt)}  updated: ${date(view.updatedAt)}`);
  if (view.description) console.log(`\n## Description\n${view.description}`);
  if (view.tasks.length) {
    console.log(`\n## Tasks`);
    for (const t of view.tasks) console.log(`- [${t.done ? 'x' : ' '}] ${t.name}`);
  }
  if (view.attachments.length) {
    console.log(`\n## Attachments`);
    for (const a of view.attachments) console.log(`- ${a.name}  ${a.url}`);
  }
  if (view.comments.length) {
    console.log(`\n## Comments`);
    for (const m of view.comments) console.log(`\n**${m.author}** ${m.at.slice(0, 16).replace('T', ' ')}\n${m.text}`);
  }
}

async function notifications(sock, flags) {
  const { items, included = {} } = await sock.get('/notifications');
  const cards = byId(included.cards);
  const users = byId(included.users);
  const actions = byId(included.actions);
  const rows = items
    .filter((n) => flags.all || !n.isRead)
    .map((n) => {
      const a = actions.get(n.actionId);
      return {
        at: n.createdAt,
        read: n.isRead,
        type: a?.type,
        by: users.get(a?.userId)?.name ?? a?.userId,
        cardId: n.cardId,
        card: cards.get(n.cardId)?.name,
        text: a?.type === 'moveCard' ? `${a.data.fromList.name} -> ${a.data.toList.name}` : a?.data?.text,
      };
    });
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('no unread notifications');
  for (const r of rows) {
    const detail = r.text ? `: ${clip(r.text.replace(/\s+/g, ' '), 160)}` : '';
    console.log(`- ${r.at.slice(0, 16).replace('T', ' ')}  ${r.by} ${r.type}  card ${r.cardId} "${r.card}"${detail}`);
  }
}

const USAGE = `usage: planka.mjs <command> [--json]
  login [email]                       terminal prompt, or a browser form when there is no TTY
  projects                            projects and their boards
  board <id|url> [--list NAME] [--mine] [--label NAME] [--search TEXT]
  card <id|url>                       description, tasks, attachments, comments
  notifications [--all]               unread by default`;

const flags = parseFlags(process.argv.slice(2));
const cmd = flags._[0];
if (cmd === 'login') {
  await login(flags._[1]);
} else if (['projects', 'board', 'card', 'notifications'].includes(cmd)) {
  const token = await ensureToken();
  const sock = new Socket(token);
  await sock.open();
  try {
    const run = { projects, board, card, notifications }[cmd];
    await run(sock, flags, userIdFromToken(token));
  } finally {
    sock.close();
  }
} else {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
