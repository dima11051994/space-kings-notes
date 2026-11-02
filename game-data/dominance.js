// Есть ли составы флота, которые хуже другого состава против любой обороны: каждый состав сетки best-attack.js
// (шаг 20%, без ЗС) против всех оборон на BUDGET с шагом 20% по всем 21 типу кораблей и обороны (купола — по одному
// в каждой). Бой — аналитикой (analytic.js), у обеих сторон наши технологии, у цели без премиума.
//
// node game-data/dominance.js defenses — один раз: список оборон в dominance/defenses.json
// node game-data/dominance.js run      — составы по одному (оборона одного состава — параллельно в потоках);
//                                        готовый состав — dominance/fleets/<номер>.bin, уже готовые пропускаются;
//                                        прогресс — в dominance/progress.log
//
// На каждую пару «состав × оборона» и каждую дистанцию DIST_SYSTEMS — лучший по чистым потерям размер флота.
// Без топлива лучшего размера нет (чем больше флот, тем меньше гибнет), поэтому размер ищется как в best-attack.js
// (порог победы MIN_WIN, рост, доводка) по чистым потерям на самой короткой дистанции — там оптимум самый большой;
// для дальних берётся лучший среди уже оценённых (их оптимум ближе к порогу победы). Чистые потери хранятся двумя
// частями: бой (потери − собранные обломки) и полёт (топливо флота + переработчиков). Строка .bin — Float32
// по COLUMNS (NaN — состав не побеждает эту оборону).
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const os = require("os");
const A = require("../docs/attack.js");
const B = require("../docs/battle.js");
const SK = require("../docs/core.js");
const BA = require("./best-attack.js");

const DIR = path.join(__dirname, "dominance");
const BUDGET = 5e8;
const DIST_SYSTEMS = [10, 50, 100, 200];
const DOMES = ["Малый щитовой купол", "Большой щитовой купол"];
const DEF_TYPES = Object.keys(B.UNITS).filter(n => !DOMES.includes(n));
const FLEET_TYPES = A.MILITARY.filter(n => n !== B.DS);
// На каждой дистанции (в металле): бой — потери − собранные обломки, полёт — топливо флота и переработчиков
// (чистые потери = бой + полёт), бюджет флота.
const COLUMNS = DIST_SYSTEMS.flatMap(n => [`battle${n}`, `flight${n}`, `budget${n}`]);
const CHUNK = 20;  // оборон в одном задании потоку

/** Технологии и дистанции: обе стороны — наши технологии, у цели без премиума. */
function settings() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "space-kings-2026-10-20.json"), "utf8"));
  const techs = { ...data.settings.techs, "Реактивный двигатель": data.settings.engines.combustion || 0 };
  // Дистанция внутри галактики: |Δсистем| × 95 + 2700 (core.js distance).
  const dists = DIST_SYSTEMS.map(n => SK.distance({ g: 1, s: 1, p: 1 }, { g: 1, s: 1 + n, p: 1 }));
  return { attacker: { techs, premium: data.settings.premium }, defender: { techs }, dists };
}

/** Все обороны: доли 21 типа шагом 20% от BUDGET (в металле) + по одному куполу каждого вида. */
function defenses() {
  const out = [];
  (function rec(i, left, acc) {
    if (i === DEF_TYPES.length - 1) { out.push([...acc, left]); return; }
    for (let k = 0; k <= left; k++) rec(i + 1, left - k, [...acc, k]);
  })(0, 5, []);
  return out.map(parts => {
    const def = {};
    parts.forEach((p, i) => { if (p) def[DEF_TYPES[i]] = Math.floor(BUDGET * p / 5 / A.costOf(DEF_TYPES[i])); });
    for (const n of DOMES) def[n] = 1;
    return def;
  });
}

/**
 * Состав `mix` против обороны: подбор размера (BA.sizeStep) по чистым потерям на первой дистанции контекста
 * (самой короткой), для остальных — лучший размер среди оценённых. Возвращает строку COLUMNS.
 */
function pair(ctx, mix) {
  const s = BA.sizeState(mix, BUDGET, BUDGET * 100), seen = new Map();
  while (s.phase !== "done") {
    const f = A.fleetFor(ctx, s.cur, mix), k = f && JSON.stringify(f);
    let e = null;
    if (f && Object.keys(f).length) {
      e = seen.get(k);
      if (!e) seen.set(k, e = { budget: s.cur, r: BA.evaluateLoss(ctx, f, 0) });
    }
    BA.sizeStep(s, f, e);
  }
  const row = new Array(COLUMNS.length).fill(NaN);
  if (!s.best) return row;
  DIST_SYSTEMS.forEach((_, d) => {
    let best = null;
    for (const e of seen.values()) if (e.r.win >= BA.MIN_WIN && (!best || e.r.at[d].net < best.r.at[d].net)) best = e;
    const a = best.r.at[d], flight = a.fuel + a.recFuel;
    row[3 * d] = a.net - flight; row[3 * d + 1] = flight; row[3 * d + 2] = best.budget;
  });
  return row;
}

