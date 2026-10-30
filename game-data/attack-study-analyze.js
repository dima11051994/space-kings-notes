// Разбор game-data/attack-study: у каждого заданного состава (доли шагом 10%) берём лучший размер флота
// на каждой цели и дистанции, ранжируем составы внутри каждой из 50 комбинаций «цель × дистанция»
// и ищем те, что всегда внизу. node game-data/attack-study-analyze.js [доля низа, по умолчанию 0.5]
// Пишет game-data/attack-study/summary.json и печатает сводку.
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const DIR = path.join(__dirname, "attack-study");
const BOTTOM = Number(process.argv[2]) || 0.5;  // «внизу» — в нижней доле рейтинга
const { SHORT, mixKey } = require("./best-attack.js");

async function readBest(file) {
  // Лучшая выгода каждого состава на каждой дистанции (по всем размерам флота).
  const best = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line) continue;
    const e = JSON.parse(line), key = mixKey(e.mix);
    const b = best.get(key) || best.set(key, e.at.map(() => ({ profit: -Infinity }))).get(key);
    e.at.forEach((a, i) => { if (a.profit > b[i].profit) b[i] = { profit: a.profit, win: e.win, budget: e.budget }; });
  }
  return best;
}

async function main() {
  const samples = fs.readFileSync(path.join(DIR, "samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const stats = new Map();  // состав → { ranks: [процентиль 0 — лучший … 1 — худший], bottom, top }
  const cases = [];
  for (const s of samples) {
    const best = await readBest(path.join(DIR, `${s.target.replace(/:/g, "-")}.jsonl`));
    s.systems.forEach((systems, d) => {
      const list = [...best.entries()].filter(([k]) => k !== "только мега").sort((a, b) => b[1][d].profit - a[1][d].profit);
      const n = list.length;
      cases.push({ target: s.target, label: s.label, systems, mixes: n,
        best: list.slice(0, 3).map(([k, v]) => ({ mix: k, profit: Math.round(v[d].profit) })),
        worst: list.slice(-3).map(([k, v]) => ({ mix: k, profit: Math.round(v[d].profit) })) });
      list.forEach(([k], i) => {
        const st = stats.get(k) || stats.set(k, { ranks: [], bottom: 0, top: 0 }).get(k);
        const p = n > 1 ? i / (n - 1) : 0;
        st.ranks.push(p);
        if (p >= 1 - BOTTOM) st.bottom++;
        if (p <= 0.1) st.top++;
      });
    });
  }
  const total = cases.length;
  const rows = [...stats.entries()].map(([mix, st]) => ({ mix, cases: st.ranks.length,
    best: Math.min(...st.ranks), median: st.ranks.sort((a, b) => a - b)[st.ranks.length >> 1], bottom: st.bottom, top: st.top }));
  // Средняя медиана места по доле каждого типа: где тип начинает тянуть состав вниз.
  const byShare = {};
  for (const r of rows) {
    const parts = Object.fromEntries(r.mix.split(" + ").map(p => { const [t, v] = p.split(" "); return [t, +v]; }));
    for (const t of Object.values(SHORT)) {
      const v = parts[t] || 0, cell = (byShare[t] ||= {})[v] ||= { n: 0, sum: 0 };
      cell.n++; cell.sum += r.median;
    }
  }
  for (const t of Object.keys(byShare)) for (const v of Object.keys(byShare[t])) byShare[t][v] = +(byShare[t][v].sum / byShare[t][v].n).toFixed(3);
  // Всегда внизу: ни разу не поднялся выше нижней доли BOTTOM.
  const alwaysBottom = rows.filter(r => r.cases === total && r.best >= 1 - BOTTOM).sort((a, b) => b.best - a.best);
  const neverTop = rows.filter(r => r.top === 0).length;

  // Какие типы кораблей чаще в «всегда внизу», чем во всех составах.
  const typeShare = list => {
    const c = {};
    for (const r of list) for (const part of r.mix.split(" + ")) { const t = part.split(" ")[0]; c[t] = (c[t] || 0) + 1; }
    return Object.fromEntries(Object.entries(c).map(([t, v]) => [t, +(v / list.length).toFixed(3)]));
  };

  const summary = { bottomShare: BOTTOM, cases: total, mixes: rows.length, alwaysBottom: alwaysBottom.length, neverTop10pct: neverTop,
    typesInAll: typeShare(rows), typesInAlwaysBottom: typeShare(alwaysBottom),
    alwaysBottomMixes: alwaysBottom.map(r => ({ mix: r.mix, bestPercentile: +r.best.toFixed(3), medianPercentile: +r.median.toFixed(3) })),
    leaders: rows.sort((a, b) => b.top - a.top).slice(0, 30).map(r => ({ mix: r.mix, top10pct: r.top, medianPercentile: +r.median.toFixed(3) })),
    medianByShare: byShare,
    mixesStats: rows.map(r => ({ mix: r.mix, best: +r.best.toFixed(3), median: +r.median.toFixed(3), top10pct: r.top, bottomCount: r.bottom })),
    cases: cases };
  fs.writeFileSync(path.join(DIR, "summary.json"), JSON.stringify(summary, null, 1));

  console.log(`комбинаций цель × дистанция: ${total}, составов: ${rows.length}`);
  console.log(`всегда в нижних ${BOTTOM * 100}%: ${alwaysBottom.length}; ни разу не в верхних 10%: ${neverTop}`);
  console.log("доля составов с типом — во всех / во «всегда внизу»:");
  for (const t of Object.values(SHORT)) console.log(`  ${t.padEnd(6)} ${(summary.typesInAll[t] || 0).toFixed(2)} / ${(summary.typesInAlwaysBottom[t] || 0).toFixed(2)}`);
  console.log("средняя медиана места (0 — лучший, 1 — худший) по доле типа 0…100%:");
  for (const t of Object.values(SHORT)) console.log(`  ${t.padEnd(6)} ${[0,10,20,30,40,50,60,70,80,90,100].map(v => (byShare[t][v] ?? "-").toString().padStart(5)).join(" ")}`);
  console.log("лидеры (сколько раз в верхних 10% из " + total + "):");
  for (const r of summary.leaders.slice(0, 15)) console.log(`  ${String(r.top10pct).padStart(2)}  медиана ${r.medianPercentile}  ${r.mix}`);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
