// Самый дешёвый флот против заданной обороны: перебор составов военного флота (доли по стоимости шагом 10%)
// и его размера. Добыча не учитывается.
// Чистые потери = погибшие корабли + топливо флота − (обломки − топливо переработчиков, чтобы их собрать);
// обломки — 30% металла и кристалла погибших кораблей обеих сторон; всё в металле по курсу 1 : 2 : 4.
// Стартовые составы — REF_MIXES лучших по итогам перебора dominance.js для ближайших оборон сетки
// (dominance-top.js, файл dominance-top.bin.gz; там — 500 млн и наши технологии у обеих сторон), дальше — соседи
// шагом 10%. Размер флота и соседей подбирает аналитическая модель боя (analytic.js, в матожиданиях) с технологиями
// этой цели; VERIFY_MIXES лучших составов перепроверяются Монте-Карло docs/battle.js (сверен с симулятором игры).
//
// node game-data/best-attack.js <input.json | '{...}'> [--ds — только флот из одних ЗС]
//                                                      [--full — стартовать со всей сетки 20%, без итогов dominance]
// {
//   "from": "8:306:4", "to": "8:297:10", "speed": 100,        // скорость флота, %
//   "attacker": { "techs": {...}, "premium": true },           // по умолчанию — из settings файла данных
//   "defender": { "techs": {...} },                            // по умолчанию — исследования из отчёта по цели
//   "defense": { "Ракетная установка": 100, "Линкор": 5 },     // оборона и флот цели; по умолчанию — из отчёта
//   "available": { "Звезда смерти": 3 }                        // сколько кораблей есть; не указанные — без ограничения
// }
// Вывод: до VERIFY_MIXES лучших составов без звёзд смерти (у каждого — лучший размер): сначала побеждающие в MIN_WIN боёв,
// затем по чистым потерям; отдельно — лучший флот из одних ЗС (в общем флоте они тормозят его скорость).
//
// Модулем (game-data/attack-study.js): sweep() / pool() — прежний перебор по выгоде с добычей (Монте-Карло),
// сразу для нескольких дистанций cfg.dists.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const os = require("os");
const B = require("../docs/battle.js");
const SK = require("../docs/core.js");
const A = require("../docs/attack.js");
const { analyze } = require("./analytic.js");
const DT = require("./dominance-top.js");

const { MILITARY, MEGA, SHORT, mixKey, share, allMixes, defenseCost, value } = A;
// Заведомо невыгодные составы — по итогам game-data/attack-study (см. excluded-mixes.json).
const EXCLUDED = new Set(require("./excluded-mixes.json").mixes);
const TOP = 10;
const MIN_WIN = 0.9;      // годится флот, побеждающий хотя бы в 90% боёв
const VERIFY_MIXES = 5;   // столько лучших составов (у каждого — VERIFY_SIZES лучших размеров) перепроверяем Монте-Карло
const VERIFY_SIZES = 2;
const VERIFY_RUNS = 100;
// Поиск: стартовые составы, затем соседи (шаг 10%) REFINE_TOP лучших — не меньше REFINE_MIN_ROUNDS раз и дальше, пока
// улучшается лучший, но не больше REFINE_ROUNDS раз.
const COARSE = 2;
const REF_MIXES = 5;    // столько стартовых составов из итогов dominance (вместо всей сетки COARSE)
const REFINE_TOP = 20;
const REFINE_MIN_ROUNDS = 3;
const REFINE_ROUNDS = 10;
// Размер флота: порог победы — с точностью PRECISION по бюджету, дальше рост ×CLIMB, пока чистые потери падают.
const PRECISION = 1.1;
const CLIMB = 1.25;
const POLISH = [1.12, 1.06];  // доводка вокруг лучшего размера
const RECYCLER = "Переработчик";

/**
 * Чистые потери флота `fleet` (в металле) на каждой дистанции ctx.dists: runs = 0 — аналитикой (матожидания),
 * иначе в среднем за runs боёв Монте-Карло. Поля как у A.evaluate (win, lost, at[].profit = −чистые потери),
 * чтобы годился A.sweep / A.best, плюс loss, debris, at[].fuel / recyclers / recFuel / net и sd — ошибка среднего МК.
 */
