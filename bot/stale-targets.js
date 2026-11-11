// Цели заметок (последняя выгрузка с телефона, команда pull), которые по карте галактики больше не годятся:
// «нет планеты» — позиция пуста или там станция альянса, «активный» — у игрока нет i/I в статусе.
// Цели в непросмотренных системах не проверяются.
// Запуск: node bot/stale-targets.js [галактика] [--drop] → bot/stale-targets.txt
// --drop убирает из файла данных цели «нет планеты», если систему сканировали позже отчёта (прежний файл → .bak).
const fs = require("fs");
const path = require("path");
const { DATA, loadData, saveData, loadGalaxy } = require("./sk.js");

const args = process.argv.slice(2);
const drop = args.includes("--drop");
const only = Number(args.find(a => /^\d+$/.test(a))) || 0;
const OUT = path.join(__dirname, "stale-targets.txt");
const { systems, planets } = loadGalaxy();
const data = loadData();
const byCoords = (a, b) => { const x = a.split(":").map(Number), y = b.split(":").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

let checked = 0;
const list = [], gone = new Set();
for (const t of data.targets) {
  const [g, s] = t.coords.split(":");
  if (only && +g !== only) continue;
  const scanned = systems[`${g}:${s}`];
  if (!scanned) continue;
  checked++;
  const p = planets[t.coords];
  if (!p?.player) {
    list.push([t.coords, "нет планеты", p?.station ? "станция альянса" : ""]);
    if (scanned > t.time) gone.add(t.coords);
  } else if (!/i/i.test(p.status)) list.push([t.coords, "активный", `${p.player} (${p.status})`]);
}
list.sort(([a], [b]) => byCoords(a, b));
fs.writeFileSync(OUT, list.map(r => r.filter(Boolean).join("\t")).join("\n") + "\n");
const count = mark => list.filter(r => r[1] === mark).length;
console.log(`Целей в ${path.basename(DATA)}: ${data.targets.length}, в просмотренных системах${only ? ` галактики ${only}` : ""}: ${checked}. `
  + `Нет планеты: ${count("нет планеты")}, активные: ${count("активный")} → ${OUT}`);

if (drop && gone.size) {
  fs.copyFileSync(DATA, DATA + ".bak");
  const before = data.targets.length;
  data.targets = data.targets.filter(t => !gone.has(t.coords));
  saveData(data);
  console.log(`Убрано целей без планеты: ${before - data.targets.length}, осталось ${data.targets.length} → ${DATA} (прежний → .bak)`);
}
