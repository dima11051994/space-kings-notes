const { simulate, TYPES } = require("./sim.js");
const C = n => TYPES[n].cost;
const B = 20e6;
const byCost = (b, sh) => Object.fromEntries(Object.entries(sh).map(([n, s]) => [n, Math.floor(b * s / C(n))]).filter(([, k]) => k > 0));
const TARGETS = {
  "смешанный (ЛИ20 Кр20 Лк30 ЛК15 Бб15)": { "Лёгкий истребитель": .2, "Крейсер": .2, "Линкор": .3, "Линейный крейсер": .15, "Бомбардировщик": .15 },
  "линкоры": { "Линкор": 1 },
  "рой ЛИ": { "Лёгкий истребитель": 1 },
  "уничтожители": { "Уничтожитель": 1 },
};
const HUNTERS = {
  "Лёгкие истр.": { "Лёгкий истребитель": 1 },
  "Крейсеры": { "Крейсер": 1 },
  "Линкоры": { "Линкор": 1 },
  "Линейные кр.": { "Линейный крейсер": 1 },
  "Уничтожители": { "Уничтожитель": 1 },
  "ЛИ 50 + Лк 50": { "Лёгкий истребитель": .5, "Линкор": .5 },
  "Кр 30 + Лк 40 + ЛК 30": { "Крейсер": .3, "Линкор": .4, "Линейный крейсер": .3 },
  "ЛИ 30 + Лк 40 + Ун 30": { "Лёгкий истребитель": .3, "Линкор": .4, "Уничтожитель": .3 },
};
const MULT = [1, 1.5, 2, 3, 5, 10];
for (const [tn, t] of Object.entries(TARGETS)) {
  const prey = byCost(B, t);
  console.log(`\nЦель: ${tn}, ${B / 1e6} млн. Ячейка: исход и потери охотника в % его стоимости`);
  console.log("".padEnd(24) + MULT.map(m => (m + "x").padStart(8)).join(""));
  for (const [hn, h] of Object.entries(HUNTERS)) {
    console.log(hn.padEnd(24) + MULT.map(m => {
      const r = simulate(byCost(B * m, h), prey, 3);
      return `${r.att >= 2 ? "+" : r.def >= 2 ? "-" : "~"}${Math.round(r.attLoss / (B * m) * 100)}%`.padStart(8);
    }).join(""));
  }
}
