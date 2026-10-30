// Цели с добычей от MIN и защитой: сколько ЗС нужно для гарантированной победы (все RUNS боёв).
// Защита — с моими технологиями (одинаковый множитель). Добыча — 50% ресурсов сейчас, с приростом по шахтам.
// node game-data/ds-targets.js [мин. добыча, млн]
const SK = require("../docs/core.js");
const { battle, TYPES } = require("./sim.js");
const data = require("../space-kings-2026-10-20.json");
const MIN = (+process.argv[2] || 1) * 1e6, RUNS = 20, DS = "Звезда смерти";
const home = SK.parseCoords("8:306:4"), now = Date.now();

const wins = (n, side) => { for (let i = 0; i < RUNS; i++) if (battle({ [DS]: n }, side).winner !== "att") return false; return true; };
function needed(side) {
  let lo = 0, hi = 1;
  while (!wins(hi, side)) { lo = hi; hi *= 2; if (hi > 4096) return Infinity; }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; wins(m, side) ? hi = m : lo = m; }
  return hi;
}

const rows = [];
for (const r of data.targets) {
  if (r.detailsUnknown) continue;
  const side = {};
  for (const sec of [r.defense, r.fleet]) for (const [n, k] of Object.entries(sec || {})) if (!SK.HARMLESS.has(n) && k > 0) {
    if (!TYPES[n]) throw new Error("нет юнита " + n);
    side[n] = k;
  }
  if (!Object.keys(r.defense || {}).some(n => !SK.HARMLESS.has(n) && r.defense[n] > 0)) continue;
  const loot = SK.resourcesAt(r, now).reduce((s, v) => s + Math.floor(v / 2), 0);
  if (loot < MIN) continue;
  rows.push({ r, side, loot, dist: SK.distance(home, SK.parseCoords(r.coords)) });
}
rows.sort((a, b) => a.dist - b.dist);
const fmt = x => Math.round(x).toLocaleString("ru-RU");
for (const x of rows) {
  const n = needed(x.side);
  let lost = 0;
  if (isFinite(n)) for (let i = 0; i < RUNS; i++) lost += (n - (battle({ [DS]: n }, x.side).att[DS] || 0)) / RUNS;
  const ageH = (now - x.r.time) / 3.6e6;
  console.log([x.r.coords, x.r.planet, fmt(x.dist), (x.loot / 1e6).toFixed(2), n, lost.toFixed(1), ageH.toFixed(0),
    Object.entries(x.side).map(([k, v]) => `${k} ${v}`).join(", ")].join("\t"));
}
