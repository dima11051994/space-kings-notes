const { battle, TYPES } = require("./sim.js");
const C = n => TYPES[n].cost;
const RU = "Ракетная установка", GS = "Пушка Гаусса", PL = "Плазменное орудие", DS = "Звезда смерти";
const DOMES = { "Малый щитовой купол": 1, "Большой щитовой купол": 1 };
const byCost = (b, sh) => Object.fromEntries(Object.entries(sh).map(([n, s]) => [n, Math.floor(b * s / C(n))]));
const DB = 100e6;
const MIX = {
  "РУ:Плазма 100:1": { [RU]: .43, [PL]: .57 },
  "РУ:Гаусс (43% РУ)": { [RU]: .43, [GS]: .57 },
  "РУ 43% Гаусс 28% Плазма 28%": { [RU]: .43, [GS]: .285, [PL]: .285 },
  "только РУ": { [RU]: 1 },
};
const val = (before, after) => Object.entries(before).reduce((s, [n, k]) => s + (k - (after[n] || 0)) * C(n), 0);
console.log(`оборона ${DB / 1e6} млн + купола против N звёзд смерти (1 ЗС = ${C(DS) / 1e6} млн); 5 прогонов`);
for (const [mn, sh] of Object.entries(MIX)) {
  const def = { ...byCost(DB, sh), ...DOMES };
  const row = [];
  for (const n of [2, 5, 10, 20]) {
    let dsLost = 0, defPct = 0, wins = 0;
    for (let i = 0; i < 5; i++) {
      const r = battle({ [DS]: n }, def);
      dsLost += n - (r.att[DS] || 0);
      defPct += val(def, r.def) / (DB + 180000);
      if (r.winner === "att") wins++;
    }
    row.push(`${n} ЗС: теряет ${(dsLost / 5).toFixed(1)}, сносит ${Math.round(defPct / 5 * 100)}%${wins ? `, побед ${wins}/5` : ""}`);
  }
  console.log(mn.padEnd(30), row.join(" | "));
}