function evaluateLoss(ctx, fleet, runs) {
  const fuelOf = dist => value([0, 0, 1 + Math.round(Object.entries(fleet).reduce((s, [n, k]) => s + k * ctx.fuelOne(n, dist), 0))]);
  const avg = { win: 0, loss: 0, debris: 0, lost: {}, net2: 0,
    at: ctx.dists.map(dist => ({ dist, fuel: fuelOf(dist), recyclers: 0, recFuel: 0, net: 0 })) };
  const add = (att, def, win, w) => {
    let loss = 0, debris = 0, amount = 0;  // amount — металл + кристалл в обломках, штук
    const wreck = (n, dead) => {
      if (A.DEFENSE.has(n)) return;  // оборона обломков не даёт
      debris += dead * A.debrisOf(n);
      amount += dead * A.DEBRIS * (A.UNITS[n][0] + A.UNITS[n][1]);
    };
    for (const [n, k] of Object.entries(fleet)) {
      const dead = k - (att[n] || 0);
      loss += dead * A.costOf(n);
      wreck(n, dead);
      avg.lost[n] = (avg.lost[n] || 0) + dead * w;
    }
    for (const [n, k] of Object.entries(ctx.defense)) wreck(n, k - (def[n] || 0));
    avg.win += win * w; avg.loss += loss * w; avg.debris += debris * w;
    avg.at.forEach((a, d) => {
      // Переработчики летят с той же дистанции, топливо занимает их трюм; невыгодные обломки не собираем.
      const free = ctx.free(RECYCLER, a.dist), count = amount > 1e-6 && free > 0 ? Math.ceil(amount / free) : 0;
      const recFuel = count ? value([0, 0, 1 + Math.round(count * ctx.fuelOne(RECYCLER, a.dist))]) : 0;
      const collect = debris > recFuel, net = loss + a.fuel - (collect ? debris - recFuel : 0);
      a.recyclers += (collect ? count : 0) * w; a.recFuel += (collect ? recFuel : 0) * w; a.net += net * w;
      if (d === 0) avg.net2 += net * net * w;
    });
  };
  if (!runs) {
    const r = analyze(fleet, ctx.defense, ctx.A, ctx.D);
    add(r.att, r.def, r.win.att, 1);
  } else for (let i = 0; i < runs; i++) {
    const r = B.battle(fleet, ctx.defense, ctx.A, ctx.D);
    add(r.att, r.def, r.winner === "att", 1 / runs);
  }
  for (const a of avg.at) a.profit = -a.net;
  const sd = runs ? Math.sqrt(Math.max(0, avg.net2 - avg.at[0].net ** 2) / runs) : 0;
  return { ...avg, sd, fuel: avg.at[0].fuel, net: avg.at[0].net, profit: avg.at[0].profit };
}

if (!isMainThread && workerData?.attackWorker) {
  const ctx = A.context(workerData.cfg);
  const evaluate = workerData.kind === "loss" ? evaluateLoss : A.evaluate;
  parentPort.on("message", ({ id, fleets, runs }) =>
    parentPort.postMessage({ id, results: fleets.map(f => evaluate(ctx, f, runs)) }));
}

/** Составы для перебора: все, кроме EXCLUDED. */
const mixes = available => allMixes(available).filter(mix => !EXCLUDED.has(mixKey(mix)));

/** Перебор (docs/attack.js); only — перебрать только эти составы (досчёт к уже посчитанным), без «только мега». */
const sweep = (cfg, { run, log, only }) => A.sweep(cfg, { run, log, mixes: only || mixes(cfg.available), withMegas: !only });

/**
 * Пул рабочих потоков: run(флоты, боёв) → результаты в том же порядке. kind "attack" — A.evaluate (выгода с добычей),
 * "loss" — evaluateLoss (0 боёв — аналитикой). Флоты раздаются из общей очереди по одному свободному потоку:
 * бои разной цены не заставляют ждать самый медленный кусок.
 */
