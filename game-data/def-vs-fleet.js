// Оборона одного типа против флота одного типа при равной стоимости: кто кого и во что это обошлось.
const { simulate, buy } = require("./sim.js");
const B = 10e6;
const DEF = ["Ракетная установка", "Легкий лазер", "Тяжёлый лазер", "Ионное орудие", "Пушка Гаусса", "Плазменное орудие"];
const FLEET = ["Лёгкий истребитель", "Тяжёлый истребитель", "Крейсер", "Линкор", "Бомбардировщик", "Уничтожитель", "Линейный крейсер"];
const rows = [];
for (const d of DEF) {
  const row = [d.padEnd(19)];
  for (const f of FLEET) {
    const r = simulate(buy(B, { [f]: 1 }), buy(B, { [d]: 1 }), 4);
    // отношение реальных потерь атакующего к реальным потерям обороны (с учётом 70% восстановления)
    row.push(`${(r.attLoss / Math.max(r.defLoss, 1)).toFixed(1).padStart(6)}${r.def >= 3 ? "О" : r.att >= 3 ? "А" : "-"}`);
  }
  rows.push(row.join(" "));
}
console.log("".padEnd(19), FLEET.map(f => f.slice(0, 7).padStart(7)).join(" "));
console.log(rows.join("\n"));
