// Самая дешёвая атака на заданную оборону: перебор составов флота (доли по стоимости) и бюджетов.
// Цена атаки = средние потери флота + топливо туда-обратно (дейтерий ×4) на опорной дистанции.
// node game-data/optimal-attack.js '<оборона JSON>'
const { battle, TYPES, buy } = require("./sim.js");
const units = require("./units.json");
const C = n => TYPES[n].cost;
const DEF = JSON.parse(process.argv[2]);
const SHIPS = ["Бомбардировщик", "Лёгкий истребитель", "Крейсер", "Линкор", "Звезда смерти"];
const yo = s => s.replace(/ё/g, "е");
const ship = n => units.ships.find(s => yo(s.name) === yo(n));
const fuelPer = n => ship(n).stats["Потребление дейтерия"].base;
const speedOf = n => ship(n).stats["Базовая скорость"].withTech;
const DIST = { "своя система": 1000 + 5 * 5, "10 систем": 10 * 95 + 2700, "50 систем": 50 * 95 + 2700, "соседняя галактика": 20000 };
// Топливо на весь флот в одну сторону при скорости 100% (formulas.md), туда-обратно ×2.
const fuel = (fleet, d) => 2 * (1 + Math.round(Object.entries(fleet).reduce((s, [n, k]) => s + k * fuelPer(n) * d / 35000 * 4, 0)));
const REF = DIST["50 систем"];
const cost = f => Object.entries(f).reduce((s, [n, k]) => s + k * C(n), 0);

function evalFleet(fleet, runs) {
  let wins = 0, loss = 0; const lost = {};
  for (let i = 0; i < runs; i++) {
    const r = battle(fleet, DEF);
    if (r.winner === "att") wins++;
    for (const [n, k] of Object.entries(fleet)) { const d = k - (r.att[n] || 0); lost[n] = (lost[n] || 0) + d / runs; loss += d * C(n) / runs; }
  }
  return { fleet, wins: wins / runs, loss, lost, price: loss + 4 * fuel(fleet, REF) };
}

// Доли по стоимости шагом 20% по 5 типам.
const shares = [];
(function rec(i, left, acc) {
  if (i === SHIPS.length - 1) { shares.push({ ...acc, [SHIPS[i]]: left / 5 }); return; }
  for (let k = 0; k <= left; k++) rec(i + 1, left - k, { ...acc, [SHIPS[i]]: k / 5 });
})(0, 5, {});
const BUDGETS = [100, 150, 200, 250, 300, 400, 500, 700, 1000].map(x => x * 1e6);

const found = [];
for (const sh of shares) {
  const mix = Object.fromEntries(Object.entries(sh).filter(([, v]) => v > 0));
  for (const b of BUDGETS) {
    const r = evalFleet(buy(b, mix), 4);
    if (r.wins === 1) { found.push({ mix, b, ...r }); }
  }
}
found.sort((a, b) => a.price - b.price);
// Уточняем лучшие: соседние доли шагом 10% и бюджеты ±, 20 прогонов, победа ≥ 95%.
const best = new Map();
for (const f of found.slice(0, 12)) {
  for (const db of [0.8, 0.9, 1, 1.1, 1.25]) {
    const r = evalFleet(buy(f.b * db, f.mix), 20);
    if (r.wins >= 0.95) best.set(JSON.stringify(r.fleet), { mix: f.mix, b: f.b * db, ...r });
  }
}
const top = [...best.values()].sort((a, b) => a.price - b.price);
const label = m => Object.entries(m).map(([n, v]) => `${n} ${Math.round(v * 100)}%`).join(" + ");
const seen = new Set(), out = [];
for (const t of top) { const k = label(t.mix); if (!seen.has(k)) { seen.add(k); out.push(t); } }
// Плюс по одному лучшему варианту для чистых составов — для сравнения.
console.log(JSON.stringify({ defCost: cost(DEF), top: out.slice(0, 8).map(t => ({
  mix: label(t.mix), fleet: t.fleet, cost: cost(t.fleet), wins: t.wins, loss: t.loss, lost: t.lost,
  speed: Math.min(...Object.keys(t.fleet).map(speedOf)),
  fuel: Object.fromEntries(Object.entries(DIST).map(([k, d]) => [k, fuel(t.fleet, d)])),
})) }, null, 1));
