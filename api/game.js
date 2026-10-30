import crypto from 'node:crypto';
import * as D from '../lib/data.js';

const KEYS = ['prof', 'bio', 'health', 'hobby', 'phobia', 'trait', 'baggage', 'fact'];
const DEAL = ['health', 'hobby', 'phobia', 'trait', 'baggage', 'fact'];
const NAME = {
  prof: 'Профессия', bio: 'Биология', health: 'Здоровье', hobby: 'Хобби',
  phobia: 'Фобия', trait: 'Характер', baggage: 'Багаж', fact: 'Факт',
};
const ACC = {
  prof: 'профессию', bio: 'биологию', health: 'здоровье', hobby: 'хобби',
  phobia: 'фобию', trait: 'характер', baggage: 'багаж', fact: 'факт',
};
const NEED = {
  med: 'Медицина', food: 'Еда', tech: 'Техника и энергия', def: 'Защита', surv: 'Выживание снаружи',
  psy: 'Психологический климат', know: 'Знания', fun: 'Моральный дух', kids: 'Продолжение рода',
};
const TTL = 60 * 60 * 48;
const MAX_PLAYERS = 16;
const TARGET = 2; // средняя «сила» руки, к которой подгоняется каждый игрок

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

const sKey = (c) => `bunker2:${c}:state`;
const lKey = (c) => `bunker2:${c}:lock`;
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

// ---------- Утилиты ----------

const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function pickW(list) {
  let r = Math.random() * list.reduce((a, x) => a + x.w, 0);
  for (const x of list) { r -= x.w; if (r <= 0) return x; }
  return list[0];
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const years = (n) => `${n} ${plural(n, 'год', 'года', 'лет')}`;
// «Смел{ый|ая}» → форма для пола владельца карты
const gform = (t, g) => String(t).replace(/\{([^|{}]*)\|([^{}]*)\}/g, (_, m, f) => (g === 'f' ? f : m));
const gOf = (p) => p.card?.bio?.g || 'm';
const text = (p, k) => gform(p.card[k].t, gOf(p));
const copy = (c) => ({ t: c.t, v: c.v, tags: [...c.tags] });

// ---------- Генерация карт ----------

function genAge() {
  const r = Math.random();
  if (r < 0.62) return 18 + rnd(15);
  if (r < 0.88) return 33 + rnd(20);
  return 53 + rnd(30);
}

function genBio(g, opts) {
  const age = genAge();
  const trans = !!opts.orient && Math.random() < 0.05;
  let fert = !trans && Math.random() >= 0.08;
  let t = trans ? (g === 'm' ? 'Трансгендерный мужчина' : 'Трансгендерная женщина') : (g === 'm' ? 'Мужчина' : 'Женщина');
  t += ', ' + years(age);
  if (opts.orient) t += ', ' + pickW(D.orientations)[g];
  if (!trans && !fert) t += g === 'm' ? ', бесплоден' : ', бесплодна';
  const v = (age <= 30 ? 1 : age <= 45 ? 0 : age <= 60 ? -1 : -2) + (!trans && !fert ? -1 : 0);
  return { t, v, tags: [], g, age, fert, trans };
}

function genProf(c, age) {
  const card = copy(c);
  if (c.tags.includes('nostaj')) return card;
  if (Math.random() < 0.1) {
    card.t += ', стажёр';
    card.v = Math.max(-1, card.v - 1);
  } else {
    const y = 1 + rnd(Math.max(1, Math.min(30, age - 18)));
    card.t += ', стаж ' + years(y);
  }
  return card;
}

function fits(c, bio) {
  if (c.tags.includes('M') && bio.g !== 'm') return false;
  if (c.tags.includes('F') && bio.g !== 'f') return false;
  if (c.tags.includes('preg') && (bio.trans || bio.age > 44)) return false;
  return true;
}

// Оценка руки: чем ближе к нулю, тем лучше сбалансирован игрок
function scoreHand(prof, bio, hand) {
  const cards = DEAL.map((k) => hand[k]);
  const total = prof.v + bio.v + cards.reduce((a, c) => a + c.v, 0);
  let score = Math.max(0, Math.abs(total - TARGET) - 1);
  const weak = ['health', 'phobia', 'trait', 'fact'].map((k) => hand[k].v);
  const trumps = ['baggage', 'hobby', 'fact'].map((k) => hand[k].v);
  if (prof.v >= 3 && Math.min(...weak) > -2) score += 2; // сильному — заметную слабость
  if (prof.v <= 0 && Math.max(...trumps) < 2) score += 2; // слабому — козырь в рукаве
  if (Math.min(...cards.map((c) => c.v)) > -1) score += 1; // у каждого есть хоть один минус
  if (cards.filter((c) => c.v <= -3).length > 1) score += 2;
  if (cards.filter((c) => c.v >= 3).length > 1) score += 1;
  // смешная антисинергия: хирург, который боится крови
  if (prof.v >= 2 && cards.some((c) => prof.tags.some((t) => c.tags.includes('anti-' + t)))) score -= 0.5;
  return score;
}

function dealHand(prof, bio, used) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < 400; i++) {
    const hand = {};
    let ok = true;
    for (const k of DEAL) {
      const pool = D[k];
      let c = null;
      for (let j = 0; j < 8 && !c; j++) {
        const x = pool[rnd(pool.length)];
        if (!used[k].has(x.t) && fits(x, bio)) c = x;
      }
      if (!c) { ok = false; break; }
      hand[k] = c;
    }
    if (!ok) continue;
    const sc = scoreHand(prof, bio, hand);
    if (sc < bestScore) { best = hand; bestScore = sc; }
    if (sc <= 0) break;
  }
  if (!best) { // запасной путь, если колоды почти пустые
    best = {};
    for (const k of DEAL) best[k] = D[k].find((x) => fits(x, bio) && !used[k].has(x.t)) || D[k][0];
  }
  for (const k of DEAL) used[k].add(best[k].t);
  return best;
}

