// Место для новой колонии: свободная позиция (по умолчанию 15) в просмотренной системе, в пределах ±RANGE систем
// нет активных сильных игроков (S без i/I), а рядом побольше ресурсов на неактивных планетах.
// Ресурсы — по последним отчётам (SK.resourcesAt досчитывает выработку до сейчас); неактивные без отчёта считаются отдельно.
// Запуск: node bot/colony-spot.js [позиция=15] [диапазон=10] [сколько показать=15]
const SK = require("../docs/core.js");
const { loadData, loadGalaxy } = require("./sk.js");

const [POS = 15, RANGE = 10, TOP = 15] = process.argv.slice(2).map(Number);
const { systems, planets } = loadGalaxy();
const data = loadData();
const now = Date.now();
const fmt = n => (n / 1e6).toFixed(1) + " млн";
const reports = new Map(data.targets.map(t => [t.coords, t]));
const own = data.settings.planets.map(p => p.coords.split(":").map(Number));

// Сводка по каждой системе: активные сильные, неактивные планеты и ресурсы на них.
const bySystem = {};
for (const [coords, p] of Object.entries(planets)) {
  if (!p.player) continue;
  const [g, s] = coords.split(":").map(Number);
  const sys = bySystem[`${g}:${s}`] ??= { strong: [], active: 0, inactive: 0, unknown: 0, res: 0 };
  const inactive = /i/i.test(p.status);
  if (!inactive && p.status.includes("S")) sys.strong.push(`${p.player} ${coords}`);
  if (!inactive) { sys.active++; continue; }
  sys.inactive++;
  const t = reports.get(coords);
  if (t) sys.res += SK.resourcesAt(t, now).reduce((a, b) => a + b, 0);
  else sys.unknown++;
}

const spots = [];
for (const key of Object.keys(systems)) {
  const [g, s] = key.split(":").map(Number);
  const p = planets[`${key}:${POS}`];
  if (p && (p.player || p.station || p.planet)) continue;           // позиция занята
  let strong = [], active = 0, inactive = 0, unknown = 0, res = 0, scanned = 0;
  for (let d = -RANGE; d <= RANGE; d++) {
    const k = `${g}:${s + d}`;
    if (!systems[k]) continue;
    scanned++;
    const sys = bySystem[k];
    if (!sys) continue;
    strong.push(...sys.strong); active += sys.active; inactive += sys.inactive; unknown += sys.unknown; res += sys.res;
  }
  if (strong.length) continue;
  const near = own.filter(([og]) => og === g).map(([, os]) => Math.abs(os - s));
  spots.push({ coords: `${key}:${POS}`, g, s, res, active, inactive, unknown, scanned, ownDist: near.length ? Math.min(...near) : null });
}

spots.sort((a, b) => b.res - a.res);
// Соседние позиции видят почти тех же неактивных: из каждого скопления (ближе RANGE систем) — лучшая.
const best = spots.filter((x, i) => !spots.slice(0, i).some(y => y.g === x.g && Math.abs(y.s - x.s) <= RANGE));
console.log(`Свободных позиций ${POS} без активных S в ±${RANGE} систем: ${spots.length}\n`);
console.log("Лучшая в каждом скоплении:\nКоординаты   Ресурсы у неактивных  Неактивных (без отчёта)  Активных  До своей планеты");
for (const x of best.slice(0, TOP))
  console.log(`${x.coords.padEnd(12)} ${fmt(x.res).padStart(20)}  ${String(x.inactive).padStart(10)} (${x.unknown})`
    + `${"".padStart(13)}${String(x.active).padStart(8)}  ${x.ownDist === null ? "нет в галактике" : x.ownDist + " сист."}`);
