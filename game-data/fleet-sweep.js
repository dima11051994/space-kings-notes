// Флот против обороны: составы × перевес (1…50x). Ячейка: исход и потери флота в % от его стоимости.
const { simulate, TYPES } = require("./sim.js");
const C = n => TYPES[n].cost;
const DB = 20e6;
const byCount = (b, ratio) => { const pack = Object.entries(ratio).reduce((s, [n, k]) => s + k * C(n), 0); const p = b / pack;
  return Object.fromEntries(Object.entries(ratio).map(([n, k]) => [n, Math.round(k * p)]).filter(([, k]) => k > 0)); };
const byCost = (b, sh) => Object.fromEntries(Object.entries(sh).map(([n, s]) => [n, Math.floor(b * s / C(n))]).filter(([, k]) => k > 0));
const DOMES = { "Малый щитовой купол": 1, "Большой щитовой купол": 1 };
const DEFS = {
  "рекомендованная (300 РУ : 150 ЛЛ : 5 Гс : 1 Пл)": { ...byCount(DB, { "Ракетная установка": 308.6, "Легкий лазер": 154.3, "Пушка Гаусса": 4.66, "Плазменное орудие": 1 }), ...DOMES },
  "популярная (100 РУ : 1 Пл)": { ...byCount(DB, { "Ракетная установка": 100, "Плазменное орудие": 1 }), ...DOMES },
};
const FLEETS = {
  "Бомбардировщики": { "Бомбардировщик": 1 },
  "Линкоры": { "Линкор": 1 },
  "Крейсеры": { "Крейсер": 1 },
  "Уничтожители": { "Уничтожитель": 1 },
  "Линейные крейсеры": { "Линейный крейсер": 1 },
  "Звёзды смерти": { "Звезда смерти": 1 },
  "Бомб 70 + Линк 30": { "Бомбардировщик": .7, "Линкор": .3 },
  "Бомб 50 + Крейс 50": { "Бомбардировщик": .5, "Крейсер": .5 },
  "Бомб 50 + ЛИ 50": { "Бомбардировщик": .5, "Лёгкий истребитель": .5 },
  "Линк 50 + Крейс 50": { "Линкор": .5, "Крейсер": .5 },
  "ЗС 50 + Бомб 50": { "Звезда смерти": .5, "Бомбардировщик": .5 },
  "ЗС 50 + ЛИ 50": { "Звезда смерти": .5, "Лёгкий истребитель": .5 },
};
const MULT = [1, 2, 3, 5, 10, 20, 50];
for (const [dn, def] of Object.entries(DEFS)) {
  console.log(`\nОборона ${DB / 1e6} млн: ${dn}. Ячейка: + победа / ~ ничья / - поражение, потери флота в % стоимости`);
  console.log("".padEnd(20) + MULT.map(m => (m + "x").padStart(9)).join(""));
  for (const [fn, f] of Object.entries(FLEETS)) {
    const cells = MULT.map(m => {
      const att = byCost(DB * m, f);
      if (!Object.keys(att).length) return "—".padStart(9);
      const r = simulate(att, def, 3);
      const w = r.att >= 2 ? "+" : r.def >= 2 ? "-" : "~";
      return `${w}${Math.round(r.attLoss / (DB * m) * 100)}%`.padStart(9);
    });
    console.log(fn.padEnd(20) + cells.join(""));
  }
}
