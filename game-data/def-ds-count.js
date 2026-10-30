const B = require("../docs/battle.js");
const A = require("../docs/attack.js");
const data = require("../space-kings-2026-10-20.json");
const techs = { ...data.settings.techs, "Реактивный двигатель": data.settings.engines.combustion || 0 };
const def = { "Ракетная установка": 700000, "Легкий лазер": 86000, "Плазменное орудие": 2000, "Малый щитовой купол": 1, "Большой щитовой купол": 1 };
for (const k of Object.keys(def)) if (!B.UNITS[k]) throw new Error(k);
const dc = Object.entries(def).reduce((s, [u, c]) => s + c * A.costOf(u), 0);
console.log("оборона", (dc / 1e9).toFixed(2), "млрд, ЗС", A.costOf(B.DS) / 1e6, "млн");
const D = B.types(techs, false);
for (const prem of [true, false]) {
  const T = B.types(techs, prem), t0 = Date.now();
  const n = B.deathStars(def, T, D, { runs: 10, margin: 0 });
  let lost = 0, win = 0; const R = 10;
  for (let i = 0; i < R; i++) { const r = B.battle({ [B.DS]: n }, def, T, D); lost += (n - (r.att[B.DS] || 0)) / R; win += (r.winner === "att") / R; }
  let win1 = 0; for (let i = 0; i < R; i++) win1 += (B.battle({ [B.DS]: n - 1 }, def, T, D).winner === "att") / R;
  console.log(prem ? "премиум" : "без премиума", "ЗС:", n, "стоимость", (n * A.costOf(B.DS) / 1e9).toFixed(2), "млрд, x обороны", (n * A.costOf(B.DS) / dc).toFixed(1), "гибнет", lost.toFixed(1), "n-1 побед", win1, (Date.now() - t0) / 1000 + "s");
}
