// Сверка аналитической модели боя (docs/analytic.js) с Монте-Карло docs/battle.js на целях game-data/attack-study.
//
// node game-data/analytic.js [прогонов МК]
const B = require("../docs/battle.js");
const { analyze } = require("../docs/analytic.js");

compare();

/** Сравнение с Монте-Карло: цели attack-study × составы-лидеры и чистые × размер флота. */
function compare() {
  const fs = require("fs"), path = require("path");
  const AT = require("../docs/attack.js");
  const RUNS = Number(process.argv[2]) || 200;
  const samples = fs.readFileSync(path.join(__dirname, "attack-study/samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const mixes = ["ЗС 100", "ЛинКр 100", "Бомб 10 + ЛинКр 90", "ЗС 30 + ЛинКр 70", "Кр 100", "Лк 100", "ЛИ 100", "Бомб 100"]
    .map(AT.parseMix);
  const loss = (before, after) => Object.entries(before).reduce((s, [n, k]) => s + (k - (after[n] || 0)) * AT.costOf(n), 0);
  const rows = [];
  let tA = 0, tM = 0;
  for (const s of samples) {
    const T = { A: B.types(s.attacker.techs, s.attacker.premium), D: B.types(s.defender.techs, false) };
    const dc = AT.defenseCost(s.defense);
    for (const mix of mixes) for (const x of [0.5, 1, 2, 4]) {
      const fleet = {};
      for (const [n, sh] of Object.entries(mix)) { const k = Math.floor(dc * x * sh / AT.costOf(n)); if (k > 0) fleet[n] = k; }
      if (!Object.keys(fleet).length) continue;
      let t0 = process.hrtime.bigint();
      const a = analyze(fleet, s.defense, T.A, T.D);
      tA += Number(process.hrtime.bigint() - t0); t0 = process.hrtime.bigint();
      const mc = { win: 0, attLoss: 0, defLoss: 0, attL2: 0 };
      for (let i = 0; i < RUNS; i++) {
        const r = B.battle(fleet, s.defense, T.A, T.D), l = loss(fleet, r.att);
        mc.win += r.winner === "att"; mc.attLoss += l; mc.attL2 += l * l; mc.defLoss += loss(s.defense, r.def);
      }
      tM += Number(process.hrtime.bigint() - t0);
      for (const k of ["win", "attLoss", "defLoss", "attL2"]) mc[k] /= RUNS;
      const sd = Math.sqrt(Math.max(0, mc.attL2 - mc.attLoss ** 2) / RUNS);  // ошибка среднего МК
      rows.push({ target: s.label, fleet: AT.mixKey(mix) + " ×" + x, units: Math.min(Object.values(fleet).reduce((p, q) => p + q, 0), Object.values(s.defense).reduce((p, q) => p + q, 0)),
        winA: a.win.att, winM: mc.win, lossA: loss(fleet, a.att), lossM: mc.attLoss, sd, defA: loss(s.defense, a.def), defM: mc.defLoss,
        dc: AT.defenseCost(s.defense), fc: Object.entries(fleet).reduce((p, [n, k]) => p + k * AT.costOf(n), 0) });
    }
  }
  const pct = v => (v * 100).toFixed(0).padStart(4) + "%", pct1 = v => (v * 100).toFixed(1).padStart(6) + "%";
  const mln = v => (v / 1e6).toFixed(2).padStart(8);
  console.log("цель | флот | P(победа) анал/МК | потери атакующего, млн анал/МК (±σ МК) | уничтожено обороны, млн анал/МК");
  for (const r of rows) console.log(`${r.target.slice(0, 34).padEnd(34)} ${r.fleet.padEnd(24)} ${pct(r.winA)}${pct(r.winM)} |${mln(r.lossA)}${mln(r.lossM)} ±${(r.sd / 1e6).toFixed(2)} |${mln(r.defA)}${mln(r.defM)}`);
  // Сводка: ошибка в долях стоимости флота / обороны, чтобы большие и малые бои были сравнимы.
  const err = rows.map(r => ({ win: Math.abs(r.winA - r.winM), loss: Math.abs(r.lossA - r.lossM) / r.fc, def: Math.abs(r.defA - r.defM) / r.dc,
    big: r.units >= 30 }));
  const q = (list, k, p) => { const v = list.map(e => e[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
  for (const [name, list] of [["все", err], ["у обеих сторон ≥30 юнитов", err.filter(e => e.big)], ["у кого-то <30 юнитов", err.filter(e => !e.big)]]) {
    if (!list.length) continue;
    console.log(`\n${name} (${list.length} боёв): медиана / 90% / макс`);
    console.log(`  |ΔP(победа)|                     ${["win"].flatMap(k => [0.5, 0.9, 1].map(p => pct1(q(list, k, p)))).join(" ")}`);
    console.log(`  |Δпотерь| / стоимость флота       ${[0.5, 0.9, 1].map(p => pct1(q(list, "loss", p))).join(" ")}`);
    console.log(`  |Δуничтожено| / стоимость обороны ${[0.5, 0.9, 1].map(p => pct1(q(list, "def", p))).join(" ")}`);
  }
  console.log(`\nвремя: аналитика ${(tA / 1e6).toFixed(0)} мс на ${rows.length} боёв, МК ${(tM / 1e6).toFixed(0)} мс (${RUNS} прогонов на бой)`);
}
