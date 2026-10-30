// Сетка пропорций обороны: доля РУ по стоимости × деление остатка между Гауссом и плазмой.
const { simulate, battle, TYPES } = require("./sim.js");
const C = n => TYPES[n].cost;
const RU = "Ракетная установка", GS = "Пушка Гаусса", PL = "Плазменное орудие", DS = "Звезда смерти";
const DOMES = { "Малый щитовой купол": 1, "Большой щитовой купол": 1 };
const byCost = (b, sh) => Object.fromEntries(Object.entries(sh).map(([n, s]) => [n, Math.floor(b * s / C(n))]).filter(([, k]) => k > 0));
const DB = +(process.argv[2] || 50e6);
const FLEETS = {
  "Линкоры": { "Линкор": 1 }, "Бомбардиры": { "Бомбардировщик": 1 }, "Линк+Бомб": { "Линкор": .5, "Бомбардировщик": .5 },
  "Уничтож.": { "Уничтожитель": 1 }, "Лин.крейс.": { "Линейный крейсер": 1 },
};
const val = (before, after) => Object.entries(before).reduce((s, [n, k]) => s + (k - (after[n] || 0)) * C(n), 0);
console.log(`оборона ${DB / 1e6} млн + купола; флоты по ${2 * DB / 1e6} млн; ЗС — ${Math.round(2 * DB / C(DS))} шт. на те же деньги`);
console.log("РУ%  Гаусс:Плазма  РУ на 1 тяж. | " + Object.keys(FLEETS).map(f => f.padStart(11)).join("") + "   ЗС: сносят/теряют");
for (const ru of [.2, .35, .5, .65, .8]) {
  for (const g of [0, .25, .5, .75, 1]) {
    const heavy = 1 - ru;
    const def = { ...byCost(DB, { [RU]: ru, [GS]: heavy * g, [PL]: heavy * (1 - g) }), ...DOMES };
    const cells = Object.values(FLEETS).map(f => {
      const att = Object.fromEntries(Object.entries(f).map(([n, s]) => [n, Math.floor(2 * DB * s / C(n))]));
      const r = simulate(att, def, 3);
      const w = r.def >= 2 ? "О" : r.att >= 2 ? "А" : "~";
      return `${w} ${(r.attLoss / Math.max(r.defLoss, 1)).toFixed(1)}`.padStart(11);
    });
    let dsPct = 0, dsLost = 0; const nDS = Math.round(2 * DB / C(DS));
    for (let i = 0; i < 3; i++) { const r = battle({ [DS]: nDS }, def); dsPct += val(def, r.def) / DB; dsLost += nDS - (r.att[DS] || 0); }
    const heavyCount = (def[GS] || 0) + (def[PL] || 0);
    console.log(`${String(ru * 100).padStart(3)}%  ${String(g * 100).padStart(5)}:${String((1 - g) * 100).padEnd(5)}  ${String(Math.round(def[RU] / Math.max(heavyCount, 1))).padStart(8)}     | ${cells.join("")}   ${Math.round(dsPct / 3 * 100)}% / ${(dsLost / 3).toFixed(1)}`);
  }
}