function pool(cfg, kind = "attack") {
  const queue = [], idle = [];
  const next = w => {
    w.task = queue.shift();
    if (w.task) w.postMessage({ id: 0, fleets: [w.task.fleet], runs: w.task.runs });
    else idle.push(w);
  };
  const workers = Array.from({ length: os.cpus().length }, () => {
    const w = new Worker(__filename, { workerData: { attackWorker: true, cfg, kind } });
    w.on("message", ({ results }) => { w.task.done(results[0]); next(w); });
    idle.push(w);
    return w;
  });
  const run = (fleets, runs) => Promise.all(fleets.map(fleet => new Promise(done => {
    queue.push({ fleet, runs, done });
    if (idle.length) next(idle.pop());
  })));
  return { run, close: () => workers.forEach(w => w.terminate()) };
}

/** Технологии, ресурсы и оборона цели: из входных данных, иначе из отчёта в файле данных. */
function targetConfig(input) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "space-kings-2026-10-20.json"), "utf8"));
  const report = data.targets.find(t => t.coords === input.to);
  const need = what => { throw new Error(`нет ${what}: укажите во входных данных или добавьте отчёт по ${input.to}`); };
  const attacker = input.attacker || { techs: { ...data.settings.techs, "Реактивный двигатель": data.settings.engines.combustion || 0 },
                                       premium: data.settings.premium };
  const defender = input.defender || (report ? { techs: Object.fromEntries(B.TECHS.map(t => [t, report.research[t] || 0])) } : need("технологий цели"));
  const resources = input.resources || (report ? report.resources : need("ресурсов цели"));
  const defense = {};
  for (const [n, k] of Object.entries(input.defense || (report ? { ...report.defense, ...report.fleet } : need("обороны цели"))))
    if (k > 0 && !SK.HARMLESS.has(n)) defense[n] = k;
  return {
    to: input.to, speed: input.speed || 100, attacker, defender, defense, available: input.available || {},
    half: SK.RESOURCES.map(r => Math.floor((resources[r] || 0) * A.LOOT)),
  };
}

async function main() {
  const arg = process.argv[2], onlyDS = process.argv.includes("--ds");
  if (!arg) { console.error("node game-data/best-attack.js <input.json | '{...}'> [--ds]"); process.exit(2); }
  const input = JSON.parse(arg.trim().startsWith("{") ? arg : fs.readFileSync(arg, "utf8"));
  if (!input.from || !input.to) throw new Error("нужны from и to");
  // Добычу не считаем: без ресурсов цели fleetFor не добавляет мега-транспорты.
  const cfg = { ...targetConfig({ ...input, resources: {} }), dists: [SK.distance(SK.parseCoords(input.from), SK.parseCoords(input.to))] };
  const workers = pool(cfg, "loss");
  console.error(`дистанция ${cfg.dists[0]}, оборона+флот цели ${Math.round(defenseCost(cfg.defense) / 1e6)} млн`);
  // ЗС слишком медленные, чтобы идти в общем флоте: составы с ними не перебираем, только ЗС — отдельно.
  const types = MILITARY.filter(n => n !== B.DS && cfg.available[n] !== 0);
  const top = onlyDS ? [] : await search(cfg, workers, starts(cfg, types, process.argv.includes("--full")), TOP, { types });
  // Для нескольких ЗС модель завышает шанс победы — проверяем Монте-Карло все размеры, что побеждают по модели.
  const ds = cfg.available[B.DS] === 0 ? [] : await search(cfg, workers, [{ [B.DS]: 1 }], 1, { verifySizes: Infinity });
  workers.close();

  if (!top.length && !onlyDS) console.log(`без ЗС ни один флот не побеждает хотя бы в ${MIN_WIN * 100}% боёв`);
  top.forEach((c, i) => print(`${i + 1}.`, c));
  if (ds.length) print("\nОтдельно, только ЗС:", ds[0]);
  else if (cfg.available[B.DS] !== 0) console.log(`\nОтдельно, только ЗС: не побеждают хотя бы в ${MIN_WIN * 100}% боёв`);
}

