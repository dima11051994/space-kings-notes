// Рейтинг игроков со страницы «Статистика» (открыть её в игре заранее): проходит отрезки 1-100, 101-200, …
// и после каждой сотни сохраняет прочитанное {at, players: [{rank, name, alliance, points}]} в bot/stats-raw.json
// (прежний файл при сборе с начала → stats-raw.json.bak). Затем сопоставляет с картой bot/galaxy.json и пишет
// bot/players.json: те же игроки + status, planets [координаты], moons [координаты]. Сырой файл join не меняет.
// При сборе с начала прежний players.json остаётся в players.json.bak; после сбора свежие данные копируются
// в players-new.json, очки тех же игроков из прежнего файла — в players-old.json, а их разница —
// в points-diff.csv (ник;очки до;очки после;разница).
// Запуск: node bot/stats.js [с места, например 501] [минимум очков — стоп, как только очки ниже];
// node bot/stats.js join — только заново сопоставить с картой; node bot/stats.js diff — только пересобрать
// players-new/old.json и points-diff.csv из players.json и players.json.bak.
const fs = require("fs");
const path = require("path");
const { screen, swipe, sleep, scrollTop, loadGalaxy, chooseRange } = require("./sk.js");

const RAW = path.join(__dirname, "stats-raw.json");
const OUT = path.join(__dirname, "players.json");
const NEW = path.join(__dirname, "players-new.json");
const OLD = path.join(__dirname, "players-old.json");
const DIFF = path.join(__dirname, "points-diff.csv");
const diffOnly = process.argv[2] === "diff";
const joinOnly = process.argv[2] === "join";
const from = Number(process.argv[2]) || 1;
const minPoints = Number(process.argv[3]) || 0;   // собирать, пока очки >= minPoints (рейтинг по убыванию очков)
const saved = (() => { try { return JSON.parse(fs.readFileSync(RAW, "utf8")); } catch { return { players: [] }; } })();
if (!joinOnly && !diffOnly && from === 1) {
  if (fs.existsSync(RAW)) fs.copyFileSync(RAW, RAW + ".bak");
  if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + ".bak");
}
const byRank = new Map(saved.players.filter(p => joinOnly || diffOnly || p.rank < from).map(p => [p.rank, p]));
let at = joinOnly || diffOnly ? saved.at : Date.now();

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

/** Сравнение свежего players.json с прежним (players.json.bak): players-new/old.json и points-diff.csv. */
function diff() {
  const bakFile = OUT + ".bak";
  if (!fs.existsSync(bakFile)) throw new Error(`нет ${bakFile} — сначала полный сбор (node bot/stats.js)`);
  const prev = JSON.parse(fs.readFileSync(bakFile, "utf8"));
  const next = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const oldByName = new Map(prev.players.map(p => [p.name, p]));
  const oldPlayers = next.players.filter(p => oldByName.has(p.name))
    .map(p => { const o = oldByName.get(p.name); return { name: o.name, rank: o.rank, points: o.points }; });
  fs.copyFileSync(OUT, NEW);
  fs.writeFileSync(OLD, JSON.stringify({ at: prev.at, players: oldPlayers }, null, 1));
  const csv = ["ник;очки до;очки после;разница"];
  for (const p of next.players) {
    const before = oldByName.get(p.name)?.points;
    csv.push([p.name, before ?? "", p.points, before == null ? "" : p.points - before].join(";"));
  }
  fs.writeFileSync(DIFF, csv.join("\n") + "\n");
  console.log(`Новый рейтинг: ${next.players.length} игроков → ${NEW}`);
  console.log(`Из них в прежнем файле (${new Date(prev.at).toLocaleString("ru")}): ${oldPlayers.length} → ${OLD}`);
  console.log(`Разница очков → ${DIFF}`);
}

let stop = false;
for (let lo = joinOnly || diffOnly ? Infinity : Math.floor((from - 1) / 100) * 100 + 1; lo < Infinity; lo += 100) {
  const label = `${lo}-${lo + 99}`;
  if (!chooseRange(n => n.x1 === 444, label)) { console.log(`отрезка ${label} нет — конец`); break; }
  scrollTop();
  let stuck = 0;
  while (stuck < 2) {
    const before = byRank.size;
    for (const r of rows(screen())) {
      if (r.rank < lo || r.rank > lo + 99) continue;
      byRank.set(r.rank, r);
      if (minPoints && r.points < minPoints) stop = true;   // очки ниже порога — дальше все ещё ниже
    }
    if (stop) break;
    const got = [...byRank.keys()].filter(k => k >= lo && k <= lo + 99).length;
    if (got === 100) break;
    stuck = byRank.size === before ? stuck + 1 : 0;
    swipe(540, 1900, 540, 900, 900);
    sleep(800);
  }
  if (minPoints) for (const [k, r] of byRank) if (r.points < minPoints) byRank.delete(k);
  const got = [...byRank.keys()].filter(k => k >= lo && k <= lo + 99).length;
  saveRaw();
  console.log(`${label}: ${got}`);
  if (stop || got < 100) break;      // порог очков или последняя страница
}
if (!joinOnly && !diffOnly) {
  console.log(`Игроков: ${byRank.size} → ${RAW}`);
  join();
  diff();
} else if (joinOnly) join();
else diff();
