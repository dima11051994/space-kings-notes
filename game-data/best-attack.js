// Самая выгодная атака на заданную цель: перебор составов военного флота (доли по стоимости шагом 10%)
// и его размера; мега-транспорты добираются под вывоз добычи.
// Выгода = добыча + обломки (30% металла и кристалла погибших кораблей обеих сторон) − потери − топливо,
// всё в металле по курсу металл 1 : кристалл 2 : дейтерий 4. Бой — docs/battle.js (сверен с симулятором игры).
//
// node game-data/best-attack.js <input.json | '{...}'>
// {
//   "from": "8:306:4", "to": "8:297:10", "speed": 100,        // скорость флота, %
//   "attacker": { "techs": {...}, "premium": true },           // по умолчанию — из settings файла данных
//   "defender": { "techs": {...} },                            // по умолчанию — исследования из отчёта по цели
//   "resources": { "Металл": 0, "Кристалл": 0, "Дейтерий": 0 }, // по умолчанию — из отчёта
//   "defense": { "Ракетная установка": 100, "Линкор": 5 },     // оборона и флот цели; по умолчанию — из отчёта
//   "available": { "Звезда смерти": 3, "Мега-транспорт": 200 }  // сколько кораблей есть; не указанные — без ограничения
// }
// Вывод: 10 лучших составов (у каждого — самый выгодный размер), от большей выгоды к меньшей.
//
// Модулем (game-data/attack-study.js): sweep() считает каждый бой один раз, а добычу, топливо и выгоду —
// сразу для нескольких дистанций cfg.dists.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const os = require("os");
const B = require("../docs/battle.js");
const SK = require("../docs/core.js");
const A = require("../docs/attack.js");

const { MILITARY, MEGA, SHORT, mixKey, share, allMixes, defenseCost, value } = A;
// Заведомо невыгодные составы — по итогам game-data/attack-study (см. excluded-mixes.json).
const EXCLUDED = new Set(require("./excluded-mixes.json").mixes);
const TOP = 10;

if (!isMainThread && workerData?.attackWorker) {
  const ctx = A.context(workerData.cfg);
  parentPort.on("message", ({ id, fleets, runs }) =>
    parentPort.postMessage({ id, results: fleets.map(f => A.evaluate(ctx, f, runs)) }));
}

/** Составы для перебора: все, кроме EXCLUDED. */
const mixes = available => allMixes(available).filter(mix => !EXCLUDED.has(mixKey(mix)));

/** Перебор (docs/attack.js); only — перебрать только эти составы (досчёт к уже посчитанным), без «только мега». */
const sweep = (cfg, { run, log, only }) => A.sweep(cfg, { run, log, mixes: only || mixes(cfg.available), withMegas: !only });

/** Пул рабочих потоков: run(флоты, боёв) → результаты evaluate в том же порядке. */
function pool(cfg) {
  const workers = Array.from({ length: os.cpus().length }, () => new Worker(__filename, { workerData: { attackWorker: true, cfg } }));
  let nextId = 0;
  const run = (fleets, runs) => {
    const chunk = Math.ceil(fleets.length / workers.length);
    return Promise.all(workers.map((w, i) => new Promise(resolve => {
      const part = fleets.slice(i * chunk, (i + 1) * chunk), id = nextId++;
      if (!part.length) return resolve([]);
      const on = msg => { if (msg.id === id) { w.off("message", on); resolve(msg.results); } };
      w.on("message", on);
      w.postMessage({ id, fleets: part, runs });
    }))).then(parts => parts.flat());
  };
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
  const arg = process.argv[2];
  if (!arg) { console.error("node game-data/best-attack.js <input.json | '{...}'>"); process.exit(2); }
  const input = JSON.parse(arg.trim().startsWith("{") ? arg : fs.readFileSync(arg, "utf8"));
  if (!input.from || !input.to) throw new Error("нужны from и to");
  const cfg = { ...targetConfig(input), dists: [SK.distance(SK.parseCoords(input.from), SK.parseCoords(input.to))] };
  const workers = pool(cfg);
  console.error(`дистанция ${cfg.dists[0]}, добыча до ${Math.round(value(cfg.half) / 1e3)} тыс. (в металле), оборона+флот цели ${Math.round(defenseCost(cfg.defense) / 1e6)} млн`);
  const best = await A.best(cfg, { run: workers.run, mixes: mixes(cfg.available), top: TOP, log: m => console.error(m) });
  workers.close();

  const k = v => `${Math.round(v / 1e3).toLocaleString("ru")} тыс.`;
  best.forEach((c, i) => {
    const r = c.r;
    console.log(`\n${i + 1}. выгода ${k(r.profit)} | победа ${Math.round(r.win * 100)}% | ${c.share}`);
    console.log(`   флот: ${Object.entries(c.fleet).map(([n, v]) => `${n} ${v}`).join(", ")}`);
    console.log(`   добыча ${k(r.loot)} + обломки ${k(r.debris)} − потери ${k(r.loss)} − топливо ${k(r.fuel)}`);
    const lost = Object.entries(r.lost).filter(([, v]) => v >= 0.05).map(([n, v]) => `${n} ${v.toFixed(1)}`);
    if (lost.length) console.log(`   гибнет в среднем: ${lost.join(", ")}`);
  });
}

module.exports = { MILITARY, MEGA, SHORT, mixKey, share, allMixes, EXCLUDED, sweep, pool, targetConfig, defenseCost, value };

if (isMainThread && require.main === module) main().catch(e => { console.error("ОШИБКА: " + e.message); process.exit(1); });
