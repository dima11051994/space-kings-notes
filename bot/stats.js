// Рейтинг игроков со страницы «Статистика» (открыть её в игре заранее): проходит отрезки 1-100, 101-200, …
// и после каждой сотни сохраняет прочитанное {at, players: [{rank, name, alliance, points}]} в bot/stats-raw.json
// (прежний файл при сборе с начала → stats-raw.json.bak). Затем сопоставляет с картой bot/galaxy.json и пишет
// bot/players.json: те же игроки + status, planets [координаты], moons [координаты]. Сырой файл join не меняет.
// Запуск: node bot/stats.js [с места, например 501]; node bot/stats.js join — только заново сопоставить с картой.
const fs = require("fs");
const path = require("path");
const { screen, swipe, sleep, scrollTop, loadGalaxy, chooseRange } = require("./sk.js");

const RAW = path.join(__dirname, "stats-raw.json");
const OUT = path.join(__dirname, "players.json");
const joinOnly = process.argv[2] === "join";
const from = Number(process.argv[2]) || 1;
const saved = (() => { try { return JSON.parse(fs.readFileSync(RAW, "utf8")); } catch { return { players: [] }; } })();
if (!joinOnly && from === 1 && fs.existsSync(RAW)) fs.copyFileSync(RAW, RAW + ".bak");
const byRank = new Map(saved.players.filter(p => joinOnly || p.rank < from).map(p => [p.rank, p]));
let at = joinOnly ? saved.at : Date.now();

const sorted = () => [...byRank.values()].sort((a, b) => a.rank - b.rank);
const write = (file, players) => fs.writeFileSync(file, JSON.stringify({ at, players }, null, 1));
const saveRaw = () => byRank.size && write(RAW, sorted());

/** Строки таблицы, видимые целиком: ячейки «Место» x1=195, «Игрок» 306, «Альянс» 567, «Очки» 759 с общим y1. */
function rows(nodes) {
  const cell = (x1, y1) => nodes.find(n => n.x1 === x1 && n.y1 === y1 && n.cls === "android.view.View")?.text || "";
  return nodes.filter(n => n.x1 === 195 && /^\d+$/.test(n.text) && n.y1 > 700 && n.y2 < 2190 && n.cls === "android.view.View")
    .map(n => ({ rank: +n.text, name: cell(306, n.y1), alliance: cell(567, n.y1), points: +cell(759, n.y1).replace(/\./g, "") }))
    .filter(r => r.name && Number.isFinite(r.points));
}


/** Планеты, луны и статус каждого игрока по карте галактики. */
function join() {
  const owned = {};
  for (const [coords, p] of Object.entries(loadGalaxy().planets)) if (p.player) (owned[p.player] ??= []).push([coords, p]);
  const byCoords = ([a], [b]) => { const x = a.split(":").map(Number), y = b.split(":").map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const players = sorted().map(raw => {
    const list = (owned[raw.name] || []).sort(byCoords);
    return { ...raw, alliance: raw.alliance || list[0]?.[1].alliance || "", status: list[0]?.[1].status ?? null,
             planets: list.map(([c]) => c), moons: list.filter(([, p]) => p.moon).map(([c]) => c) };
  });
  if (players.length) write(OUT, players);
  const names = new Set(players.map(p => p.name));
  const missing = players.filter(p => !p.planets.length).map(p => p.name);
  const unranked = Object.keys(owned).filter(n => !names.has(n));
  console.log(`Сопоставлено: ${players.length - missing.length} из ${players.length} → ${OUT}`);
  console.log(`Без планет на карте: ${missing.join(", ") || "—"}`);
  console.log(`На карте, но не в рейтинге: ${unranked.length > 20 ? unranked.length : unranked.join(", ") || "—"}`);
}

for (let lo = joinOnly ? Infinity : Math.floor((from - 1) / 100) * 100 + 1; lo < Infinity; lo += 100) {
  const label = `${lo}-${lo + 99}`;
  if (!chooseRange(n => n.x1 === 444, label)) { console.log(`отрезка ${label} нет — конец`); break; }
  scrollTop();
  let stuck = 0;
  while (stuck < 2) {
    const before = byRank.size;
    for (const r of rows(screen())) if (r.rank >= lo && r.rank <= lo + 99) byRank.set(r.rank, r);
    const got = [...byRank.keys()].filter(k => k >= lo && k <= lo + 99).length;
    if (got === 100) break;
    stuck = byRank.size === before ? stuck + 1 : 0;
    swipe(540, 1900, 540, 900, 900);
    sleep(800);
  }
  const got = [...byRank.keys()].filter(k => k >= lo && k <= lo + 99).length;
  saveRaw();
  console.log(`${label}: ${got}`);
  if (got < 100) break;                // последняя страница
}
if (!joinOnly) console.log(`Игроков: ${byRank.size} → ${RAW}`);
join();