/**
 * Стартовые составы поиска: REF_MIXES лучших по итогам dominance (dominance-top.js) для ближайших к обороне
 * оборон сетки, только из типов `types`; без файла итогов или с full — вся сетка шагом COARSE.
 */
function starts(cfg, types, full) {
  const allowed = new Set(types);
  const c = !full && DT.candidates(cfg.defense, cfg.dists[0], REF_MIXES, mix => Object.keys(mix).every(n => allowed.has(n)));
  if (!c || !c.list.length) {
    if (!full) console.error(`нет итогов dominance (${path.basename(DT.FILE)}) — перебираю всю сетку`);
    return grid(types, COARSE);
  }
  console.error(`ближайшие обороны сетки (дистанция ${c.refs.distSystems} систем):\n` +
                c.refs.near.map(x => `  ${x.key} (L1 ${x.l1.toFixed(2)})`).join("\n"));
  console.error(`стартовые составы:\n` + c.list.map(x => `  ${x.key} (отставание ~${(x.gap * 100).toFixed(1)}%)`).join("\n"));
  return c.list.map(x => x.mix);
}

/** Составы из типов `types` с долями, кратными step десятым (в сумме 100%), кроме EXCLUDED. */
function grid(types, step) {
  const out = [];
  (function rec(i, left, acc) {
    if (i === types.length - 1) { out.push([...acc, left]); return; }
    for (let k = 0; k <= left; k += step) rec(i + 1, left - k, [...acc, k]);
  })(0, 10, []);
  return out.map(parts => Object.fromEntries(types.map((n, i) => [n, parts[i] / 10]).filter(([, v]) => v > 0)))
    .filter(mix => !EXCLUDED.has(mixKey(mix)));
}

/** Соседи состава: 10% переходит от одного типа к другому (типы из `types`), кроме EXCLUDED. */
function neighbors(mix, types) {
  const out = [];
  for (const from of Object.keys(mix)) for (const to of types) {
    if (to === from) continue;
    const m = { ...mix, [from]: Math.round(mix[from] * 10 - 1) / 10, [to]: Math.round(((mix[to] || 0) * 10) + 1) / 10 };
    if (!m[from]) delete m[from];
    const sorted = Object.fromEntries(types.filter(n => m[n]).map(n => [n, m[n]]));  // порядок как у mixKey в сетке
    if (!EXCLUDED.has(mixKey(sorted))) out.push(sorted);
  }
  return out;
}

/**
 * Подбор размера флота — шаг за шагом: sizeState(mix, budget, limit, near) — начало, sizeStep(s, f, e) — учесть флот f
 * на бюджет s.cur (null — столько кораблей нет, {} — бюджета не хватает ни на один корабль) и его оценку
 * e = { r: { win, net } } (null для null / {}), после чего s.cur — следующий бюджет, пока s.phase !== "done".
 * Сначала порог победы: бюджет ×2 или /2, пока победа (MIN_WIN) не окажется между проигрышем и победой, затем
 * делением пополам до точности PRECISION. Если порог известен примерно (near — бюджет, с которого побеждал
 * тот же состав против похожей обороны), поиск начинается с него, а шаг растёт от ×PRECISION до ×2 (квадратом),
 * если угадали плохо. После поиска s.hi — найденный порог (Infinity — не побеждает). От лучшего найденного
 * бюджет растёт ×CLIMB, пока чистые потери падают — до двух шагов без улучшения (больше флот — меньше гибнет, но больше топлива); затем доводка ÷/× POLISH
 * вокруг лучшего. s.best — лучшая побеждающая оценка, s.bestBudget — её бюджет.
 */
const sizeState = (mix, budget, limit, near) =>
  ({ mix, cur: near || budget, grow: near ? PRECISION : 2, limit, lo: 0, hi: Infinity, phase: "find", best: null });

