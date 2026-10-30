// Сверка своего симулятора со встроенным в игру на наборе боёв.
const { run } = require("./game-sim.js");
const { battle, TYPES } = require("./sim.js");
const { withLock } = require("../bot/sk.js");

// Потери «в единицах», как в отчёте игры: сумма металла, кристалла и дейтерия; оборона — после восстановления 70%.
const units = require("./units.json");
const raw = {};
for (const u of [...units.ships, ...units.defense]) raw[u.name] = Object.values(u.cost).reduce((a, b) => a + b, 0);
const lost = (before, after, defense) => Object.entries(before).reduce((s, [n, k]) =>
  s + (k - (after[n] || 0)) * raw[n] * (TYPES[n].kind === "defense" ? 0.3 : 1), 0);

const CASES = [
  [{ "Бомбардировщик": 100 }, { "Ракетная установка": 1000, "Легкий лазер": 500 }],
  [{ "Крейсер": 300 }, { "Лёгкий истребитель": 2000 }],
  [{ "Линкор": 100 }, { "Крейсер": 300 }],
  [{ "Звезда смерти": 1 }, { "Ракетная установка": 3000 }],
  [{ "Линкор": 200 }, { "Пушка Гаусса": 30, "Ракетная установка": 1000 }],
  [{ "Уничтожитель": 50 }, { "Линейный крейсер": 100 }],
  [{ "Линкор": 300 }, { "Плазменное орудие": 10, "Ракетная установка": 1000 }],
  [{ "Лёгкий истребитель": 3000 }, { "Пушка Гаусса": 50 }],
];
const gameName = n => n.replace("Легкий лазер", "Лёгкий лазер");
withLock(() => {
  for (const [att, def] of CASES) {
    const g = run(att, Object.fromEntries(Object.entries(def).map(([n, v]) => [gameName(n), v])));
    const runs = 20; let a = 0, d = 0; const w = { att: 0, def: 0, draw: 0 };
    for (let i = 0; i < runs; i++) { const r = battle(att, def); a += lost(att, r.att); d += lost(def, r.def); w[r.winner]++; }
    console.log(JSON.stringify(att), "vs", JSON.stringify(def));
    console.log(`  игра:  ${g.winner}, раундов ${g.rounds}, потери атаки ${g.attLoss.toLocaleString("ru")}, обороны ${g.defLoss.toLocaleString("ru")}`);
    console.log(`  мой:   ${JSON.stringify(w)}, потери атаки ${Math.round(a / runs).toLocaleString("ru")}, обороны ${Math.round(d / runs).toLocaleString("ru")}`);
  }
});
