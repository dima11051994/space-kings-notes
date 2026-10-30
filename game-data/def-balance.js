// Баланс обороны РУ + ЛЛ + Гаусс + Плазма (+ оба купола) против обычных флотов и звёзд смерти, при равном бюджете.
// Для каждого флота ищем самый дешёвый состав, который побеждает в ≥ 80% боёв, и его потери.
// Атакующий выберет самый выгодный для себя флот, поэтому оборону оценивает её слабое место:
//   «потери» — наименьшие потери, с которыми обычный флот сносит оборону (на 1 млн обороны; больше — лучше);
//   «ЗС» — во сколько раз флот ЗС дороже обороны, чтобы снести её (ЗС не гибнут, теряют только топливо).
// Обе стороны — с моими технологиями из файла данных, атакующий без премиума. Стоимость — металл 1 : кристалл 2 : дейтерий 4.
// node game-data/def-balance.js [бюджет обороны, млн; по умолчанию 154]
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");
const B = require("../docs/battle.js");
const A = require("../docs/attack.js");
const data = require("../space-kings-2026-10-20.json");

const RU = "Ракетная установка", LL = "Легкий лазер", GS = "Пушка Гаусса", PL = "Плазменное орудие", DS = B.DS;
const DOMES = { "Малый щитовой купол": 1, "Большой щитовой купол": 1 };
const FLEETS = {
  "Линкоры": { "Линкор": 1 }, "Бомбард.": { "Бомбардировщик": 1 }, "Линк+Бомб": { "Линкор": .5, "Бомбардировщик": .5 },
  "Крейсеры": { "Крейсер": 1 }, "Рой ЛИ": { "Лёгкий истребитель": 1 }, "Уничтож.": { "Уничтожитель": 1 },
  "Лин.крейс.": { "Линейный крейсер": 1 }, "ЗС": { [DS]: 1 },
};
const RUNS = 6, FINAL_RUNS = 12, WIN = 0.8, CAP = 40;
const T = B.types({ ...data.settings.techs, "Реактивный двигатель": data.settings.engines.combustion || 0 }, false);
const cost = army => Object.entries(army).reduce((s, [n, k]) => s + k * A.costOf(n), 0);
const buy = (budget, shares) => Object.fromEntries(Object.entries(shares)
  .map(([n, s]) => [n, Math.floor(budget * s / A.costOf(n))]).filter(([, k]) => k > 0));

function fight(fleet, def, runs) {
  let win = 0, loss = 0;
  for (let i = 0; i < runs; i++) {
    const r = B.battle(fleet, def, T, T);
    win += (r.winner === "att") / runs;
    loss += Object.entries(fleet).reduce((s, [n, k]) => s + (k - (r.att[n] || 0)) * A.costOf(n), 0) / runs;
  }
  return { win, loss };
}

/** Самый дешёвый побеждающий флот состава `shares`: его цена и потери на 1 млн обороны; Infinity — не хватит и CAP×. */
function breakCost(def, shares) {
  const dc = cost(def), wins = b => fight(buy(b, shares), def, RUNS).win >= WIN;
  let lo = dc / 8, hi = lo;
  while (!wins(hi)) { lo = hi; hi *= 1.5; if (hi > dc * CAP) return { need: Infinity, loss: Infinity }; }
  for (let i = 0; i < 5; i++) { const m = Math.sqrt(lo * hi); if (wins(m)) hi = m; else lo = m; }
  const f = buy(hi, shares);
  return { need: cost(f) / dc, loss: fight(f, def, FINAL_RUNS).loss / dc };
}

function study({ budget, mix }) {
  const def = { ...buy(budget - cost(DOMES), mix), ...DOMES };
  const res = Object.fromEntries(Object.entries(FLEETS).map(([n, f]) => [n, breakCost(def, f)]));
  return { mix, def, res };
}

if (!isMainThread) parentPort.on("message", job => parentPort.postMessage(study(job)));
else {
  const budget = (+process.argv[2] || 154) * 1e6;
  const jobs = [];
  for (const pl of [0.1, 0.175, 0.25, 0.35, 0.5])
    for (const gs of [0, 0.1, 0.175, 0.25])
      for (const ll of [0, 0.1, 0.25]) {
        const ru = +(1 - pl - gs - ll).toFixed(3);
        if (ru >= 0) jobs.push({ budget, mix: Object.fromEntries([[RU, ru], [LL, ll], [GS, gs], [PL, pl]].filter(([, v]) => v > 0)) });
      }
  const results = [];
  let next = 0;
  const workers = Array.from({ length: os.cpus().length }, () => new Worker(__filename));
  const feed = w => { if (next < jobs.length) w.postMessage(jobs[next++]); else w.terminate(); };
  workers.forEach(w => {
    w.on("message", r => { results.push(r); process.stderr.write(`\r${results.length}/${jobs.length}`); feed(w); });
    feed(w);
  });
  const done = () => {
    if (results.length < jobs.length) return setTimeout(done, 500);
    const pct = (m, n) => String(Math.round((m[n] || 0) * 1000) / 10).padStart(4);
    const regular = r => Object.entries(r.res).filter(([n]) => n !== "ЗС");
    for (const r of results) {
      const weak = regular(r).sort((a, b) => a[1].loss - b[1].loss)[0];
      r.weakName = weak[0]; r.weak = weak[1].loss; r.ds = r.res["ЗС"].need;
    }
    results.sort((a, b) => b.weak - a.weak);
    console.log(`\nбюджет ${budget / 1e6} млн; потери — у самого выгодного для атакующего флота, на 1 млн обороны; ЗС — цена флота ЗС / цена обороны`);
    console.log(" РУ%  ЛЛ%  Гс%  Пл% | потери (каким флотом) | ЗС  | " + Object.keys(FLEETS).filter(n => n !== "ЗС").map(n => n.padStart(10)).join(""));
    for (const r of results)
      console.log(`${pct(r.mix, RU)} ${pct(r.mix, LL)} ${pct(r.mix, GS)} ${pct(r.mix, PL)} | ${r.weak.toFixed(2).padStart(5)} ${r.weakName.padEnd(11)} | ${r.ds.toFixed(1).padStart(4)} | `
        + regular(r).map(([, v]) => v.loss === Infinity ? "        ∞" : `${v.loss.toFixed(2)}/${v.need.toFixed(1)}`.padStart(10)).join(""));
  };
  done();
}