function sizeStep(s, f, e) {
  const win = !!e && e.r.win >= MIN_WIN, better = win && (!s.best || e.r.net < s.best.r.net);
  if (better) { s.best = e; s.bestBudget = s.cur; }
  if (s.phase === "climb") {
    // Два шага подряд без улучшения или кораблей больше нет — переходим к доводке.
    s.worse = better ? 0 : s.worse + 1;
    if (f && s.worse < 2) s.cur *= CLIMB;
    else { s.phase = "polish"; s.step = POLISH[0]; s.dir = -1; s.cur = s.bestBudget / s.step; }
    return;
  }
  if (s.phase === "polish") {
    // Шаг CLIMB мог перепрыгнуть минимум: вокруг лучшего — ÷ и × на каждый шаг POLISH, пока улучшается.
    if (better) s.cur = s.bestBudget * s.step ** s.dir;
    else if (s.dir < 0) { s.dir = 1; s.cur = s.bestBudget * s.step; }
    else {
      s.step = POLISH[POLISH.indexOf(s.step) + 1];
      if (s.step) { s.dir = -1; s.cur = s.bestBudget / s.step; } else s.phase = "done";
    }
    return;
  }
  if (win) s.hi = s.cur; else s.lo = s.cur;
  if (!f && !win) s.cap = true;  // больше кораблей нет — выше не подняться
  const grow = s.grow;
  s.grow = Math.min(2, grow * grow);
  if (s.hi === Infinity) {
    if (s.cap || s.cur * grow > s.limit) s.phase = "done"; else s.cur *= grow;
  } else if (s.lo === 0) s.cur /= grow;
  else if (s.hi / s.lo > PRECISION * (1 + 1e-9)) s.cur = Math.sqrt(s.lo * s.hi);
  // Лучший по потерям побеждающий флот мог встретиться и выше порога (при удвоении) — растём от него.
  else { s.phase = "climb"; s.worse = 0; s.cur = s.bestBudget * CLIMB; }
}

/**
 * Лучший размер каждого состава из `starts` ([{ mix, budget }] — откуда начинать): sizeStep для всех составов
 * вместе, чтобы потоки были заняты. Все оценённые флоты — в `seen` (ключ флота → { fleet, mix, budget, r });
 * возвращает { mixKey → лучший побеждающий }.
 */
async function sizes(ctx, workers, starts, seen, limit) {
  const states = starts.map(({ mix, budget }) => sizeState(mix, budget, limit));
  for (let active = states; active.length; active = states.filter(s => s.phase !== "done")) {
    const fleets = active.map(s => A.fleetFor(ctx, s.cur, s.mix));
    const todo = new Map();
    fleets.forEach((f, i) => {
      const k = f && JSON.stringify(f);
      if (f && Object.keys(f).length && !seen.has(k) && !todo.has(k)) todo.set(k, { fleet: f, mix: active[i].mix, budget: active[i].cur });
    });
    const results = await workers.run([...todo.values()].map(t => t.fleet), 0);
    [...todo.entries()].forEach(([k, t], i) => seen.set(k, { ...t, r: results[i] }));
    active.forEach((s, i) => {
      const f = fleets[i];
      sizeStep(s, f, f && Object.keys(f).length ? seen.get(JSON.stringify(f)) : null);
    });
  }
  return new Map(states.filter(s => s.best).map(s => [mixKey(s.mix), s.best]));
}

/**
 * Лучшие `top` составов (у каждого — лучший размер). Аналитикой: составы `mixList`, затем, если даны `types`,
 * соседи (шаг 10%) REFINE_TOP лучших, пока лучший улучшается (REFINE_MIN_ROUNDS…REFINE_ROUNDS раз) — размер соседа ищется от бюджета родителя.
 * У VERIFY_MIXES лучших побеждающих составов verifySizes размеров перепроверяются Монте-Карло; после проверки —
 * сначала побеждающие в MIN_WIN боёв, затем по чистым потерям. c.r — итог Монте-Карло, c.model — аналитики.
 */