if (!isMainThread) {
  const { cfg, defs } = workerData;
  const ctx = A.context({ ...cfg, defense: {} });
  parentPort.on("message", ({ mix, from, to }) => {
    const rows = [];
    for (let i = from; i < to; i++) { ctx.defense = defs[i]; rows.push(pair(ctx, mix)); }
    parentPort.postMessage({ from, rows });
  });
}

/** Все обороны для состава `mix` в потоках `workers`; onChunk(сделано) — для прогресса. */
function runFleet(workers, mix, count, onChunk) {
  const out = new Float32Array(count * COLUMNS.length);
  let next = 0, done = 0;
  return new Promise(resolve => {
    const give = w => {
      if (next >= count) return;
      const from = next, to = Math.min(count, next + CHUNK);
      next = to;
      w.postMessage({ mix, from, to });
    };
    for (const w of workers) {
      w.removeAllListeners("message");
      w.on("message", ({ from, rows }) => {
        rows.forEach((row, j) => out.set(row, (from + j) * COLUMNS.length));
        done += rows.length;
        onChunk(done);
        if (done === count) resolve(out); else give(w);
      });
      give(w);
    }
  });
}

async function main() {
  const cmd = process.argv[2];
  const defFile = path.join(DIR, "defenses.json");
  if (cmd === "defenses") {
    fs.mkdirSync(DIR, { recursive: true });
    const defs = defenses();
    fs.writeFileSync(defFile, JSON.stringify({ budget: BUDGET, types: DEF_TYPES, defenses: defs }));
    console.log(`оборон ${defs.length} → ${defFile}`);
    return;
  }
  if (cmd !== "run") { console.error("node game-data/dominance.js defenses | run"); process.exit(2); }

  const defs = JSON.parse(fs.readFileSync(defFile, "utf8")).defenses;
  const { dists, ...sides } = settings();
  const cfg = { to: "1:1:1", speed: 100, ...sides, available: {}, half: [0, 0, 0], dists };
  const mixes = BA.grid(FLEET_TYPES, BA.COARSE);
  const fleetsDir = path.join(DIR, "fleets");
  fs.mkdirSync(fleetsDir, { recursive: true });
  fs.writeFileSync(path.join(DIR, "meta.json"), JSON.stringify({
    budget: BUDGET, columns: COLUMNS, distSystems: DIST_SYSTEMS, dists, minWin: BA.MIN_WIN, defenses: defs.length,
    attacker: sides.attacker, defender: sides.defender, mixes: mixes.map(A.mixKey),
  }, null, 1));
  const log = line => { console.log(line); fs.appendFileSync(path.join(DIR, "progress.log"), `${new Date().toISOString()} ${line}\n`); };

  const workers = Array.from({ length: os.cpus().length }, () => new Worker(__filename, { workerData: { cfg, defs } })
    .on("error", e => { log(`ОШИБКА в потоке: ${e.stack}`); process.exit(1); }));
  const todo = mixes.map((mix, i) => ({ mix, i })).filter(({ i }) => !fs.existsSync(path.join(fleetsDir, `${i}.bin`)));
  log(`старт: составов ${mixes.length}, готово ${mixes.length - todo.length}, оборон ${defs.length}, потоков ${workers.length}`);
  const t0 = Date.now();
  for (const [k, { mix, i }] of todo.entries()) {
    const t = Date.now();
    let shown = 0;
    const out = await runFleet(workers, mix, defs.length, done => {
      const pct = Math.floor(done / defs.length * 10);
      if (pct > shown) { shown = pct; process.stdout.write(`  ${A.mixKey(mix)}: ${pct * 10}%\r`); }
    });
    const file = path.join(fleetsDir, `${i}.bin`);
    fs.writeFileSync(file + ".tmp", Buffer.from(out.buffer));
    fs.renameSync(file + ".tmp", file);
    let wins = 0;
    for (let j = 0; j < defs.length; j++) if (!Number.isNaN(out[j * COLUMNS.length])) wins++;
    const per = (Date.now() - t0) / (k + 1), left = todo.length - k - 1;
    log(`${mixes.length - left}/${mixes.length} ${A.mixKey(mix)}: ${((Date.now() - t) / 1e3).toFixed(0)} с, ` +
        `побеждает ${wins}/${defs.length}; осталось ~${(left * per / 3.6e6).toFixed(1)} ч`);
  }
  workers.forEach(w => w.terminate());
  log("готово");
}

module.exports = { DIR, COLUMNS, DIST_SYSTEMS, FLEET_TYPES, settings, pair };

if (isMainThread && require.main === module) main().catch(e => { console.error("ОШИБКА: " + e.stack); process.exit(1); });
