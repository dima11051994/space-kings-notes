// Оборона РУ + Гаусс + Плазма против звёзд смерти: 100 плазм, доли бюджета по стоимости (металл 1 : кристалл 2 : дейтерий 4).
// Обе стороны — с моими технологиями из файла данных, у атакующего без премиума; щитовых куполов нет.
// Для каждой доли: сколько ЗС нужно, чтобы снести оборону во всех боях, сколько ЗС при этом гибнет
// и сколько стоит снос в ЗС на 1 млн обороны (больше — оборона держит лучше).
// node game-data/def-vs-ds.js
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");
const B = require("../docs/battle.js");
const A = require("../docs/attack.js");
const data = require("../space-kings-2026-10-20.json");

const RU = "Ракетная установка", GS = "Пушка Гаусса", PL = "Плазменное орудие", DS = B.DS;
const PLASMAS = 100, RUNS = 20;
const techs = { ...data.settings.techs, "Реактивный двигатель": data.settings.engines.combustion || 0 };
const T = B.types(techs, false);

/** Оборона на 100 плазм по долям бюджета плазмы и Гаусса, остальное — РУ. */
function defense(pl, gs) {
  const budget = PLASMAS * A.costOf(PL) / pl;
  return { budget, def: { [RU]: Math.max(0, Math.floor(budget * (1 - pl - gs) / A.costOf(RU) + 1e-6)), [GS]: Math.floor(budget * gs / A.costOf(GS)), [PL]: PLASMAS } };
}

function study([pl, gs]) {
  const { budget, def } = defense(pl, gs);
  for (const k of Object.keys(def)) if (!def[k]) delete def[k];
  const n = B.deathStars(def, T, T, { runs: RUNS, margin: 0 });
  // При минимальном и двойном числе ЗС: сколько их гибнет и какая доля обороны (по стоимости) сносится, если не хватило.
  const at = k => {
    let lost = 0, win = 0, killed = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = B.battle({ [DS]: k }, def, T, T);
      lost += (k - (r.att[DS] || 0)) / RUNS; win += (r.winner === "att") / RUNS;
      killed += Object.entries(def).reduce((s, [u, c]) => s + (c - (r.def[u] || 0)) * A.costOf(u), 0) / budget / RUNS;
    }
    return { lost, win, killed };
  };
  return { pl, gs, budget, def, n, need: n * A.costOf(DS) / budget, atN: at(n), below: at(Math.max(1, n - 1)) };
}

if (!isMainThread) parentPort.postMessage(workerData.map(study));
else {
  const grid = [];
  for (const pl of [0.1, 0.15, 0.175, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9, 1])
    for (const gs of [0, 0.1, 0.175, 0.25, 0.3, 0.4, 0.5]) if (pl + gs <= 1.0001) grid.push([pl, gs]);
  const cpus = os.cpus().length, parts = Array.from({ length: cpus }, (_, i) => grid.filter((_, j) => j % cpus === i));
  Promise.all(parts.map(p => new Promise((res, rej) => { const w = new Worker(__filename, { workerData: p }); w.on("message", res); w.on("error", rej); })))
    .then(rs => {
      const rows = rs.flat().sort((a, b) => b.need - a.need);
      const pct = v => (v * 100).toFixed(1).replace(/\.0$/, "").padStart(4);
      console.log("Пл%  Гс%  РУ%  бюджет  РУ     Гаусс  | ЗС нужно  ЗС/обор.  гибнет ЗС | при n−1: побед, снесено");
      for (const r of rows) console.log(`${pct(r.pl)} ${pct(r.gs)} ${pct(1 - r.pl - r.gs)}  ${(r.budget / 1e6).toFixed(0).padStart(4)} млн ${String(r.def[RU] || 0).padStart(6)} ${String(r.def[GS] || 0).padStart(5)}  | ${String(r.n).padStart(5)}   ${r.need.toFixed(2).padStart(6)}    ${r.atN.lost.toFixed(1).padStart(5)}    | ${pct(r.below.win)}%  ${pct(r.below.killed)}%`);
    });
}
