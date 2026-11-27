// Обход профилей игроков из bot/players.json: в списке «Статистика» тап по нику → профиль (навыки, разбивка
// очков Постройки/Флот/Оборона/Исследования/Общая/Победы) → тап по координатам родной планеты → система
// в галактике (через readSystem освежает статус в bot/galaxy.json) → назад → назад → следующий игрок.
// Возврат из профиля отскролливает список наверх: перед каждым игроком дропдаун отрезка перепроверяется,
// список прокручивается к нужному месту. Прогресс после каждого игрока → bot/profiles.json (можно прервать).
// Запуск: node bot/profiles.js [с места=1] [сколько=все]; node bot/profiles.js restart — начать с чистого листа.
const fs = require("fs");
const path = require("path");
const { adb, screen, tap, sleep, swipe, scrollTop, chooseRange, readSystem } = require("./sk.js");

const OUT = path.join(__dirname, "profiles.json");
const back = () => { adb("shell", "input", "keyevent", "KEYCODE_BACK"); sleep(1500); };
if (process.argv[2] === "restart") { if (fs.existsSync(OUT)) fs.unlinkSync(OUT); console.log("profiles.json удалён"); process.exit(0); }

const list = JSON.parse(fs.readFileSync(path.join(__dirname, "players.json"), "utf8")).players.sort((a, b) => a.rank - b.rank);
const from = Number(process.argv[2]) || 1;
const count = Number(process.argv[3]) || Infinity;
const saved = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return { at: Date.now(), players: [] }; } })();
const done = new Set(saved.players.map(p => p.name));
const save = () => fs.writeFileSync(OUT, JSON.stringify({ at: saved.at, players: saved.players }, null, 1));

/** Видимые строки списка: место (x1=195) → кликабельный ник рядом с ним. */
function listRows() {
  const nodes = screen();
  return nodes.filter(n => n.x1 === 195 && /^\d+$/.test(n.text) && n.y1 > 700 && n.y2 < 2190 && n.cls === "android.view.View")
    .map(n => ({ rank: +n.text,
      nick: nodes.find(x => x !== n && x.click && x.x1 >= 300 && x.x1 <= 400 && x.y1 >= n.y1 && x.y1 <= n.y1 + 90 && x.text && !x.text.includes("Написать")) }));
}

/** Прокрутить список до строки с местом rank; вернуть её (или null). */
function findRow(rank) {
  for (let i = 0; i < 60; i++) {
    const rows = listRows();
    const hit = rows.find(r => r.rank === rank && r.nick);
    if (hit) return hit;
    if (rows.length && Math.min(...rows.map(r => r.rank)) > rank) swipe(540, 900, 540, 1900, 400);  // проскочили — назад
    else swipe(540, 1900, 540, 500, 150);                                                          // рывок вниз
    sleep(900);
  }
  return null;
}

/** Тап по нику с проверкой, что открылся профиль; вернуть узлы профиля или null. */
function openProfile(nick) {
  for (let a = 0; a < 3; a++) {
    tap(nick.x, nick.y);
    sleep(2200);
    const nodes = screen();
    if (nodes.some(n => n.text === "Игровая статистика")) return nodes;
  }
  return null;
}

/** Профиль: координаты родной планеты, навыки, разбивка очков. */
function parseProfile(nodes) {
  const coords = nodes.find(n => /^\[\d+:\d+:\d+\]$/.test(n.text))?.text.slice(1, -1) || null;
  const planetName = (() => {
    const c = nodes.find(n => /^\[\d+:\d+:\d+\]$/.test(n.text));
    const row = c && nodes.find(n => n !== c && n.x1 >= 500 && n.x1 <= 545 && n.y1 < c.y1 && n.y1 >= c.y1 - 70
      && n.text && !n.text.includes("["));
    return row?.text || null;
  })();
  const num = s => +s.replace(/\./g, "");
  const cell = (label, x) => {
    const l = nodes.find(n => n.text === label && n.x1 <= 130);
    const v = l && nodes.find(n => n.x1 === x && n.y1 === l.y1);
    return v ? num(v.text) : null;
  };
  const stats = {};
  for (const label of ["Постройки", "Флот", "Оборона", "Исследования", "Общая"])
    stats[label] = { points: cell(label, 402), rank: cell(label, 675) };
  const skills = {};
  for (const label of ["Шахтерство", "Рейдерство"]) skills[label] = cell(label, 675);
  return { coords, planetName, skills, stats, wins: cell("Победы", 402) };
}

/** Открытая из профиля система g:s: освежить статус (readSystem пишет galaxy.json) и вернуть строку планеты. */
function refreshStatus(coords) {
  const [g, s, p] = coords.split(":").map(Number);
  const rows = readSystem(g, s);   // бросит ошибку, если на экране не эта система
  return rows.find(r => r.pos === p) || null;
}

/** Назад, пока не окажемся в списке статистики (виден дропдаун отрезка). */
function toList() {
  for (let i = 0; i < 4; i++) {
    if (screen().some(n => /^\d+-\d+$/.test(n.text) && n.x1 === 444)) return true;
    back();
  }
  return false;
}

let processed = 0;
for (const player of list) {
  if (player.rank < from || processed >= count) break;
  if (done.has(player.name)) continue;
  const label = `${Math.floor((player.rank - 1) / 100) * 100 + 1}-${Math.floor((player.rank - 1) / 100) * 100 + 100}`;
  const rec = { rank: player.rank, name: player.name, alliance: player.alliance, at: Date.now() };
  try {
    if (!chooseRange(n => n.x1 === 444, label)) throw new Error(`отрезка ${label} не найдена`);
    scrollTop();
    const row = findRow(player.rank);
    if (!row) throw new Error("строка не найдена на экране");
    const profile = openProfile(row.nick);
    if (!profile) throw new Error("профиль не открылся");
    Object.assign(rec, parseProfile(profile));
    if (rec.coords) {
      const c = profile.find(n => n.text === `[${rec.coords}]`);
      if (!c) throw new Error("координат нет на профиле");
      tap(c.x, c.y);
      sleep(2800);
      try {
        const r = refreshStatus(rec.coords);
        rec.status = r?.status ?? null;
        rec.galaxyPlanet = r?.planet ?? null;
      } catch (e) { rec.errorStatus = e.message; }
    }
    toList();
  } catch (e) { rec.error = e.message; toList(); }
  saved.players.push(rec);
  save();
  processed++;
  console.log(`${player.rank}. ${player.name}: ${rec.error || rec.errorStatus || "ok"}${rec.coords ? " " + rec.coords + " (" + (rec.status ?? "?") + ")" : ""}`);
}
console.log(`Готово: ${saved.players.length} профилей → ${OUT}`);