function genBunker() {
  return {
    area: pick(D.bunkerSizes), food: pick(D.foodSupply),
    rooms: shuffle([...D.rooms]).slice(0, 3), problems: [pick(D.problems)],
  };
}
function genCat(except) {
  const c = pick(D.catastrophes.filter((x) => x.title !== except));
  return { title: c.title, text: c.text, needs: [...c.needs], years: pick(D.durations), alive: pick(D.survivors) };
}

function deal(s) {
  const n = s.players.length;
  const opts = s.opts || {};

  // пол: поровну, лишний — случайно
  const genders = shuffle(Array.from({ length: n }, (_, i) => (i < Math.floor(n / 2) ? 'm' : 'f')));
  if (n % 2 && Math.random() < 0.5) genders[genders.indexOf('f')] = 'm';
  let bios = genders.map((g) => genBio(g, opts));

  // хотя бы одна (а в большой компании две) пара, способная продолжить род
  const need = n >= 8 ? 2 : 1;
  const fertile = (g) => bios.filter((b) => b.g === g && b.fert && b.age <= (g === 'f' ? 44 : 60)).length;
  for (let i = 0; i < 60 && (fertile('m') < need || fertile('f') < need); i++) {
    const g = fertile('m') < need ? 'm' : 'f';
    const idx = shuffle(bios.map((b, j) => j).filter((j) => bios[j].g === g))[0];
    if (idx !== undefined) bios[idx] = genBio(g, opts);
  }

  // профессии: примерно треть по-настоящему полезных, остальные — угар
  const strongN = Math.max(1, Math.round(n * 0.3));
  const strong = shuffle(D.prof.filter((c) => c.v >= 2)).slice(0, strongN);
  const weak = shuffle(D.prof.filter((c) => c.v < 2)).slice(0, n - strongN);
  const profs = shuffle([...strong, ...weak]);

  const used = Object.fromEntries(DEAL.map((k) => [k, new Set()]));
  const sp = shuffle([...D.specials]);
  s.players.forEach((p, i) => {
    const bio = bios[i];
    const prof = genProf(profs[i], bio.age);
    const hand = dealHand(prof, bio, used);
    p.card = { prof, bio };
    for (const k of DEAL) p.card[k] = copy(hand[k]);
    p.rev = {};
    p.rr = 0;
    p.out = false;
    p.sp = [0, 1].map((j) => ({ t: sp[(i * 2 + j) % sp.length], used: false }));
  });

  s.world = { cat: genCat(), bunker: genBunker() };
  s.places = Math.max(1, Math.floor(n / 2));
  s.rounds = Math.min(5, Math.max(2, n - s.places + 1));
  s.round = 1;
  s.vote = null;
  s.event = null;
  s.events = [];
  s.evUsed = [];
  s.verdict = null;
  s.phase = 'game';
}

