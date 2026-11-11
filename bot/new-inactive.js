// Неактивные игроки с карты галактики, которых нет среди целей заметок (последняя выгрузка с телефона, команда pull).
// Запуск: node bot/new-inactive.js [галактика] → bot/new-inactive.txt, по строке на планету: координаты, игрок, статус.
const fs = require("fs");
const path = require("path");
const { DATA, loadData, loadGalaxy } = require("./sk.js");

const only = process.argv[2] && Number(process.argv[2]);
const OUT = path.join(__dirname, "new-inactive.txt");
const { planets } = loadGalaxy();
const data = loadData();
const known = new Set(data.targets.map(t => t.coords));
const mine = new Set(data.settings.planets.map(p => p.coords));
const byCoords = (a, b) => { const x = a.split(":").map(Number), y = b.split(":").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

const list = Object.entries(planets)
  .filter(([c, p]) => p.player && /i/i.test(p.status) && !known.has(c) && !mine.has(c))  // неактивный: в статусе i или I
  .filter(([c]) => !only || +c.split(":")[0] === only)
  .sort(([a], [b]) => byCoords(a, b));
fs.writeFileSync(OUT, list.map(([c, p]) => `${c}\t${p.player}\t${p.status}${p.moon ? "\tлуна" : ""}`).join("\n") + "\n");
console.log(`Целей в ${path.basename(DATA)}: ${known.size}. Новых неактивных${only ? ` в галактике ${only}` : ""}: ${list.length} → ${OUT}`);
