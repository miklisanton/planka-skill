#!/usr/bin/env node
// Read-only Planka v1 client. Board/card endpoints only answer over the Sails
// socket (plain HTTP returns 400), and the socket handshake requires an Origin header.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const LOGIN_HINT = `not logged in. In a terminal run: node ${import.meta.filename} login`;

function readToken() {
  if (process.env.PLANKA_TOKEN) return BASE ? process.env.PLANKA_TOKEN.trim() : die('PLANKA_TOKEN needs PLANKA_URL');
  return BASE && config.token;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function askHidden(question) {
  process.stdout.write(question);
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
          process.stdout.write('\n');
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

async function requestToken(email, password) {
  const res = await fetch(`${BASE}/api/access-tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrUsername: email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.item) return body.item;
  if (res.status === 401) return null;
  die(`login failed: ${res.status} ${JSON.stringify(body)}`);
}

// Credentials come from args/env when given, otherwise from a TTY prompt.
async function login(emailArg) {
  const interactive = process.stdin.isTTY;
  if (!interactive && !((emailArg || process.env.PLANKA_EMAIL) && process.env.PLANKA_PASSWORD)) die(LOGIN_HINT);
  if (!BASE && !interactive) die('PLANKA_URL is required for non-interactive login');
  BASE ??= normalizeUrl(await ask('Planka URL (e.g. planka.example.com): '));
  if (interactive) console.log(`Logging in to ${BASE}`);
  for (let attempt = 1; ; attempt++) {
    const email = emailArg || process.env.PLANKA_EMAIL || (await ask('Email or username: '));
    const password = process.env.PLANKA_PASSWORD || (await askHidden('Password: '));
    const token = await requestToken(email, password);
    if (token) {
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(CONFIG_FILE, `${JSON.stringify({ url: BASE, token }, null, 2)}\n`, { mode: 0o600 });
      const sock = new Socket(token);
      await sock.open();
      const me = (await sock.get('/users/me')).item;
      sock.close();
      console.log(`Logged in as ${me.name} (${me.email}). Saved to ${CONFIG_FILE}`);
      return token;
    }
    if (!interactive || process.env.PLANKA_PASSWORD || attempt === 3) die('invalid email or password');
    console.log('Invalid email or password, try again.');
  }
}

async function ensureToken() {
  const token = readToken();
  if (token) return token;
  if (!process.stdin.isTTY) die(LOGIN_HINT);
  console.log('No Planka token found.');
  return login();
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
  login [email]                       prompts for credentials; saves token
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