// Новая случайная карта, которой сейчас ни у кого нет
function freshCard(s, key, p) {
  if (key === 'bio') return genBio(Math.random() < 0.5 ? 'm' : 'f', s.opts || {});
  const bio = p.card.bio;
  if (key === 'prof') {
    const names = new Set(s.players.filter((x) => x.card).map((x) => x.card.prof.t.split(',')[0]));
    const pool = D.prof.filter((c) => !names.has(c.t));
    return genProf(pick(pool.length ? pool : D.prof), bio.age);
  }
  const usedT = new Set(s.players.filter((x) => x.card).map((x) => x.card[key].t));
  const pool = D[key].filter((c) => fits(c, bio) && !usedT.has(c.t));
  return copy(pick(pool.length ? pool : D[key].filter((c) => fits(c, bio))));
}

// ---------- Раунды ----------

function votesThisRound(s) {
  const alive = s.players.filter((p) => !p.out).length;
  const need = alive - s.places;
  if (need <= 0) return 0;
  if (s.round > s.rounds) return need;
  if (s.round === 1) return need > (s.rounds - 1) * 2 ? 1 : 0;
  return Math.ceil(need / (s.rounds - s.round + 1));
}

// ---------- Финал: выживет ли бункер ----------

function verdict(s) {
  const inside = s.players.filter((p) => !p.out);
  const needs = s.world.cat.needs;
  // сила навыка: профессия весит больше, чем хобби или вещь
  const power = (tag) => {
    let sum = 0, best = null, bestV = -1;
    for (const p of inside) for (const k of KEYS) {
      const c = p.card[k];
      if (!c.tags.includes(tag) || c.v <= 0) continue;
      const v = c.v * (k === 'prof' ? 1.5 : 1);
      sum += v;
      if (v > bestV) { bestV = v; const t = text(p, k).split(',')[0]; best = `${p.name}: ${t[0].toLowerCase()}${t.slice(1)}`; }
    }
    return { sum, best };
  };
  const checks = [];
  const add = (key, ok, good, badText, label) => checks.push({ key, label: label || NEED[key], ok, text: ok ? good : badText, w: needs.includes(key) ? 2 : 1, need: needs.includes(key) });
  const skill = (tag, badText, weakText) => {
    const { sum, best } = power(tag);
    const goal = needs.includes(tag) ? 4 : 3;
    add(tag, sum >= goal, best, best ? weakText(best) : badText);
  };

  skill('med', 'Лечить некому. Первая же простуда станет последней.', (b) => `Есть только ${b}. Для серьёзного лечения этого мало.`);
  skill('food', 'Еду добывать никто не умеет. Когда кончатся запасы, начнётся голод.', (b) => `Есть только ${b}. Еды хватит впритык.`);
  skill('tech', 'Когда сломается генератор, его никто не починит.', (b) => `Есть только ${b}. Серьёзную поломку не осилить.`);
  skill('def', 'Если снаружи постучат, отбиваться будет нечем.', (b) => `Есть только ${b}. От серьёзной угрозы не отбиться.`);
  for (const tag of ['surv', 'know', 'fun']) {
    if (!needs.includes(tag)) continue;
    skill(tag, { surv: 'Выйти на поверхность никто не готов.', know: 'Без знаний придётся заново изобретать колесо.', fun: 'Скука убьёт вас быстрее катастрофы.' }[tag], (b) => `Есть только ${b}. Этого не хватит.`);
  }

  const toxic = inside.filter((p) => p.card.trait.v <= -2);
  const glue = power('psy').best || power('fun').best;
  add('psy', !!glue && toxic.length < 2, glue,
    toxic.length >= 2 ? `${toxic.map((p) => p.name).join(' и ')} — слишком тяжёлые характеры. Через месяц начнётся война за тушёнку.` : 'Никто не умеет держать людей вместе. Через месяц вы перегрызётесь.');

  const sick = inside.filter((p) => p.card.health.v <= -2);
  add('health', sick.length < 2, sick.length ? `Болеет только ${sick[0].name}, справитесь` : 'Все в бункере более-менее здоровы',
    `Болеют ${sick.map((p) => p.name).join(', ')}. На них уйдут все лекарства.`, 'Здоровье группы');

  const noFert = (p) => !p.card.bio.fert || KEYS.some((k) => p.card[k].tags.includes('nofert'));
  const m = inside.find((p) => p.card.bio.g === 'm' && !noFert(p) && p.card.bio.age <= 60);
  const f = inside.find((p) => p.card.bio.g === 'f' && !noFert(p) && p.card.bio.age <= 44);
  const preg = inside.find((p) => p.card.health.tags.includes('preg'));
  add('kids', !!(m && f) || !!preg,
    preg ? `${preg.name} уже ждёт ребёнка` : m && f ? `${m.name} и ${f.name} могут продолжить род` : '',
    'Детей не будет. Человечество закончится на вас.');

  const max = checks.reduce((a, c) => a + c.w, 0);
  const got = checks.reduce((a, c) => a + (c.ok ? c.w : 0), 0);
  const r = got / max;
  let title, story;
  if (r >= 0.85) { title = 'Человечество спасено'; story = `Через ${s.world.cat.years} вы выходите наружу и строите новый город.`; }
  else if (r >= 0.6) { title = 'Вы выжили'; story = 'Не без потерь, но цивилизация потихоньку возродится.'; }
  else if (r >= 0.35) { title = 'Еле дотянули'; story = 'До конца срока дожили не все. Наружу вышли уставшие и злые.'; }
  else { title = 'Бункер не выдержал'; story = 'Археологи будущего найдут здесь очень странную компанию.'; }
  return { title, story, checks: checks.map(({ w, ...c }) => c) };
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
  const cardOf = (p, full) => {
    const card = {};
    if (p.card) for (const k of KEYS) if (full || p.rev[k]) card[k] = text(p, k);
    return card;
  };
  return {
    v: s.v, code: s.code, phase: s.phase, round: s.round, rounds: s.rounds, places: s.places,
    opts: s.opts || {}, hostId: s.hostId, world: s.world, vote, event: s.event, events: s.events || [],
    votesNow: s.phase === 'game' ? votesThisRound(s) : 0,
    verdict: s.verdict, log: s.log.slice(-60), needLabels: NEED,
    me: { id: me.id, name: me.name, pin: me.pin, out: me.out, card: cardOf(me, true), rev: me.rev || {}, rr: me.rr || 0, sp: me.sp || [] },
    players: s.players.map((p) => ({
      id: p.id, name: p.name, out: p.out, rev: p.rev || {}, rr: p.rr || 0,
      card: cardOf(p, all || p.id === me.id),
      sp: (p.sp || []).filter((x) => x.used).map((x) => x.t),
    })),
  };
}

