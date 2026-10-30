// Упрощённый симулятор боя Space Kings по правилам из battle-system.txt и юнитам из units.json.
// Обе стороны — с технологиями владельца данных (значения «в скобках» на карточках).
// Стоимость — в металле по курсу 1 металл : 2 кристалла... т.е. кристалл = 2, дейтерий = 4 металла.
const units = require("./units.json");

const PRICE = { "Металл": 1, "Кристалл": 2, "Дейтерий": 4 };
const NOT_COMBAT = new Set(["Ракета-перехватчик", "Межпланетная ракета"]);

const stat = (u, k) => { const s = u.stats[k]; return typeof s === "object" ? (s.withTech ?? s.base) : 0; };
const TYPES = {};
for (const [kind, list] of [["ship", units.ships], ["defense", units.defense]]) {
  for (const u of list) {
    if (NOT_COMBAT.has(u.name)) continue;
    TYPES[u.name] = {
      name: u.name, kind,
      attack: stat(u, "Нападение"), shield: stat(u, "Сила щитов"),
      hull: stat(u, "Структура") / 10,  // броня — 10% структуры
      cost: Object.entries(u.cost).reduce((s, [r, v]) => s + v * PRICE[r], 0),
      mc: (u.cost["Металл"] || 0) + (u.cost["Кристалл"] || 0),
      rf: u.rapidfire.against,
      speed: stat(u, "Базовая скорость"), cargo: stat(u, "Грузоподъемность"), fuel: u.stats["Потребление дейтерия"]?.base ?? 0,
    };
  }
}

function army(spec) {
  const list = [];
  for (const [name, n] of Object.entries(spec)) {
    const t = TYPES[name];
    if (!t) throw new Error("нет юнита " + name);
    for (let i = 0; i < n; i++) list.push({ t, hull: t.hull, shield: t.shield });
  }
  return list;
}

function fire(shooter, targets) {
  let target;
  do {
    target = targets[(Math.random() * targets.length) | 0];
    const dmg = shooter.t.attack;
    const max = target.t.shield;
    if (target.hull > 0) {
      if (max > 0 && dmg < max / 100) { /* отскок */ }
      else if (dmg <= target.shield) {
        const cell = max / 100;
        target.shield -= Math.floor(dmg / cell) * cell;
      } else {
        target.hull -= dmg - target.shield;
        target.shield = 0;
        const left = target.hull / target.t.hull;
        if (target.hull > 0 && left < 0.7 && Math.random() < 1 - left) target.hull = 0;
      }
    }
    const r = shooter.t.rf[target.t.name];
    if (!r || Math.random() >= (r - 1) / r) break;
  } while (true);
}

/** Один бой: возвращает уцелевших с обеих сторон и победителя. */
function battle(attSpec, defSpec) {
  let A = army(attSpec), D = army(defSpec);
  let rounds = 0;
  for (; rounds < 6 && A.length && D.length; rounds++) {
    for (const u of A) fire(u, D);
    for (const u of D) fire(u, A);
    A = A.filter(u => u.hull > 0); D = D.filter(u => u.hull > 0);
    for (const u of A) u.shield = u.t.shield;
    for (const u of D) u.shield = u.t.shield;
  }
  const count = list => list.reduce((m, u) => (m[u.t.name] = (m[u.t.name] || 0) + 1, m), {});
  return { att: count(A), def: count(D), winner: !D.length && A.length ? "att" : !A.length && D.length ? "def" : "draw" };
}

const costOf = spec => Object.entries(spec).reduce((s, [n, k]) => s + TYPES[n].cost * k, 0);

/** Потери в металле. Оборона восстанавливается на 70%, поэтому её реальные потери — 30% уничтоженного. */
function losses(before, after) {
  let raw = 0, real = 0, debris = 0;
  for (const [n, k] of Object.entries(before)) {
    const lost = k - (after[n] || 0), t = TYPES[n];
    raw += lost * t.cost;
    real += lost * t.cost * (t.kind === "defense" ? 0.3 : 1);
    if (t.kind === "ship") debris += lost * t.mc * 0.3;  // обломки — 30% металла и кристалла кораблей (как в OGame; в FAQ не описано)
  }
  return { raw, real, debris };
}

function simulate(att, def, runs = 10) {
  const agg = { attLoss: 0, defLoss: 0, defLossRaw: 0, debris: 0, att: 0, def: 0, draw: 0 };
  for (let i = 0; i < runs; i++) {
    const r = battle(att, def);
    const a = losses(att, r.att), d = losses(def, r.def);
    agg.attLoss += a.real; agg.defLoss += d.real; agg.defLossRaw += d.raw; agg.debris += a.debris + d.debris;
    agg[r.winner]++;
  }
  for (const k of ["attLoss", "defLoss", "defLossRaw", "debris"]) agg[k] /= runs;
  return agg;
}

/** Состав на бюджет: {тип: доля бюджета}. */
function buy(budget, shares) {
  const spec = {};
  for (const [n, share] of Object.entries(shares)) {
    const k = Math.floor(budget * share / TYPES[n].cost);
    if (k > 0) spec[n] = k;
  }
  return spec;
}

module.exports = { TYPES, battle, simulate, buy, costOf };
