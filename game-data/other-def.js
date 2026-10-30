// Остальные виды обороны: замены и добавки к базовому рецепту, равный бюджет.
const { simulate, battle, TYPES } = require("./sim.js");
const C = n => TYPES[n].cost;
const RU = "Ракетная установка", LL = "Легкий лазер", TL = "Тяжёлый лазер", ION = "Ионное орудие", GS = "Пушка Гаусса", PL = "Плазменное орудие", DS = "Звезда смерти";
const DOMES = { "Малый щитовой купол": 1, "Большой щитовой купол": 1 };
const byCost = (b, sh) => Object.fromEntries(Object.entries(sh).map(([n, s]) => [n, Math.floor(b * s / C(n))]).filter(([, k]) => k > 0));
const DB = 50e6;
const MIX = {
  "база: РУ 65 / Гс 17.5 / Пл 17.5": [{ [RU]: .65, [GS]: .175, [PL]: .175 }, true],
  "база без куполов": [{ [RU]: .65, [GS]: .175, [PL]: .175 }, false],
  "мясо ЛЛ 65": [{ [LL]: .65, [GS]: .175, [PL]: .175 }, true],
  "мясо РУ 40 + ЛЛ 25": [{ [RU]: .4, [LL]: .25, [GS]: .175, [PL]: .175 }, true],
  "ТЛ 15 вместо мяса": [{ [RU]: .5, [TL]: .15, [GS]: .175, [PL]: .175 }, true],
  "ТЛ 15 вместо тяжёлых": [{ [RU]: .65, [TL]: .15, [GS]: .1, [PL]: .1 }, true],
  "Ион 15 вместо мяса": [{ [RU]: .5, [ION]: .15, [GS]: .175, [PL]: .175 }, true],
  "Ион 15 вместо тяжёлых": [{ [RU]: .65, [ION]: .15, [GS]: .1, [PL]: .1 }, true],
  "только ТЛ": [{ [TL]: 1 }, true],
  "только Ион": [{ [ION]: 1 }, true],
};
const FLEETS = {
  "Линкоры": { "Линкор": 1 }, "Бомбард.": { "Бомбардировщик": 1 }, "Линк+Бомб": { "Линкор": .5, "Бомбардировщик": .5 },
  "Крейсеры": { "Крейсер": 1 }, "Рой ЛИ": { "Лёгкий истребитель": 1 }, "Уничтож.": { "Уничтожитель": 1 }, "Лин.крейс.": { "Линейный крейсер": 1 },
};
const val = (before, after) => Object.entries(before).reduce((s, [n, k]) => s + (k - (after[n] || 0)) * C(n), 0);
console.log(`оборона ${DB / 1e6} млн, флоты по ${2 * DB / 1e6} млн (ЗС — ${Math.round(2 * DB / C(DS))} шт.); ячейка: победитель и потери флота / реальные потери обороны`);
console.log("".padEnd(32) + Object.keys(FLEETS).map(f => f.padStart(10)).join("") + "  ЗС сносят");
for (const [mn, [sh, domes]] of Object.entries(MIX)) {
  const def = { ...byCost(DB, sh), ...(domes ? DOMES : {}) };
  const cells = Object.values(FLEETS).map(f => {
    const r = simulate(byCost(2 * DB, f), def, 4);
    const w = r.def >= 3 ? "О" : r.att >= 3 ? "А" : "~";
    return `${w} ${(r.attLoss / Math.max(r.defLoss, 1)).toFixed(1)}`.padStart(10);
  });
  let ds = 0; const n = Math.round(2 * DB / C(DS));
  for (let i = 0; i < 4; i++) ds += val(def, battle({ [DS]: n }, def).def) / DB;
  console.log(mn.padEnd(32) + cells.join("") + `  ${Math.round(ds / 4 * 100)}%`.padStart(9));
}