// ---------- Действия ----------

function log(s, t) {
  s.logN = (s.logN || 0) + 1;
  s.log.push({ n: s.logN, text: t });
  if (s.log.length > 80) s.log = s.log.slice(-80);
}
function needHost(s, me) { if (s.hostId !== me.id) throw new HttpError(403, 'Это может сделать только ведущий'); }
function needPhase(s, ph) { if (s.phase !== ph) throw bad(ph === 'lobby' ? 'Игра уже началась' : 'Сейчас этого сделать нельзя'); }
function player(s, id, msg = 'Игрок не найден') {
  const p = s.players.find((x) => x.id === id);
  if (!p) throw bad(msg);
  return p;
}
function needKey(k) { if (!KEYS.includes(k)) throw bad('Неизвестная карта'); return k; }
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);

function changePlaces(s, d) {
  const next = s.places + d;
  if (next < 1 || next > s.players.length) return false;
  s.places = next;
  return true;
}
function revealAll(s, k) {
  s.players.filter((p) => !p.out).forEach((p) => { p.rev[k] = true; });
}

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
  opts(s, me, q) {
    needHost(s, me); needPhase(s, 'lobby');
    s.opts = { ...(s.opts || {}), orient: !!q.orient };
  },
  start(s, me) {
    needHost(s, me); needPhase(s, 'lobby');
    if (s.players.length < 3) throw bad('Нужно хотя бы 3 игрока');
    deal(s);
    log(s, `Катастрофа: ${s.world.cat.title}. Мест в бункере: ${s.places} из ${s.players.length}`);
  },
  reveal(s, me, q) {
    needPhase(s, 'game');
    const k = needKey(q.key);
    if (me.rev[k]) throw bad('Уже открыто');
    me.rev[k] = true;
    me.rr = (me.rr || 0) + 1;
    log(s, `${me.name} открывает ${ACC[k]}: ${text(me, k)}`);
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
    s.event = null;
    s.players.forEach((p) => { p.rr = 0; });
    log(s, `Начинается раунд ${s.round}`);
  },
  event(s, me) {
    needHost(s, me); needPhase(s, 'game');
    let free = D.events.map((_, i) => i).filter((i) => !s.evUsed.includes(i));
    if (!free.length) { s.evUsed = []; free = D.events.map((_, i) => i); }
    const i = pick(free);
    s.evUsed.push(i);
    const e = D.events[i];
    const fx = e.tags[0] || '';
    let extra = '';
    if (fx === 'place+' && !changePlaces(s, 1)) extra = ' Но больше мест уже некуда.';
    if (fx === 'place-' && !changePlaces(s, -1)) extra = ' Но меньше одного места быть не может.';
    if (fx.startsWith('reveal:')) revealAll(s, fx.slice(7));
    if (fx === 'room') {
      const r = pick(D.rooms.filter((x) => !s.world.bunker.rooms.includes(x)) || D.rooms);
      if (r) { s.world.bunker.rooms.push(r); extra = ` Это ${r.toLowerCase()}.`; }
    }
    if (fx === 'problem') {
      const r = pick(D.problems.filter((x) => !s.world.bunker.problems.includes(x)));
      if (r) { s.world.bunker.problems.push(r); extra = ` ${r}.`; }
    }
    s.event = { t: e.t + extra, round: s.round };
    s.events.push(s.event);
    log(s, `Событие: ${e.t}${extra}`);
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
    log(s, `${t.name} остаётся за дверью. Внутри ${left}, мест ${s.places}`);
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
    if (!changePlaces(s, Number(q.delta) > 0 ? 1 : -1)) throw bad('Дальше нельзя');
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
      t.card[k] = freshCard(s, k, t);
      log(s, t.rev[k] ? `${t.name} получает новую карту «${NAME[k]}»: ${text(t, k)}` : `${t.name} получает новую карту «${NAME[k]}», она пока закрыта`);
    } else if (q.op === 'swap') {
      const a = player(s, q.target, 'Выбери первого игрока');
      const b = player(s, q.other, 'Выбери второго игрока');
      if (a.id === b.id) throw bad('Выбери двух разных игроков');
      [a.card[k], b.card[k]] = [b.card[k], a.card[k]];
      [a.rev[k], b.rev[k]] = [b.rev[k], a.rev[k]];
      log(s, `${a.name} и ${b.name} меняются картами «${NAME[k]}»`);
    } else if (q.op === 'reveal') {
      if (q.target === 'all') {
        revealAll(s, k);
        log(s, `Все открывают ${ACC[k]}`);
      } else {
        const t = player(s, q.target, 'Выбери игрока');
        if (t.rev[k]) throw bad('Уже открыто');
        t.rev[k] = true;
        log(s, `Ведущий открывает ${ACC[k]} игрока ${t.name}: ${text(t, k)}`);
      }
    } else if (q.op === 'shuffle') {
      const list = s.players.filter((p) => !p.out);
      const pairs = shuffle(list.map((p) => [p.card[k], p.rev[k]]));
      list.forEach((p, i) => { p.card[k] = pairs[i][0]; p.rev[k] = pairs[i][1]; });
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
    s.event = null;
    s.verdict = verdict(s);
    log(s, `Двери бункера закрылись. ${s.verdict.title}`);
  },
  again(s, me) {
    needHost(s, me);
    if (s.phase === 'lobby') throw bad('Уже в лобби');
    s.phase = 'lobby';
    Object.assign(s, { vote: null, world: null, round: 0, event: null, events: [], verdict: null });
    s.players.forEach((p) => { p.card = null; p.rev = {}; p.sp = []; p.out = false; p.rr = 0; });
    log(s, 'Новая партия, ждём старта');
  },
};

// ---------- Вход в игру ----------

const newPlayer = (name) => ({ id: rid(6), token: rid(), pin: String(1000 + rnd(9000)), name, card: null, rev: {}, sp: [], out: false, rr: 0 });

async function create(q) {
  const name = cleanName(q.name);
  if (!name) throw bad('Введи имя');
  const me = newPlayer(name);
  for (let i = 0; i < 25; i++) {
    const code = String(1000 + rnd(9000));
    const s = { v: 1, code, phase: 'lobby', hostId: me.id, players: [me], round: 0, places: 0, opts: { orient: true }, world: null, vote: null, log: [], logN: 0 };
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
      if (s.players.length >= MAX_PLAYERS) throw bad('Комната заполнена, максимум 16 игроков');
      me = newPlayer(name);
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

// для проверки баланса в тестах
export const _test = { deal, verdict, scoreHand, gform, KEYS };
