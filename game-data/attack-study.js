// Какие составы флота всегда проигрывают: перебор best-attack.js по 10 разным оборонам из отчётов,
// каждый бой считается один раз, добыча / топливо / выгода — для дистанций в 10, 30, 50, 100 и 200 систем.
// node game-data/attack-study.js — пишет game-data/attack-study/<цель>.jsonl, по строке на оценённый флот;
// уже посчитанные цели пропускает (удалите файл, чтобы пересчитать).
// node game-data/attack-study.js --excluded — досчитать к уже посчитанным целям составы из excluded-mixes.json,
// которых в их файлах нет (дописывает в конец файла).
const fs = require("fs");
const path = require("path");
const BA = require("./best-attack.js");

// Разные по виду и силе обороны (отчёты в файле данных, 2026-10-23); третий элемент — данные цели вместо отчёта.
const SAMPLES = [
  ["9:265:4", "мало: ракеты и лёгкие лазеры, 0.2 млн"],
  ["6:230:12", "мало, смешанная лёгкая, 0.4 млн"],
  ["7:374:9", "ионные орудия, 1.4 млн"],
  ["5:78:9", "немного обороны и флот (большие транспорты), 2.2 млн"],
  ["7:499:5", "Гаусс и ионы, 3.7 млн"],
  ["4:311:7", "масса лёгких лазеров, 4.1 млн"],
  ["4:274:6", "масса ракетных установок, 4.9 млн"],
  ["9:231:12", "смешанная, лазеры + Гаусс + плазма, 18.6 млн"],
  ["2:215:5", "только плазма, 20.5 млн"],
  ["7:362:6", "очень много, всё вперемешку, 43 млн"],
  // С флотом: в отчётах таких почти нет (4:400:5 и 2:52:7 — с обороной в 11–37 тыс. юнитов, считать часами),
  // поэтому составлены вручную; технологии — как у 4:400:5 (оружие/щиты/броня 14), ресурсы одинаковые.
  ...[
    ["флот-лёгкий", "только флот: ЛИ и ТИ", { "Лёгкий истребитель": 400, "Тяжёлый истребитель": 100 }],
    ["флот-средний", "только флот: крейсеры и линкоры", { "Крейсер": 150, "Линкор": 60 }],
    ["флот-тяжёлый", "только флот: линкоры, линейные крейсеры, уничтожители, бомбардировщики",
      { "Линкор": 150, "Линейный крейсер": 60, "Уничтожитель": 20, "Бомбардировщик": 20 }],
    ["флот+оборона", "крейсеры и линкоры + смешанная оборона",
      { "Крейсер": 80, "Линкор": 30, "Ракетная установка": 600, "Легкий лазер": 300, "Тяжёлый лазер": 80, "Пушка Гаусса": 20 }],
    ["флот-зс+оборона", "2 ЗС и линкоры + Гаусс, плазма, купола",
      { "Звезда смерти": 2, "Линкор": 50, "Пушка Гаусса": 30, "Плазменное орудие": 10, "Малый щитовой купол": 1, "Большой щитовой купол": 1 }],
  ].map(([to, label, defense]) => [to, label, { defense, resources: { "Металл": 2e6, "Кристалл": 1e6, "Дейтерий": 5e5 },
    defender: { techs: { "Оружейная технология": 14, "Щитовая технология": 14, "Броня космических кораблей": 14, "Лазерная технология": 16,
      "Ионная технология": 13, "Плазменная технология": 10, "Энергетическая технология": 13, "Гравитационная технология": 0, "Реактивный двигатель": 13 } } }]),
];
const SYSTEMS = [10, 30, 50, 100, 200];
// Дистанция внутри галактики (docs/core.js): |Δ систем| × 95 + 2700.
const DISTS = SYSTEMS.map(n => n * 95 + 2700);
const OUT = path.join(__dirname, "attack-study");

/** Составы, уже записанные в файл цели. */
async function mixesIn(file) {
  const keys = new Set();
  for await (const line of require("readline").createInterface({ input: fs.createReadStream(file) }))
    if (line) keys.add(BA.mixKey(JSON.parse(line).mix));
  return keys;
}

const record = (to, c) => JSON.stringify({
  target: to, mix: c.mix, budget: Math.round(c.budget), fleet: c.fleet,
  win: c.r.win, loss: Math.round(c.r.loss), debris: Math.round(c.r.debris),
  lost: Object.fromEntries(Object.entries(c.r.lost).map(([n, v]) => [n, +v.toFixed(2)])),
  at: c.r.at.map((a, i) => ({ systems: SYSTEMS[i], dist: a.dist, loot: Math.round(a.loot), fuel: a.fuel, profit: Math.round(a.profit) })),
});

async function addExcluded() {
  for (const [to, label, given] of SAMPLES) {
    const file = path.join(OUT, `${to.replace(/:/g, "-")}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const have = await mixesIn(file);
    const only = BA.allMixes({}).filter(m => BA.EXCLUDED.has(BA.mixKey(m)) && !have.has(BA.mixKey(m)));
    if (!only.length) { console.error(`${to}: исключённые составы уже есть`); continue; }
    const cfg = { ...BA.targetConfig({ to, ...given }), dists: DISTS };
    const started = Date.now();
    console.error(`${to} (${label}): досчитываю ${only.length} исключённых составов`);
    const workers = BA.pool(cfg);
    const all = await BA.sweep(cfg, { run: workers.run, log: m => console.error("  " + m), only });
    workers.close();
    fs.appendFileSync(file, all.map(c => record(to, c)).join("\n") + "\n");
    console.error(`${to}: досчитано флотов ${all.length}, ${((Date.now() - started) / 6e4).toFixed(1)} мин`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.argv.includes("--excluded")) return addExcluded();
  for (const [to, label, given] of SAMPLES) {
    const file = path.join(OUT, `${to.replace(/:/g, "-")}.jsonl`);
    if (fs.existsSync(file)) { console.error(`${to}: уже посчитано`); continue; }
    const cfg = { ...BA.targetConfig({ to, ...given }), dists: DISTS };
    const started = Date.now();
    console.error(`${to} (${label}): оборона ${Math.round(BA.defenseCost(cfg.defense) / 1e6)} млн, добыча до ${Math.round(BA.value(cfg.half) / 1e3)} тыс.`);
    const workers = BA.pool(cfg);
    const all = await BA.sweep(cfg, { run: workers.run, log: m => console.error("  " + m) });
    workers.close();
    const lines = all.map(c => record(to, c));
    // Сначала во временный файл: оборванный расчёт не оставит половину результатов.
    fs.writeFileSync(file + ".tmp", lines.join("\n") + "\n");
    fs.renameSync(file + ".tmp", file);
    fs.appendFileSync(path.join(OUT, "samples.jsonl"), JSON.stringify({ target: to, label, defense: cfg.defense,
      defenseCost: BA.defenseCost(cfg.defense), half: cfg.half, defender: cfg.defender, attacker: cfg.attacker,
      systems: SYSTEMS, dists: DISTS, fleets: lines.length, minutes: +((Date.now() - started) / 6e4).toFixed(1) }) + "\n");
    console.error(`${to}: флотов ${lines.length}, ${((Date.now() - started) / 6e4).toFixed(1)} мин`);
  }
}

main().catch(e => { console.error("ОШИБКА: " + e.stack); process.exit(1); });
