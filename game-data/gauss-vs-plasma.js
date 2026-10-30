// Гаусс против плазмы: смеси обороны с «мясом» из РУ при равном бюджете против флотов вдвое дороже.
const { simulate, TYPES } = require("./sim.js");
const C = n => TYPES[n].cost;
const DOMES = { "Малый щитовой купол": 1, "Большой щитовой купол": 1 };

/** Состав по пропорции штук: {тип: штук на «пачку»}, на бюджет. */
function byCount(budget, ratio) {
  const pack = Object.entries(ratio).reduce((s, [n, k]) => s + k * C(n), 0);
  const packs = Math.floor(budget / pack);
  return Object.fromEntries(Object.entries(ratio).map(([n, k]) => [n, Math.round(k * packs)]));
}
const RU = "Ракетная установка", LL = "Легкий лазер", GS = "Пушка Гаусса", PL = "Плазменное орудие";
const MIX = {
  "РУ:Плазма 200:1": { [RU]: 200, [PL]: 1 },
  "РУ:Плазма 100:1": { [RU]: 100, [PL]: 1 },
  "РУ:Плазма 50:1": { [RU]: 50, [PL]: 1 },
  "РУ:Гаусс 20:1 (как 100:1 по деньгам)": { [RU]: 20, [GS]: 1 },
  "РУ:Гаусс 10:1": { [RU]: 10, [GS]: 1 },
  "РУ:Гаусс:Плазма 100:5:1": { [RU]: 100, [GS]: 5, [PL]: 1 },
  "РУ:ЛЛ:Гаусс:Плазма 60:40:5:1": { [RU]: 60, [LL]: 40, [GS]: 5, [PL]: 1 },
};
const FLEETS = {
  "Линкоры": { "Линкор": 1 },
  "Бомбардиры": { "Бомбардировщик": 1 },
  "Линк+Бомб": { "Линкор": .5, "Бомбардировщик": .5 },
  "Уничтож.": { "Уничтожитель": 1 },
  "Лин.крейс.": { "Линейный крейсер": 1 },
  "Зв.смерти": { "Звезда смерти": 1 },
};
const buy = (b, shares) => Object.fromEntries(Object.entries(shares).map(([n, s]) => [n, Math.floor(b * s / C(n))]).filter(([, k]) => k > 0));

for (const DB of (process.argv[2] || "50e6").split(",").map(Number)) {
  console.log(`\nОборона ${DB / 1e6} млн (+купола) против флота ${2 * DB / 1e6} млн. Ячейка: победитель (О/А/~) и потери флота / реальные потери обороны`);
  console.log("".padEnd(38), Object.keys(FLEETS).map(f => f.padStart(12)).join(""));
  for (const [mn, ratio] of Object.entries(MIX)) {
    const def = { ...byCount(DB, ratio), ...DOMES };
    const cells = Object.values(FLEETS).map(f => {
      const r = simulate(buy(2 * DB, f), def, 3);
      const w = r.def >= 2 ? "О" : r.att >= 2 ? "А" : "~";
      const x = r.attLoss / Math.max(r.defLoss, 1);
      return `${w} ${x > 999 ? ">999" : x.toFixed(1)}`.padStart(12);
    });
    const pl = def[PL] ? ` (${def[PL]} плазм)` : def[GS] ? ` (${def[GS]} Гаусс)` : "";
    console.log((mn + pl).slice(0, 38).padEnd(38), cells.join(""));
  }
}
