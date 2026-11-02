// Разбор game-data/dominance: какие составы можно выкинуть из перебора best-attack.js. Работает и на частичных
// результатах — по уже посчитанным составам.
//
// node game-data/dominance-analyze.js [допуск, % бюджета обороны; по умолчанию 0.1]
//
// Чистые потери пары «состав × оборона» на дистанции = бой + полёт (NaN — не побеждает — считается бесконечными).
// Состав A бьёт состав B на дистанции, если против КАЖДОЙ обороны потери A не больше потерь B + допуск
// (допуск покрывает шаг подбора размера). Выкинуть можно B, которого кто-то бьёт; если A и B бьют друг друга
// (равны в пределах допуска), оставляем того, у кого меньше средние потери. Ещё считаем, против скольких оборон
// состав лучший (в пределах допуска) — у кого ноль, тот никогда не нужен.
// Пишет game-data/dominance/analysis.json и печатает сводку.
const fs = require("fs");
const path = require("path");
const { DIR } = require("./dominance.js");

const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8"));
const TOL = (Number(process.argv[2]) || 0.1) / 100 * meta.budget;
const C = meta.columns.length, D = meta.defenses, DISTS = meta.distSystems;

/** Посчитанные составы: { i, key, net: [Float32Array(D) на каждую дистанцию], mean: [на каждую дистанцию] }. */
function load() {
  const out = [];
  meta.mixes.forEach((key, i) => {
    const file = path.join(DIR, "fleets", `${i}.bin`);
    if (!fs.existsSync(file)) return;
    const buf = fs.readFileSync(file), row = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const net = DISTS.map((_, d) => {
      const a = new Float32Array(D);
      for (let j = 0; j < D; j++) {
        const v = row[j * C + 3 * d] + row[j * C + 3 * d + 1];
        a[j] = Number.isNaN(v) ? Infinity : v;
      }
      return a;
    });
    // Среднее — по обороне, которую побеждают все посчитанные, считаем позже; здесь — по побеждённым.
    out.push({ i, key, net });
  });
  return out;
}

/** a не хуже b (в пределах TOL) против каждой обороны на дистанциях `ds`. */
function beats(a, b, ds) {
  for (const d of ds) {
    const x = a.net[d], y = b.net[d];
    for (let j = 0; j < D; j++) if (x[j] > y[j] + TOL) return false;
  }
  return true;
}

function main() {
  const fleets = load();
  if (fleets.length < 2) { console.log(`посчитано составов: ${fleets.length} — сравнивать не с чем`); return; }
  // Средние потери по оборонам, которые побеждают все посчитанные составы (иначе среднее бесконечно).
  const common = [];
  for (let j = 0; j < D; j++) if (fleets.every(f => f.net.every(a => a[j] !== Infinity))) common.push(j);
  for (const f of fleets) f.mean = f.net.map(a => common.reduce((s, j) => s + a[j], 0) / (common.length || 1));
  const meanAll = f => f.mean.reduce((a, b) => a + b, 0) / f.mean.length;

  // Наборы дистанций: каждая отдельно и все сразу.
  const sets = [...DISTS.map((n, d) => ({ name: `${n} систем`, ds: [d] })), { name: "все дистанции", ds: DISTS.map((_, d) => d) }];
  const result = { tolerance: TOL, fleets: fleets.length, of: meta.mixes.length, sets: [] };
  for (const { name, ds } of sets) {
    const mean = f => ds.reduce((s, d) => s + f.mean[d], 0) / ds.length;
    const dominated = [];
    for (const b of fleets) {
      let by = null;
      for (const a of fleets) {
        if (a === b || !beats(a, b, ds)) continue;
        // Равные в пределах допуска: выкидываем того, у кого среднее больше (при равенстве — с большим номером).
        if (beats(b, a, ds) && (mean(b) < mean(a) || (mean(b) === mean(a) && b.i < a.i))) continue;
        if (!by || mean(a) < mean(by)) by = a;
      }
      if (by) dominated.push({ key: b.key, by: by.key, mean: mean(b), byMean: mean(by) });
    }
    // Против скольких оборон состав лучший (в пределах допуска) хотя бы на одной дистанции набора.
    const bestCount = new Map(fleets.map(f => [f.key, 0]));
    for (let j = 0; j < D; j++) {
      const near = new Set();
      for (const d of ds) {
        let min = Infinity;
        for (const f of fleets) if (f.net[d][j] < min) min = f.net[d][j];
        if (min !== Infinity) for (const f of fleets) if (f.net[d][j] <= min + TOL) near.add(f.key);
      }
      for (const k of near) bestCount.set(k, bestCount.get(k) + 1);
    }
    const never = [...bestCount].filter(([, c]) => !c).map(([k]) => k);
    result.sets.push({ name, dominated, never, bestCount: Object.fromEntries(bestCount) });
  }
  fs.writeFileSync(path.join(DIR, "analysis.json"), JSON.stringify(result, null, 1));

  const m = v => (v / 1e6).toFixed(1);
  console.log(`посчитано составов ${fleets.length} из ${meta.mixes.length}, допуск ${m(TOL)} млн, ` +
              `оборон, которые побеждают все: ${common.length} из ${D}`);
  for (const s of result.sets)
    console.log(`  ${s.name.padEnd(14)} бьют другие: ${String(s.dominated.length).padStart(3)} | ни разу не лучший: ${String(s.never.length).padStart(3)}`);
  const all = result.sets.at(-1);
  console.log(`\nНа всех дистанциях сразу хуже другого состава (${all.dominated.length}) — состав ← кто бьёт, средние чистые потери, млн:`);
  for (const x of all.dominated.sort((a, b) => a.mean - b.mean)) console.log(`  ${x.key.padEnd(36)} ← ${x.by.padEnd(36)} ${m(x.mean)} vs ${m(x.byMean)}`);
  const top = Object.entries(all.bestCount).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log(`\nЧаще всех лучший (оборон, где лучший хотя бы на одной дистанции):`);
  for (const [k, c] of top) console.log(`  ${k.padEnd(36)} ${c}`);
}

main();
