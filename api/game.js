import crypto from 'node:crypto';
import * as D from '../lib/data.js';

const KEYS = ['prof', 'bio', 'health', 'hobby', 'phobia', 'trait', 'baggage', 'fact'];
const LABEL = {
  prof: 'профессию', bio: 'биологию', health: 'здоровье', hobby: 'хобби',
  phobia: 'фобию', trait: 'характер', baggage: 'багаж', fact: 'факт',
};
const NAME = {
  prof: 'Профессия', bio: 'Биология', health: 'Здоровье', hobby: 'Хобби',
  phobia: 'Фобия', trait: 'Характер', baggage: 'Багаж', fact: 'Факт',
};
const TTL = 60 * 60 * 48; // комната живёт двое суток
const MAX_PLAYERS = 20;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- Redis (Upstash REST) ----------

function creds() {
  const env = process.env;
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  let token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    for (const k of Object.keys(env)) {
      if (!url && /REST_(API_)?URL$/.test(k) && /^https:/.test(env[k] || '')) url = env[k];
      if (!token && /REST_(API_)?TOKEN$/.test(k) && !/READ_ONLY/.test(k)) token = env[k];
    }
  }
  return { url, token };
}

async function redis(...cmd) {
  const { url, token } = creds();
  if (!url || !token) {
    throw new HttpError(500, 'База не подключена. В Vercel открой проект → Storage → Upstash Redis → Connect, потом сделай Redeploy.');
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Redis: ' + (j.error || r.status));
  return j.result;
}

const sKey = (c) => `bunker:${c}:state`;
const lKey = (c) => `bunker:${c}:lock`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(code) {
  const raw = await redis('GET', sKey(code));
  if (!raw) throw new HttpError(404, 'Комната не найдена. Проверь код или создай новую игру.');
  return JSON.parse(raw);
}
async function save(s) {
  s.v = (s.v || 0) + 1;
  await redis('SET', sKey(s.code), JSON.stringify(s), 'EX', TTL);
}
async function withLock(code, fn) {
  const id = rid(6);
  for (let i = 0; i < 80; i++) {
    if ((await redis('SET', lKey(code), id, 'NX', 'PX', 5000)) === 'OK') {
      try { return await fn(); } finally {
        await redis('EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0", 1, lKey(code), id).catch(() => {});
      }
    }
    await sleep(30 + Math.random() * 70);
  }
  throw new HttpError(503, 'Сервер занят, нажми ещё раз');
}

// ---------- Случайности ----------

const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const txt = (x) => (typeof x === 'string' ? x : x.t);

function genBio() {
  const g = Math.random() < 0.5 ? 'm' : 'f';
  const age = 18 + Math.floor(Math.pow(Math.random(), 1.35) * 63);
  let t = `${g === 'm' ? 'Мужчина' : 'Женщина'}, ${age} ${plural(age, 'год', 'года', 'лет')}`;
  if (Math.random() < 0.15) t += g === 'm' ? ', бесплоден' : ', бесплодна';
  return { g, t };
}
function genProf(name) {
  if (Math.random() < 0.1) return `${name}, стажёр без опыта`;
  const y = 1 + rnd(25);
  return `${name}, стаж ${y} ${plural(y, 'год', 'года', 'лет')}`;
}
function genCat(except) {
  const pool = D.catastrophes.filter((c) => c.title !== except);
  const c = pick(pool);
  return { title: c.title, text: c.text, years: pick(D.durations), alive: pick(D.survivors) };
}
function genBunker() {
  return { area: pick(D.bunkerSizes), food: pick(D.foodSupply), rooms: shuffle([...D.rooms]).slice(0, 3) };
}

// Свежее значение характеристики, которого ни у кого сейчас нет
function freshValue(s, key, p) {
  if (key === 'bio') { const b = genBio(); p.g = b.g; return b.t; }
  const used = new Set(s.players.filter((x) => x.card).map((x) => x.card[key]));
  let deck = D[key].filter((x) => !(typeof x === 'object' && x.g && x.g !== p.g)).map(txt);
  if (key === 'prof') {
    const names = new Set([...used].map((v) => v.split(',')[0]));
    deck = deck.filter((x) => !names.has(x));
    return genProf(pick(deck.length ? deck : D.prof));
  }
  const free = deck.filter((x) => !used.has(x) && x !== p.card?.[key]);
  return pick(free.length ? free : deck);
}

function deal(s) {
  const decks = {};
  for (const k of ['prof', 'hobby', 'phobia', 'trait', 'baggage', 'fact']) decks[k] = shuffle([...D[k]]);
  const healthDeck = shuffle([...D.health]);
  const sp = shuffle([...D.specials]);
  let spi = 0;
  s.players.forEach((p, i) => {
    const bio = genBio();
    p.g = bio.g;
    const hi = healthDeck.findIndex((h) => !(typeof h === 'object' && h.g && h.g !== bio.g));
    const health = hi >= 0 ? txt(healthDeck.splice(hi, 1)[0]) : txt(pick(D.health.filter((h) => typeof h === 'string')));
    p.card = {
      prof: genProf(decks.prof[i % decks.prof.length]),
      bio: bio.t,
      health,
      hobby: decks.hobby[i % decks.hobby.length],
      phobia: decks.phobia[i % decks.phobia.length],
      trait: decks.trait[i % decks.trait.length],
      baggage: decks.baggage[i % decks.baggage.length],
      fact: decks.fact[i % decks.fact.length],
    };
    p.rev = {};
    p.out = false;
    p.sp = [0, 1].map(() => ({ t: sp[spi++ % sp.length], used: false }));
  });
  s.world = { cat: genCat(), bunker: genBunker() };
  s.places = Math.max(1, Math.floor(s.players.length / 2));
  s.round = 1;
  s.vote = null;
  s.phase = 'game';
}

// ---------- Вид состояния для конкретного игрока ----------

function view(s, me) {
  const all = s.phase === 'final';
  const alive = s.players.filter((p) => !p.out);
  let vote = null;
  if (s.vote) {
    vote = s.vote.open
      ? { open: true, voted: Object.keys(s.vote.votes).length, total: alive.length, mine: s.vote.votes[me.id] || null }
      : { open: false, votes: s.vote.votes };
  }
  return {
    v: s.v, code: s.code, phase: s.phase, round: s.round, places: s.places,
    hostId: s.hostId, world: s.world, vote, log: s.log.slice(-60),
    me: { id: me.id, name: me.name, pin: me.pin, out: me.out, card: me.card, rev: me.rev || {}, sp: me.sp || [] },
    players: s.players.map((p) => {
      const card = {};
      if (p.card) for (const k of KEYS) if (all || p.rev[k] || p.id === me.id) card[k] = p.card[k];
      return {
        id: p.id, name: p.name, out: p.out, rev: p.rev || {}, card,
        sp: (p.sp || []).filter((x) => x.used).map((x) => x.t),
      };
    }),
  };
}

// ---------- Действия ----------

function log(s, text) {
  s.logN = (s.logN || 0) + 1;
  s.log.push({ n: s.logN, text });
  if (s.log.length > 80) s.log = s.log.slice(-80);
}
function needHost(s, me) { if (s.hostId !== me.id) throw new HttpError(403, 'Это может сделать только ведущий'); }
function needPhase(s, ph) { if (s.phase !== ph) throw bad(ph === 'lobby' ? 'Игра уже началась' : 'Сейчас этого сделать нельзя'); }
function player(s, id, msg = 'Игрок не найден') {
  const p = s.players.find((x) => x.id === id);
  if (!p) throw bad(msg);
  return p;
}
function needKey(k) { if (!KEYS.includes(k)) throw bad('Неизвестная характеристика'); return k; }
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);

const ACTIONS = {
  leave(s, me) {
    needPhase(s, 'lobby');
    s.players = s.players.filter((p) => p.id !== me.id);
    if (s.hostId === me.id && s.players[0]) s.hostId = s.players[0].id;
    log(s, `${me.name} выходит из комнаты`);
  },
  kick(s, me, q) {
    needHost(s, me); needPhase(s, 'lobby');
    const t = player(s, q.target);
    if (t.id === me.id) throw bad('Себя убрать нельзя');
    s.players = s.players.filter((p) => p.id !== t.id);
    log(s, `${t.name} больше не в комнате`);
  },
  start(s, me) {
    needHost(s, me); needPhase(s, 'lobby');
    if (s.players.length < 2) throw bad('Нужно хотя бы 2 игрока');
    deal(s);
    log(s, `Катастрофа: ${s.world.cat.title}. Мест в бункере: ${s.places} из ${s.players.length}`);
  },
  reveal(s, me, q) {
    needPhase(s, 'game');
    const k = needKey(q.key);
    if (me.rev[k]) throw bad('Уже открыто');
    me.rev[k] = true;
    log(s, `${me.name} открывает ${LABEL[k]}: ${me.card[k]}`);
  },
  special(s, me, q) {
    needPhase(s, 'game');
    const c = me.sp[Number(q.idx)];
    if (!c) throw bad('Нет такой карты');
    if (c.used) throw bad('Эта карта уже сыграна');
    c.used = true;
    log(s, `${me.name} играет спецкарту: «${c.t}»`);
  },
  round(s, me) {
    needHost(s, me); needPhase(s, 'game');
    s.round += 1;
    log(s, `Начинается раунд ${s.round}`);
  },
  voteStart(s, me) {
    needHost(s, me); needPhase(s, 'game');
    s.vote = { open: true, votes: {} };
    log(s, 'Голосование открыто');
  },
  vote(s, me, q) {
    needPhase(s, 'game');
    if (!s.vote?.open) throw bad('Голосование закрыто');
    if (me.out) throw bad('Изгнанные не голосуют');
    const t = player(s, q.target);
    if (t.out) throw bad('Этот игрок уже снаружи');
    if (t.id === me.id) throw bad('За себя голосовать нельзя');
    s.vote.votes[me.id] = t.id;
  },
  voteClose(s, me) {
    needHost(s, me);
    if (!s.vote?.open) throw bad('Голосование не идёт');
    s.vote.open = false;
    const tally = {};
    for (const t of Object.values(s.vote.votes)) tally[t] = (tally[t] || 0) + 1;
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    log(s, top.length
      ? 'Итоги: ' + top.map(([id, n]) => `${s.players.find((p) => p.id === id)?.name} ${n}`).join(', ')
      : 'Голосование закрыто, голосов нет');
  },
  voteCancel(s, me) {
    needHost(s, me);
    const wasOpen = s.vote?.open;
    s.vote = null;
    if (wasOpen) log(s, 'Голосование отменено');
  },
  exile(s, me, q) {
    needHost(s, me); needPhase(s, 'game');
    const t = player(s, q.target);
    if (t.out) throw bad('Игрок уже снаружи');
    t.out = true;
    if (s.vote && !s.vote.open) s.vote = null;
    const left = s.players.filter((p) => !p.out).length;
    log(s, `${t.name} остаётся за дверью бункера. Внутри ${left}, мест ${s.places}`);
  },
  restore(s, me, q) {
    needHost(s, me); needPhase(s, 'game');
    const t = player(s, q.target);
    if (!t.out) throw bad('Игрок и так в игре');
    t.out = false;
    log(s, `${t.name} возвращается в игру`);
  },
  places(s, me, q) {
    needHost(s, me); needPhase(s, 'game');
    const d = Number(q.delta) > 0 ? 1 : -1;
    const next = s.places + d;
    if (next < 1 || next > s.players.length) throw bad('Дальше нельзя');
    s.places = next;
    log(s, `Теперь в бункере ${s.places} ${plural(s.places, 'место', 'места', 'мест')}`);
  },
  newCat(s, me) {
    needHost(s, me); needPhase(s, 'game');
    s.world.cat = genCat(s.world.cat.title);
    log(s, `Новая катастрофа: ${s.world.cat.title}`);
  },
  addRoom(s, me) {
    needHost(s, me); needPhase(s, 'game');
    const free = D.rooms.filter((r) => !s.world.bunker.rooms.includes(r));
    if (!free.length) throw bad('Комнаты закончились');
    const r = pick(free);
    s.world.bunker.rooms.push(r);
    log(s, `В бункере нашли ещё одну комнату: ${r}`);
  },
  tool(s, me, q) {
    needHost(s, me); needPhase(s, 'game');
    const k = needKey(q.key);
    if (q.op === 'reroll') {
      const t = player(s, q.target, 'Выбери игрока');
      t.card[k] = freshValue(s, k, t);
      log(s, t.rev[k] ? `${t.name} получает новую карту «${NAME[k]}»: ${t.card[k]}` : `${t.name} получает новую карту «${NAME[k]}», она пока закрыта`);
    } else if (q.op === 'swap') {
      const a = player(s, q.target, 'Выбери первого игрока');
      const b = player(s, q.other, 'Выбери второго игрока');
      if (a.id === b.id) throw bad('Выбери двух разных игроков');
      [a.card[k], b.card[k]] = [b.card[k], a.card[k]];
      [a.rev[k], b.rev[k]] = [b.rev[k], a.rev[k]];
      if (k === 'bio') [a.g, b.g] = [b.g, a.g];
      log(s, `${a.name} и ${b.name} меняются картами «${NAME[k]}»`);
    } else if (q.op === 'reveal') {
      if (q.target === 'all') {
        const list = s.players.filter((p) => !p.out && !p.rev[k]);
        list.forEach((p) => { p.rev[k] = true; });
        log(s, `Все открывают ${LABEL[k]}`);
      } else {
        const t = player(s, q.target, 'Выбери игрока');
        if (t.rev[k]) throw bad('Уже открыто');
        t.rev[k] = true;
        log(s, `Ведущий открывает карту «${NAME[k]}» игрока ${t.name}: ${t.card[k]}`);
      }
    } else if (q.op === 'shuffle') {
      const list = s.players.filter((p) => !p.out);
      const pairs = shuffle(list.map((p) => [p.card[k], p.rev[k], p.g]));
      list.forEach((p, i) => {
        p.card[k] = pairs[i][0]; p.rev[k] = pairs[i][1];
        if (k === 'bio') p.g = pairs[i][2];
      });
      log(s, `Карты «${NAME[k]}» перемешаны у всех в бункере`);
    } else throw bad('Неизвестное действие');
  },
  host(s, me, q) {
    needHost(s, me);
    const t = player(s, q.target);
    s.hostId = t.id;
    log(s, `Теперь ведущий — ${t.name}`);
  },
  finish(s, me) {
    needHost(s, me); needPhase(s, 'game');
    s.phase = 'final';
    s.vote = null;
    log(s, 'Двери бункера закрылись');
  },
  again(s, me) {
    needHost(s, me);
    if (s.phase === 'lobby') throw bad('Уже в лобби');
    s.phase = 'lobby';
    s.vote = null; s.world = null; s.round = 0;
    s.players.forEach((p) => { p.card = null; p.rev = {}; p.sp = []; p.out = false; });
    log(s, 'Новая партия, ждём старта');
  },
};

// ---------- Вход в игру ----------

async function create(q) {
  const name = cleanName(q.name);
  if (!name) throw bad('Введи имя');
  const me = { id: rid(6), token: rid(), pin: String(1000 + rnd(9000)), name, card: null, rev: {}, sp: [], out: false };
  for (let i = 0; i < 25; i++) {
    const code = String(1000 + rnd(9000));
    const s = { v: 1, code, phase: 'lobby', hostId: me.id, players: [me], round: 0, places: 0, world: null, vote: null, log: [], logN: 0 };
    log(s, `${name} создаёт комнату`);
    if ((await redis('SET', sKey(code), JSON.stringify(s), 'NX', 'EX', TTL)) === 'OK') {
      return { session: { code, pid: me.id, token: me.token }, state: view(s, me) };
    }
  }
  throw new HttpError(503, 'Не получилось создать комнату, попробуй ещё раз');
}

async function join(q) {
  const code = String(q.code || '').replace(/\D/g, '');
  const name = cleanName(q.name);
  if (code.length !== 4) throw bad('Код комнаты — 4 цифры');
  if (!name) throw bad('Введи имя');
  return withLock(code, async () => {
    const s = await load(code);
    const same = s.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    let me;
    if (same) {
      if (String(q.pin || '').trim() !== same.pin) {
        throw bad(s.phase === 'lobby'
          ? 'Это имя уже занято. Возьми другое или введи PIN, если это ты'
          : 'Чтобы вернуться, введи своё имя и PIN с твоей карты');
      }
      same.token = rid();
      me = same;
    } else {
      if (s.phase !== 'lobby') throw bad('Игра уже идёт. Новые игроки смогут зайти в следующей партии');
      if (s.players.length >= MAX_PLAYERS) throw bad('Комната заполнена');
      me = { id: rid(6), token: rid(), pin: String(1000 + rnd(9000)), name, card: null, rev: {}, sp: [], out: false };
      s.players.push(me);
      log(s, `${name} заходит в комнату`);
    }
    await save(s);
    return { session: { code, pid: me.id, token: me.token }, state: view(s, me) };
  });
}

function auth(s, q) {
  const me = s.players.find((p) => p.id === q.pid);
  if (!me || me.token !== q.token) throw new HttpError(401, 'Ты больше не в этой комнате. Зайди заново');
  return me;
}

// ---------- HTTP ----------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const q = { ...(req.query || {}), ...body };
    const action = q.action || 'state';
    let out;
    if (action === 'create') out = await create(q);
    else if (action === 'join') out = await join(q);
    else {
      const code = String(q.code || '').replace(/\D/g, '');
      if (action === 'state') {
        const s = await load(code);
        const me = auth(s, q);
        out = Number(q.v) === s.v ? { same: true } : { state: view(s, me) };
      } else {
        const fn = ACTIONS[action];
        if (!fn) throw bad('Неизвестное действие');
        out = await withLock(code, async () => {
          const s = await load(code);
          const me = auth(s, q);
          fn(s, me, q);
          if (!s.players.length) { await redis('DEL', sKey(code)); return { state: null }; }
          await save(s);
          return { state: s.players.includes(me) ? view(s, me) : null };
        });
      }
    }
    res.status(200).json(out);
  } catch (e) {
    const status = e.status || 500;
    res.status(status).json({ error: e.status ? e.message : 'Ошибка сервера: ' + e.message });
  }
}

