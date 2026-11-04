// Самый дешёвый флот против заданной обороны — подбор docs/cheapest.js (тот же, что на странице) в потоках Node.
// Добыча не учитывается; чистые потери, справочник dominance и проверка Монте-Карло — см. docs/cheapest.js.
//
// node game-data/best-attack.js <input.json | '{...}'> [--ds — только флот из одних ЗС]
//                                                      [--full — стартовать со всей сетки 20%, без справочника dominance]
//                                                      [--mc — Монте-Карло для 5 лучших составов, не только лучшего]
// {
//   "from": "8:306:4", "to": "8:297:10", "speed": 100,        // скорость флота, %
//   "attacker": { "techs": {...}, "premium": true },           // по умолчанию — из settings файла данных
//   "defender": { "techs": {...} },                            // по умолчанию — исследования из отчёта по цели
//   "defense": { "Ракетная установка": 100, "Линкор": 5 },     // оборона и флот цели; по умолчанию — из отчёта
//   "available": { "Звезда смерти": 3 }                        // сколько кораблей есть; не указанные — без ограничения
// }
// Вывод: 10 лучших составов без звёзд смерти (у каждого — лучший размер): сначала побеждающие в 90% боёв,
// затем по чистым потерям; отдельно — лучший флот из одних ЗС (в общем флоте они тормозят его скорость).
//
// Модулем (game-data/attack-study.js, dominance.js): sweep() / pool() — прежний перебор по выгоде с добычей
// (Монте-Карло), сразу для нескольких дистанций cfg.dists; подбор размера и сетка составов — из docs/cheapest.js.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const os = require("os");
const B = require("../docs/battle.js");
const SK = require("../docs/core.js");
const A = require("../docs/attack.js");
const C = require("../docs/cheapest.js");
const DT = require("./dominance-top.js");

const { MILITARY, MEGA, SHORT, mixKey, share, allMixes, defenseCost, value } = A;
const { evaluateLoss, COARSE, MIN_WIN, sizeState, sizeStep } = C;
// Заведомо невыгодные составы — по итогам game-data/attack-study (см. docs/excluded-mixes.json).
const EXCLUDED = new Set(require("../docs/excluded-mixes.json").mixes);

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

/** Составы из типов `types` с долями, кратными step десятым (в сумме 100%), кроме EXCLUDED. */
const grid = (types, step) => C.grid(types, step, EXCLUDED);

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
  return { run, size: workers.length, close: () => workers.forEach(w => w.terminate()) };
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
  const arg = process.argv[2], flag = f => process.argv.includes(f);
  if (!arg) { console.error("node game-data/best-attack.js <input.json | '{...}'> [--ds] [--full] [--mc]"); process.exit(2); }
  const input = JSON.parse(arg.trim().startsWith("{") ? arg : fs.readFileSync(arg, "utf8"));
  if (!input.from || !input.to) throw new Error("нужны from и to");
  // Добычу не считаем: без ресурсов цели fleetFor не добавляет мега-транспорты.
  const cfg = { ...targetConfig({ ...input, resources: {} }), dists: [SK.distance(SK.parseCoords(input.from), SK.parseCoords(input.to))] };
  const workers = pool(cfg, "loss");
  console.error(`дистанция ${cfg.dists[0]}, оборона+флот цели ${Math.round(defenseCost(cfg.defense) / 1e6)} млн`);
  const env = { ...workers, excluded: EXCLUDED, table: DT.load(), log: text => console.error(text) };
  const { top, ds } = await C.best(cfg, env, { onlyDS: flag("--ds"), full: flag("--full"), mc: flag("--mc") });
  workers.close();

  if (!top.length && !flag("--ds")) console.log(`без ЗС ни один флот не побеждает хотя бы в ${MIN_WIN * 100}% боёв`);
  top.forEach((c, i) => print(`${i + 1}.`, c));
  if (ds) print("\nОтдельно, только ЗС:", ds);
  else if (cfg.available[B.DS] !== 0) console.log(`\nОтдельно, только ЗС: не побеждают хотя бы в ${MIN_WIN * 100}% боёв`);
}

function print(title, c) {
  const k = v => `${Math.round(v / 1e3).toLocaleString("ru")} тыс.`;
  const r = c.r, a = r.at[0];
  console.log(c.verified
    ? `\n${title} чистые потери ${k(r.net)} ±${k(r.sd)} (модель ${k(c.model.net)}) | победа ${Math.round(r.win * 100)}%` +
      ` (модель ${Math.round(c.model.win * 100)}%) | ${c.share}`
    : `\n${title} чистые потери ${k(r.net)} | победа ${Math.round(r.win * 100)}% (по модели, без Монте-Карло) | ${c.share}`);
  console.log(`   флот: ${Object.entries(c.fleet).map(([n, v]) => `${n} ${v}`).join(", ")}`);
  console.log(`   потери флота ${k(r.loss)} + топливо ${k(a.fuel)} − обломки ${k(r.debris)} + топливо переработчиков ${k(a.recFuel)}` +
              (a.recyclers ? ` (переработчиков в среднем ${a.recyclers.toFixed(1)})` : ""));
  const lost = Object.entries(r.lost).filter(([, v]) => v >= 0.05).map(([n, v]) => `${n} ${v.toFixed(1)}`);
  if (lost.length) console.log(`   гибнет в среднем: ${lost.join(", ")}`);
}

module.exports = { MILITARY, MEGA, SHORT, mixKey, share, allMixes, EXCLUDED, sweep, pool, targetConfig, defenseCost, value, evaluateLoss,
                   grid, COARSE, MIN_WIN, sizeState, sizeStep };

if (isMainThread && require.main === module) main().catch(e => { console.error("ОШИБКА: " + e.message); process.exit(1); });