async function search(cfg, workers, mixList, top, { types, verifySizes = VERIFY_SIZES } = {}) {
  const t0 = Date.now(), ctx = A.context(cfg), seen = new Map();
  const defCost = defenseCost(cfg.defense), limit = Math.max(1e9, defCost * 100);
  const best = await sizes(ctx, workers, mixList.map(mix => ({ mix, budget: Math.max(1e5, defCost) })), seen, limit);
  console.error(`стартовых составов ${mixList.length}, флотов ${seen.size}`);
  const tried = new Set(mixList.map(mixKey));
  const bestNet = () => Math.min(...[...best.values()].map(e => e.r.net));
  for (let round = 0; types && round < REFINE_ROUNDS; round++) {
    const before = bestNet(), starts = [];
    for (const e of [...best.values()].sort((a, b) => a.r.net - b.r.net).slice(0, REFINE_TOP))
      for (const mix of neighbors(e.mix, types)) if (!tried.has(mixKey(mix))) { tried.add(mixKey(mix)); starts.push({ mix, budget: e.budget }); }
    if (!starts.length) break;
    for (const [k, e] of await sizes(ctx, workers, starts, seen, limit)) best.set(k, e);
    console.error(`уточнение ${round + 1}: соседей ${starts.length}, флотов всего ${seen.size}`);
    if (round + 1 >= REFINE_MIN_ROUNDS && !(bestNet() < before)) break;  // лучший перестал улучшаться
  }
  const all = [...seen.values()];
  const byMix = new Map();
  for (const c of all.filter(c => c.r.win >= MIN_WIN).sort((a, b) => a.r.net - b.r.net)) {
    const list = byMix.get(share(c.fleet)) || byMix.set(share(c.fleet), []).get(share(c.fleet));
    if (list.length < verifySizes) list.push(c);
  }
  const candidates = [...byMix.values()].slice(0, VERIFY_MIXES).flat();
  console.error(`перебор аналитикой ${((Date.now() - t0) / 1e3).toFixed(0)} с, флотов ${all.length}; ` +
                `проверяю ${candidates.length} лучших Монте-Карло по ${VERIFY_RUNS} боёв`);
  const checked = await workers.run(candidates.map(c => c.fleet), VERIFY_RUNS);
  candidates.forEach((c, i) => { c.model = c.r; c.r = checked[i]; });
  const rank = (a, b) => (b.r.win >= MIN_WIN) - (a.r.win >= MIN_WIN) || a.r.net - b.r.net;
  return [...new Map([...candidates].sort(rank).reverse().map(c => [share(c.fleet), c])).values()]
    .sort(rank).slice(0, top).map(c => ({ ...c, share: share(c.fleet) }));
}

function print(title, c) {
  const k = v => `${Math.round(v / 1e3).toLocaleString("ru")} тыс.`;
  const r = c.r, a = r.at[0];
  console.log(`\n${title} чистые потери ${k(r.net)} ±${k(r.sd)} (модель ${k(c.model.net)}) | победа ${Math.round(r.win * 100)}%` +
              ` (модель ${Math.round(c.model.win * 100)}%) | ${c.share}`);
  console.log(`   флот: ${Object.entries(c.fleet).map(([n, v]) => `${n} ${v}`).join(", ")}`);
  console.log(`   потери флота ${k(r.loss)} + топливо ${k(a.fuel)} − обломки ${k(r.debris)} + топливо переработчиков ${k(a.recFuel)}` +
              (a.recyclers ? ` (переработчиков в среднем ${a.recyclers.toFixed(1)})` : ""));
  const lost = Object.entries(r.lost).filter(([, v]) => v >= 0.05).map(([n, v]) => `${n} ${v.toFixed(1)}`);
  if (lost.length) console.log(`   гибнет в среднем: ${lost.join(", ")}`);
}

module.exports = { MILITARY, MEGA, SHORT, mixKey, share, allMixes, EXCLUDED, sweep, pool, targetConfig, defenseCost, value, evaluateLoss,
                   grid, COARSE, MIN_WIN, sizeState, sizeStep };

if (isMainThread && require.main === module) main().catch(e => { console.error("ОШИБКА: " + e.message); process.exit(1); });
