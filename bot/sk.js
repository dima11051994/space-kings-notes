// Управление приложением Space Kings на телефоне через adb. Запуск: node bot/sk.js <команда> [аргументы]
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const SK = require("../docs/core.js");

const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA,
  "Microsoft/WinGet/Packages/Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe/platform-tools/adb.exe");
// Данные заметок: самый свежий space-kings-ГГГГ-ММ-ДД.json в корне (команда pull кладёт туда выгрузку с телефона).
const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, fs.readdirSync(ROOT).filter(f => /^space-kings-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().pop()
  || "space-kings-data.json");
const LOCK = path.join(__dirname, ".lock");
const EXPEDITION_TARGET = [8, 323, 16];
const EXPEDITION_FROM = "8:323:15";  // VRNville

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- adb ----

let serial;
function adb(...args) {
  if (!serial) {
    const lines = execFileSync(ADB, ["devices"], { encoding: "utf8" }).split(/\r?\n/).slice(1);
    serial = lines.map(l => l.split("\t")).find(([s, st]) => st === "device" && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s))?.[0]
      || lines.map(l => l.split("\t")).find(([, st]) => st === "device")?.[0];
    if (!serial) throw new Error("телефон не подключён (adb devices пуст)");
  }
  return execFileSync(ADB, ["-s", serial, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
}
/** Скриншот экрана (PNG). */
function screencap() {
  adb("get-state");  // выбирает телефон
  return execFileSync(ADB, ["-s", serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 });
}
const tap = (x, y) => adb("shell", "input", "tap", String(x), String(y));
const swipe = (x1, y1, x2, y2, ms = 400) => adb("shell", "input", "swipe", ...[x1, y1, x2, y2, ms].map(String));

// ---- экран ----

const unescape = s => s.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** Все узлы экрана с текстом: {text, x, y, x1, y1, x2, y2, cls, click}. */
function screen() {
  adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = adb("exec-out", "cat", "/sdcard/ui.xml");
  const nodes = [];
  // Текст с двойными кавычками uiautomator пишет в одинарных: text='… "…" …'.
  const attr = name => `${name}=(?:"([^"]*)"|'([^']*)')`;
  const NODE = new RegExp(`<node [^>]*?${attr("text")}[^>]*?class="([^"]*)"[^>]*?${attr("content-desc")}[^>]*?clickable="(\\w+)"[^>]*?bounds="\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]"`, "g");
  for (const m of xml.matchAll(NODE)) {
    const [, t1, t2, cls, d1, d2, click, x1, y1, x2, y2] = m;
    const text = t1 ?? t2, desc = d1 ?? d2;
    const t = unescape(text || desc).trim();
    nodes.push({ text: t, cls, click: click === "true", x1: +x1, y1: +y1, x2: +x2, y2: +y2,
                 x: (+x1 + +x2) >> 1, y: (+y1 + +y2) >> 1 });
  }
  return nodes;
}

const VISIBLE = n => n.y > 380 && n.y < 2190 && n.y2 > n.y1;

/** Узел с точным текстом (видимый); n — какой по счёту. */
function find(nodes, text, n = 0) {
  return nodes.filter(v => v.text === text && VISIBLE(v))[n];
}

/** Нажать на текст, при необходимости прокручивая страницу вниз. */
function tapText(text, { n = 0, scrolls = 4, wait = 1500 } = {}) {
  for (let i = 0; i <= scrolls; i++) {
    const node = find(screen(), text, n);
    if (node) { tap(node.x, node.y); sleep(wait); return node; }
    swipe(540, 1800, 540, 900);
    sleep(700);
  }
  throw new Error(`не нашёл на экране «${text}»`);
}

/**
 * Убрать клавиатуру нажатием на пустой фон слева от панели игры (x=50, выше клавиатуры).
 * Не через надписи: названия кораблей — ссылки (Флагман уводит на свою вкладку); KEYCODE_BACK уводит назад, Esc не работает.
 */
function hideKeyboard() {
  const shown = () => /mInputShown=true/.test(adb("shell", "dumpsys", "input_method"));
  if (!shown()) return;
  tap(50, 1000);
  sleep(600);
  if (shown()) throw new Error("клавиатура не закрылась");
}

/** Заменить текст в поле ввода. */
function setField(node, value) {
  tap(node.x, node.y);
  sleep(400);
  adb("shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(12).fill("KEYCODE_DEL"));
  adb("shell", "input", "text", String(value));
  sleep(300);
}

function scrollTop() {
  for (let i = 0; i < 3; i++) swipe(540, 700, 540, 2000, 200);
  sleep(500);
}

/**
 * Выбрать отрезок «lo-hi» в выпадающем списке (места в статистике, страницы сообщений).
 * isSelect отличает узел списка среди надписей вида «lo-hi». false — такого отрезка нет.
 */
function chooseRange(isSelect, label) {
  let select;
  for (let i = 0; i < 3 && !select; i++) {
    scrollTop();
    select = screen().find(n => /^\d+-\d+$/.test(n.text) && isSelect(n));
  }
  if (!select) throw new Error("не вижу выпадающий список отрезков");
  if (select.text === label) return true;
  tap(select.x, select.y);
  sleep(1200);
  const lo = Number(label.split("-")[0]);
  let last = null;
  for (let i = 0; i < 60; i++) {
    const opts = screen().filter(n => n.cls === "android.widget.CheckedTextView");
    if (!opts.length) { sleep(800); continue; }
    const opt = opts.find(n => n.text === label && n.y2 - n.y1 > 100);
    if (opt) { tap(opt.x, opt.y); sleep(2500); return true; }
    const sig = opts.map(o => o.text).join();
    if (sig === last) break;           // список кончился
    last = sig;
    lo < Number(opts[0].text.split("-")[0]) ? swipe(540, 700, 540, 1700, 300) : swipe(540, 1700, 540, 700, 300);
    sleep(700);
  }
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  return false;
}

// ---- навигация ----

const MENU = { "Обзор": 330, "Развитие": 474, "Галактика": 618, "Флот": 762, "Сервисы": 906, "Инфо": 1482, "Настройки": 1626 };

function menu(item) {
  tap(40, 160);
  sleep(1200);
  tap(175, MENU[item]);
  sleep(2500);
}

/** Сделать текущей свою планету с координатами g:s:p. */
function switchPlanet(coords) {
  // Кнопка списка планет открывает и закрывает его, поэтому после выбора сверяемся с обзором.
  const current = () => screen().some(n => n.text.includes(`Координаты: [${coords}]`));
  menu("Обзор");
  if (current()) return;
  // Список планет попадает в дерево элементов с задержкой, а стоит всегда одинаково:
  // в порядке списка своих планет, строка 144 px начиная с y=330.
  const index = myPlanets().indexOf(coords);
  if (index < 0) throw new Error(`${coords} нет среди своих планет`);
  for (let attempt = 0; attempt < 3; attempt++) {
    tap(1040, 160);
    sleep(2000);
    tap(738, 330 + 144 * index);
    sleep(2500);
    menu("Обзор");
    if (current()) return;
  }
  throw new Error(`не открылся список планет или нет планеты ${coords}`);
}

// ---- обзор: чужие флоты ----

function overview() {
  menu("Обзор");
  const rows = [];
  for (let i = 0; i < 6; i++) {
    for (const n of screen()) if (/цель:/.test(n.text) && n.text.length > 40 && !rows.includes(n.text)) rows.push(n.text);
    const before = rows.length;
    swipe(540, 1900, 540, 700, 500);
    sleep(800);
    if (i > 0 && rows.length === before) break;
  }
  scrollTop();
  return rows;
}

// ---- галактика ----

const systemTitle = nodes => nodes.find(n => /^Система \d+:\d+$/.test(n.text))?.text.slice(8);

/** Открыть систему g:s через поля «Галактика / Система» и «Показать». */
function openSystem(g, s) {
  let nodes = screen();
  if (!find(nodes, "Показать")) { menu("Галактика"); nodes = screen(); }
  const fields = nodes.filter(n => n.cls === "android.widget.EditText" && n.y < 600);
  setField(fields[0], g);
  setField(fields[1], s);
  hideKeyboard();
  tapText("Показать", { scrolls: 0, wait: 2500 });
}

/** Занятые позиции системы g:s: {coords, planet, moon, debris, player, status, alliance, inactive, spy}. Запоминает систему. */
function galaxy(g, s) {
  openSystem(g, s);
  return readSystem(g, s).filter(r => !r.empty);
}

/**
 * Все позиции 1–15 открытой системы g:s (пустые — с `empty`), сохраняет их в galaxy.json.
 * Если нижние строки за краем экрана, дочитывает их прокруткой и возвращает страницу наверх.
 */
function readSystem(g, s, nodes = screen()) {
  if (systemTitle(nodes) !== `${g}:${s}`) throw new Error(`на экране не система ${g}:${s} (${systemTitle(nodes)})`);
  const occupied = +nodes.map(n => n.text.match(/^\( (\d+) Занятых планет/)).find(Boolean)?.[1];
  const rows = new Map(systemRows(nodes, g, s).map(r => [r.pos, r]));
  let swipes = 0;
  for (; !rows.has(15) && swipes < 3; swipes++) {
    swipe(540, 1900, 540, 1200, 800);
    sleep(800);
    for (const r of systemRows(screen(), g, s)) if (!rows.has(r.pos)) rows.set(r.pos, r);
  }
  if (swipes) {
    for (let i = 0; i < swipes; i++) swipe(540, 1200, 540, 1900, 800);
    sleep(800);
  }
  const all = [...rows.values()].sort((a, b) => a.pos - b.pos);
  if (all.length !== 15) throw new Error(`система ${g}:${s}: прочитано позиций ${all.length} из 15`);
  const found = all.filter(r => !r.empty).length;
  if (occupied >= 0 && found !== occupied) throw new Error(`система ${g}:${s}: занято ${occupied}, прочитано ${found}`);
  storeSystem(g, s, all);
  return all;
}

/**
 * Позиции 1–15, целиком видимые на экране. Строка — по узлу номера (x 78–138, высота строки);
 * ячейки строки стоят на постоянных x: картинка планеты (150–243), название (x1≈255),
 * луна «s_mond» и поле обломков «debris» (408–600), игрок «Имя (статус)» (x1≈597), альянс (x1≈714),
 * действия (x1≈849, «Шпионить» — правая иконка).
 */
function systemRows(nodes, g, s) {
  const rows = [];
  for (const num of nodes.filter(n => n.x1 === 78 && n.x2 === 138 && /^\d+$/.test(n.text))) {
    const pos = +num.text;
    if (pos < 1 || pos > 15 || num.y1 < 380 || num.y2 > 2190) continue;
    const cells = nodes.filter(n => n !== num && n.text && n.y >= num.y1 && n.y <= num.y2 && n.x1 >= 140);
    const cell = (x1, x2) => cells.find(n => n.x1 >= x1 && n.x1 <= x2)?.text.trim();
    const planet = cell(250, 260), player = cell(590, 605);
    const coords = `${g}:${s}:${pos}`;
    // Занята — если есть картинка планеты или игрок. «Покинутая планета» без картинки и игрока свободна,
    // космическая станция альянса (картинка s_spacestation…) — занята, но без игрока.
    const image = cells.find(n => n.x1 >= 145 && n.x2 <= 250 && n.text.startsWith("s_"))?.text;
    if (!image && !player) { rows.push({ coords, pos, empty: true, ...(planet && { note: planet }) }); continue; }
    const m = player?.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const status = m ? m[2].trim() : "";
    const spy = cells.filter(n => n.click && n.x1 >= 915).pop();
    rows.push({ coords, pos, planet, ...(image?.includes("spacestation") && { station: true }),
                moon: cells.some(n => n.text === "s_mond"), debris: cells.some(n => n.text === "debris"),
                player: (m ? m[1] : player || "").trim(), status, alliance: cell(710, 720) || "",
                // Летать можно только к неактивным: в скобках есть i или I (N, S и другие буквы не важны).
                inactive: /i/i.test(status), spy: spy && { x: spy.x, y: spy.y } });
  }
  return rows;
}

// Карта галактики: что видели на каждой позиции. systems: {"g:s": время просмотра}, planets: {"g:s:p": позиция}.
const GALAXY = path.join(__dirname, "galaxy.json");
const loadGalaxy = () => { try { return JSON.parse(fs.readFileSync(GALAXY, "utf8")); } catch { return { systems: {}, planets: {} }; } };
function saveGalaxy(map) {
  fs.writeFileSync(GALAXY + ".tmp", JSON.stringify(map));
  fs.renameSync(GALAXY + ".tmp", GALAXY);
}

/** Записать просмотренную систему: занятые позиции заменяют прежние, освободившиеся удаляются; статусы — и в state.json. */
function storeSystem(g, s, rows) {
  const map = loadGalaxy(), state = loadState(), at = Date.now();
  for (const c of Object.keys(map.planets)) if (c.startsWith(`${g}:${s}:`)) delete map.planets[c];
  for (const { coords, planet, station, moon, debris, player, status, alliance } of rows.filter(r => !r.empty)) {
    map.planets[coords] = { planet, ...(station && { station }), moon, debris, player, status, alliance, at };
    if (player) state.status[coords] = { status, player, at };
  }
  map.systems[`${g}:${s}`] = at;
  saveGalaxy(map);
  saveState(state);
}

/**
 * Положить карту галактики в «Загрузки» телефона файлом заметок без настроек и отчётов:
 * в заметках «Резервная копия» → «Загрузить файл» → «Добавить из файла».
 */
/** Рейтинг из bot/stats-raw.json (node bot/stats.js) в виде страницы заметок: {at, players: {ник: [место, очки]}}. */
function loadRating() {
  try {
    const { at, players } = JSON.parse(fs.readFileSync(path.join(__dirname, "stats-raw.json"), "utf8"));
    return { at, players: Object.fromEntries(players.map(p => [p.name, [p.rank, p.points]])) };
  } catch { return null; }
}
function pushGalaxy() {
  const map = loadGalaxy(), d = new Date(), pad = n => String(n).padStart(2, "0");
  const name = `space-kings-galaxy-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  const local = path.join(__dirname, name);
  const rating = loadRating();
  fs.writeFileSync(local, JSON.stringify({ format: "space-kings-recon", version: 2, exportedAt: d.getTime(), targets: [], galaxy: map,
                                           ...(rating && { rating }) }));
  try { adb("push", local, "/sdcard/Download/" + name); } finally { fs.unlinkSync(local); }
  return { file: "Загрузки/" + name, systems: Object.keys(map.systems).length, planets: Object.keys(map.planets).length,
           rating: rating ? Object.keys(rating.players).length : "нет (node bot/stats.js)" };
}

/**
 * Обойти системы галактики g с `from` по `to` стрелкой «→» (одно нажатие и одно чтение экрана на систему).
 * Каждая система сохраняется сразу, поэтому прерванный обход продолжают с места остановки.
 */
function scan(g, from = 1, to = 499) {
  [g, from, to] = [g, from, to].map(Number);
  if (!g) throw new Error("укажите галактику: scan <галактика> [с системы] [по систему]");
  openSystem(g, from);
  let total = 0, s = from, nodes = screen();
  for (;;) {
    let rows;
    try {
      rows = readSystem(g, s, nodes);
    } catch (e) {
      // Системное окно Samsung про зарядку перекрывает игру: закрыть и прочитать систему заново (один раз).
      const ok = screen().find(n => n.text === "OK");
      if (!ok) throw e;
      console.log(`${g}:${s} закрываю системное окно и читаю заново (${e.message})`);
      tap(ok.x, ok.y);
      sleep(1500);
      openSystem(g, s);
      rows = readSystem(g, s);
    }
    total += rows.filter(r => !r.empty).length;
    console.log(`${g}:${s} занято ${rows.filter(r => !r.empty).length}`);
    // Блокировка старше 10 минут считается брошенной: долгий обход обновляет её время после каждой системы.
    if (fs.existsSync(LOCK)) fs.utimesSync(LOCK, new Date(), new Date());
    if (s >= to) break;
    tap(861, 520);  // «→» рядом с номером системы
    s++;
    sleep(1500);
    for (let i = 0; i < 4 && systemTitle(nodes = screen()) !== `${g}:${s}`; i++) sleep(1000);
    const title = systemTitle(nodes);
    if (title !== `${g}:${s}`) {
      if (title && +title.split(":")[0] !== g) { s--; break; }  // стрелка ушла в следующую галактику: систем меньше
      openSystem(g, s);
      nodes = screen();
    }
  }
  return { galaxy: g, systems: `${from}–${s}`, planets: total };
}

// ---- шпионские отчёты ----

const REPORT_HEADER = /^Шпионский доклад с .+ \[\d+:\d+:\d+\] от \d\d-\d\d-\d{4} \d\d:\d\d:\d\d$/;

/**
 * Отчёты из «Сообщений шпионажа», от новых к старым, не больше `max`.
 * Полный отчёт длиннее экрана, а у узлов за краем экрана координаты обрезаны. Поэтому собираем текст
 * страницы из видимых строк, прокручивая её и склеивая экраны по перекрытию, и разбираем целиком.
 */
function readReports(max = 20) {
  scrollTop();
  let all = [], prev = "";
  for (let page = 0; page < 6 * max; page++) {
    const lines = visibleLines(screen());
    const key = lines.join("\n");
    if (key === prev) break;
    prev = key;
    all = joinOverlap(all, lines);
    if (all.filter(l => REPORT_HEADER.test(l)).length > max) break;
    swipe(540, 1900, 540, 1000, 700);
    sleep(900);
  }
  scrollTop();
  return SK.parseReports(all.join("\n")).sort((a, b) => b.time - a.time).slice(0, max);
}

/** Строки текста, целиком видимые на экране, сверху вниз; части строки через пробелы. */
function visibleLines(nodes) {
  const seen = new Set();
  const leaves = nodes
    .filter(n => n.text && n.y1 >= 390 && n.y2 <= 2185)
    .filter(n => REPORT_HEADER.test(n.text) || (n.text.length < 60 && !/^(от \d|\[\d|Шпионский доклад)/.test(n.text)))
    .filter(n => { const k = n.text + "@" + n.y; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const n of leaves) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - n.y) < 15 && !REPORT_HEADER.test(n.text) && !REPORT_HEADER.test(last.parts[0])) last.parts.push(n.text);
    else lines.push({ y: n.y, parts: [n.text] });
  }
  return lines.map(l => l.parts.join("   "));
}

/** Приклеить строки следующего экрана: самое длинное совпадение конца `acc` с началом `next`. */
function joinOverlap(acc, next) {
  for (let k = Math.min(acc.length, next.length); k >= 2; k--) {
    if (acc.slice(-k).every((l, i) => l === next[i])) return acc.concat(next.slice(k));
  }
  return acc.concat(next);
}

/**
 * Забрать с телефона самый свежий файл заметок (кнопка «Скачать файл» кладёт его в Download)
 * и заменить им данные бота; прежние данные остаются рядом в .bak.
 */
function pullData() {
  const dir = "/sdcard/Download/";
  const name = adb("shell", "ls", "-t", dir).split(/\r?\n/).find(f => /^space-kings-\d{4}-\d\d-\d\d.*\.json$/.test(f));
  if (!name) throw new Error(`в ${dir} нет файла space-kings-….json — нажмите «Скачать файл» в заметках`);
  const d = JSON.parse(adb("exec-out", `cat '${dir}${name}'`));
  if (d.format !== "space-kings-recon" || !Array.isArray(d.targets) || !d.settings?.planets?.length)
    throw new Error(`${name} — не файл заметок`);
  // Под тем же именем, что на телефоне: самый свежий файл и становится данными (DATA) следующих команд.
  const to = path.join(ROOT, name);
  if (fs.existsSync(to)) fs.copyFileSync(to, to + ".bak");
  fs.writeFileSync(to + ".tmp", JSON.stringify(d));
  fs.renameSync(to + ".tmp", to);
  return { file: name, exportedAt: new Date(d.exportedAt).toLocaleString("ru"), targets: d.targets.length, planets: d.settings.planets.length,
           galaxy: d.galaxy ? pullGalaxy(d.galaxy) : "в выгрузке нет карты" };
}

/**
 * Слить карту из выгрузки заметок в galaxy.json (SK.mergeGalaxy): более свежие просмотры систем и ручные правки
 * с телефона. Правки статуса переносятся и в state.json, которым пользуются рейды.
 */
function pullGalaxy(from) {
  const { galaxy: map, count, edited } = SK.mergeGalaxy(loadGalaxy(), from);
  const state = loadState();
  for (const c of edited) {
    const p = map.planets[c];
    if (p.player) state.status[c] = { status: p.deleted ? "удалена" : p.status, player: p.player, at: p.manual };
  }
  saveGalaxy(map);
  saveState(state);
  return { edits: edited.length, systemsFromPhone: count - edited.length };
}

function loadData() { return JSON.parse(fs.readFileSync(DATA, "utf8")); }
function saveData(d) {
  fs.writeFileSync(DATA + ".tmp", JSON.stringify(d));
  fs.renameSync(DATA + ".tmp", DATA);
}

/** Записать отчёты в данные; вернуть то, что обновилось. */
function storeReports(reports) {
  const d = loadData();
  const byCoords = new Map(d.targets.map((t, i) => [t.coords, i]));
  const updated = [];
  for (const r of reports) {
    const i = byCoords.get(r.coords);
    const merged = SK.mergeReport(i === undefined ? null : d.targets[i], r);
    if (!merged) continue;
    if (i === undefined) { byCoords.set(r.coords, d.targets.length); d.targets.push(merged); }
    else d.targets[i] = merged;
    updated.push(merged);
  }
  if (updated.length) saveData(d);
  return updated;
}

function openSpyReports() {
  tap(1040, 320);
  sleep(2000);
  tapText("Сообщения шпионажа", { scrolls: 0, wait: 2500 });
}

// ---- свои планеты и цели ----

const STATE = path.join(__dirname, "state.json");
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { status: {} }; } };
const saveState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));

const myPlanets = () => loadData().settings.planets.map(p => p.coords);

function nearestPlanet(coords) {
  const to = SK.parseCoords(coords);
  return myPlanets().map(c => ({ coords: c, dist: SK.distance(SK.parseCoords(c), to) }))
    .sort((a, b) => a.dist - b.dist)[0];
}

const MEGA = { capacity: 350000, consumption: 100 };
const PROBE_SPEED = 342000000;  // шпионский зонд с нашими технологиями (game-data/units.json)
const MIN_LOOT = 400000;

/** Добыча при атаке сейчас: половина ресурсов (по отчёту и приросту с его времени). */
function lootNow(target, at = Date.now()) {
  return Math.floor(SK.resourcesAt(target, at).reduce((a, b) => a + b, 0) / 2);
}

/** Мега-транспортов, чтобы вывезти добычу с ближайшей планеты. */
function megasFor(loot, dist) {
  return SK.shipsNeeded(loot, MEGA, dist, 100).count;
}

// ---- шпионаж ----

/**
 * Зонд на одну цель с текущей планеты (планету не переключает): открывает систему в галактике и,
 * если игрок неактивен, жмёт «Шпионить». `view` — показанная система { gs, rows }, чтобы не открывать её заново.
 */
function spyOne(c, view) {
  const [g, s] = c.split(":");
  if (view.gs !== `${g}:${s}`) { view.rows = galaxy(+g, +s); view.gs = `${g}:${s}`; }
  let row = view.rows.find(r => r.coords === c);
  if (!row) return { coords: c, sent: false, why: "планеты нет" };
  if (!row.inactive) return { coords: c, sent: false, active: true, why: `игрок активен (${row.status})` };
  if (!row.spy || row.spy.y > 2150) {
    swipe(540, 1900, 540, 1100, 600);
    sleep(800);
    view.rows = systemRows(screen(), +g, +s);
    row = view.rows.find(r => r.coords === c);
  }
  if (!row?.spy || row.spy.y > 2150) return { coords: c, sent: false, why: "не вижу кнопку шпионажа" };
  // Запись о результате появляется под таблицей; при повторной попытке там уже есть прежняя, поэтому берём новую.
  // Шапку с ресурсами (вне VISIBLE) не берём: её числа меняются каждую секунду.
  const texts = () => screen().filter(n => n.text && VISIBLE(n)).map(n => n.text);
  const before = texts();
  tap(row.spy.x, row.spy.y);
  sleep(1500);
  const fresh = texts().filter(t => !before.includes(t));
  const log = fresh.find(t => t.includes(`координаты ${c}`) && t.startsWith("Отправить"));
  return { coords: c, tapped: true, sent: !!log && /Выполнено/.test(log), log: log || fresh.join(" | ") };
}

/** Зонды с текущей планеты по целям, пока не уйдёт `limit`. Активных пропускаем и запоминаем. */
function spy(targets, limit = targets.length) {
  const result = [], view = {};
  menu("Галактика");
  for (const c of targets) {
    if (result.filter(r => r.sent).length >= limit) break;
    const r = spyOne(c, view);
    result.push(r);
    if (r.tapped && !r.sent) break;  // зонды или слоты кончились
  }
  return result;
}

// ---- флот ----

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseDate(s) {
  const m = s.match(/(\d+)\. (\w+) (\d{4}) (\d\d):(\d\d):(\d\d)/);
  return m && new Date(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]).getTime();
}

/** Страница «Флот» текущей планеты: слоты, флоты в полёте, корабли на планете. */
function fleetStatus() {
  // Нажатие в меню теряется, если страница ещё прокручивается по инерции: проверяем, что открылся «Флот».
  for (let i = 0; i < 3; i++) {
    sleep(800);
    menu("Флот");
    scrollTop();
    if (screen().some(n => /^Флоты \d+ из \d+$/.test(n.text))) break;
    if (i === 2) throw new Error("не открылась страница «Флот»");
  }
  // Одинаковые флоты (та же миссия и время) бывают: по каждому ключу берём наибольшее число строк на одном экране.
  const fleets = new Map(), ships = {};
  let slots, expeditions;
  for (let i = 0; i < 8; i++) {
    // Только строки, видимые целиком: у обрезанной строки внизу значения подхватываются из соседней.
    const nodes = screen().filter(n => VISIBLE(n) && n.y1 >= 380 && n.y2 <= 2190);
    const onScreen = new Map();
    for (const n of nodes) {
      let m;
      if ((m = n.text.match(/^Флоты (\d+) из (\d+)$/))) slots = { used: +m[1], total: +m[2] };
      if ((m = n.text.match(/^(\d+)\/(\d+) Экспедиция$/))) expeditions = { used: +m[1], total: +m[2] };
      if ((m = n.text.match(/^(\S+) \((\w+)\) (\d+)$/)) && n.x < 300) {
        const row = nodes.filter(v => Math.abs(v.y - n.y) < 30).sort((a, b) => Math.abs(a.y - n.y) - Math.abs(b.y - n.y));
        const where = row.find(v => /^\[\d+:\d+:\d+\] \[\d+:\d+:\d+\]$/.test(v.text))?.text.match(/\d+:\d+:\d+/g);
        const times = row.find(v => /\d{4} \d\d:\d\d:\d\d .*\d{4} \d\d:\d\d:\d\d/.test(v.text))?.text;
        if (!where || !times) continue;
        const [arrive, back] = times.match(/\d+\. \w+ \d{4} \d\d:\d\d:\d\d/g).map(parseDate);
        const key = [m[1], m[3], where, arrive].join("|");
        if (onScreen.has(key) && onScreen.get(key).some(r => Math.abs(r.y - n.y) < 30)) continue;
        onScreen.set(key, [...(onScreen.get(key) || []), { y: n.y, fleet: { mission: m[1], ships: +m[3], from: where[0], to: where[1], arrive, back } }]);
      }
      // Корабли на планете: название, количество и поле ввода на одной строке.
      const count = nodes.find(v => /^[\d.]+$/.test(v.text) && v.x > 470 && v.x < 590 && Math.abs(v.y - n.y) < 20);
      if (count && n.x > 130 && n.x < 430 && /^[А-ЯЁ]/.test(n.text) && !n.click)
        ships[n.text] = Number(count.text.replace(/\./g, ""));
    }
    for (const [key, rows] of onScreen) if (rows.length > (fleets.get(key)?.length || 0)) fleets.set(key, rows.map(r => r.fleet));
    if (find(nodes, "Продолжить")) break;
    swipe(540, 1900, 540, 900, 600);
    sleep(800);
  }
  scrollTop();
  return { slots, expeditions, fleets: [...fleets.values()].flat().sort((a, b) => a.back - b.back), ships };
}

/** Поле количества у корабля на шаге 1 (прокручивает до него). */
function shipField(name) {
  for (let i = 0; i < 8; i++) {
    const nodes = screen();
    const label = nodes.find(n => n.text === name && VISIBLE(n) && n.x < 450);
    if (label) {
      const field = nodes.find(n => n.cls === "android.widget.EditText" && Math.abs(n.y - label.y) < 40);
      if (field && field.y < 2150) return field;
    }
    swipe(540, 1900, 540, 1100, 600);
    sleep(800);
  }
  throw new Error(`не нашёл поле для «${name}»`);
}

const stepValue = (nodes, label) => {
  const l = nodes.find(n => n.text === label && n.x < 540);
  return l && nodes.find(n => n.x > 540 && n.x < 900 && Math.abs(n.y - l.y) < 15 && n.text && n.text !== label)?.text;
};

/** Шаг 2: ввести цель и прочитать расчёт полёта. */
function setTarget([g, s, p]) {
  sleep(1000);
  const fields = screen().filter(n => n.cls === "android.widget.EditText" && n.y > 560 && n.y < 700).sort((a, b) => a.x - b.x);
  if (fields.length !== 3) throw new Error("не вижу полей цели на шаге 2");
  [g, s, p].forEach((v, i) => setField(fields[i], v));
  hideKeyboard();
  sleep(800);
  const nodes = screen();
  const got = nodes.filter(n => n.cls === "android.widget.EditText" && n.y > 560 && n.y < 700).sort((a, b) => a.x - b.x).map(n => n.text);
  if (got.join(":") !== [g, s, p].join(":")) throw new Error(`цель не ввелась: ${got.join(":")}`);
  return { distance: stepValue(nodes, "Дистанция"), flight: stepValue(nodes, "Время (расстояние)"),
           arrive: stepValue(nodes, "Время прибытия"), back: stepValue(nodes, "Время возвращения"),
           fuel: stepValue(nodes, "Потребление дейтерия"), cargo: stepValue(nodes, "Максимальная загрузка") };
}

/** Шаг 3: выбрать миссию и отправить. */
function sendWithMission(mission) {
  sleep(1500);
  const nodes = screen();
  const radio = nodes.find(n => n.text === mission && VISIBLE(n) && n.x < 540);
  if (!radio) throw new Error(`на шаге 3 нет миссии «${mission}» — не отправляю`);
  tap(radio.x1 - 30 > 130 ? radio.x1 - 30 : radio.x, radio.y);
  sleep(700);
  if (process.env.DRY) throw new Error(`DRY: дошёл до отправки (миссия «${mission}»), не отправляю`);
  tapText("Продолжить", { scrolls: 2, wait: 3000 });
}

/** Атака мега-транспортами с текущей планеты на `to`: «Флот» → корабли → координаты → «Атаковать». */
function attack(to, megas) {
  const before = fleetStatus();
  if (before.slots.total - before.slots.used <= 1) throw new Error("нет свободного слота (1 держим под шпионов)");
  if ((before.ships["Мега-транспорт"] || 0) < megas)
    throw new Error(`на планете только ${before.ships["Мега-транспорт"] || 0} мега-транспортов, нужно ${megas}`);
  setField(shipField("Мега-транспорт"), megas);
  hideKeyboard();
  tapText("Продолжить");
  const flight = setTarget(to.split(":").map(Number));
  tapText("Продолжить");
  sendWithMission("Атаковать");
  const after = fleetStatus();
  const sent = after.fleets.find(f => f.mission === "Атаковать" && f.to === to && f.ships === megas &&
    !before.fleets.some(b => b.to === f.to && b.arrive === f.arrive));
  if (!sent) throw new Error("после отправки не вижу новый флот в списке — проверьте вручную");
  return { to, megas, ...flight, arriveAt: sent.arrive, backAt: sent.back, megasLeft: after.ships["Мега-транспорт"] };
}

/** Цели с планеты `from`: без флота и обороны, добыча по оценке от 500 тыс., ближние первыми. */
function targetsNear(from, exclude = new Set()) {
  const now = Date.now(), mine = new Set(myPlanets()), status = loadState().status, at = SK.parseCoords(from);
  return loadData().targets
    .filter(t => !mine.has(t.coords) && !exclude.has(t.coords) && !t.detailsUnknown)
    .filter(t => { const g = SK.guards(t); return g.fleet + g.defense === 0; })
    .filter(t => !(status[t.coords] && !/i/i.test(status[t.coords].status) && now - status[t.coords].at < 24 * 3.6e6))
    .map(t => ({ coords: t.coords, loot: lootNow(t, now), dist: SK.distance(at, SK.parseCoords(t.coords)) }))
    .filter(t => t.loot >= MIN_LOOT)
    .sort((a, b) => a.dist - b.dist || b.loot - a.loot);
}

const fmtTime = ms => new Date(ms).toLocaleTimeString("ru");

/**
 * Один круг с планеты `from`: шпионы на ближайшие цели (сколько свободных слотов) → ждём возврата
 * последнего шпиона → читаем отчёты → цели от 500 тыс. атакуем мега-транспортами, остальные только обновляем.
 */
/**
 * Атаковать с планеты `from` цели со свежими (моложе часа) отчётами, для которых она ближайшая своя:
 * без флота и обороны, добыча от порога, атака к ним ещё не летит.
 */
function strike(from) {
  const log = [];
  const say = m => { log.push(`${fmtTime(Date.now())} ${m}`); console.error(m); };
  switchPlanet(from);
  sleep(2000);
  let rows = overview();
  if (!rows.length) { sleep(3000); rows = overview(); }
  const busy = new Set(rows.filter(r => /цель: Атаковать/.test(r)).flatMap(r => r.match(/\d+:\d+:\d+/g) || []));
  const now = Date.now(), mine = new Set(myPlanets());
  const list = loadData().targets
    .filter(t => !mine.has(t.coords) && !busy.has(t.coords) && now - t.time < 3.6e6 && nearestPlanet(t.coords).coords === from)
    .filter(t => { const g = SK.guards(t); return g.fleet + g.defense === 0; })
    .map(t => ({ coords: t.coords, loot: lootNow(t, now), megas: megasFor(lootNow(t, now), SK.distance(SK.parseCoords(from), SK.parseCoords(t.coords))) }))
    .filter(t => t.loot >= MIN_LOOT)
    .sort((a, b) => b.loot - a.loot);
  say(`свежих целей от ${MIN_LOOT / 1e3} тыс.: ${list.map(t => t.coords).join(", ") || "нет"}`);
  const attacks = [];
  for (const p of list) {
    try {
      const a = attack(p.coords, p.megas);
      attacks.push({ ...a, loot: p.loot });
      say(`АТАКА ${p.coords}: ${p.megas} мега, добыча ~${Math.round(p.loot / 1e3)} тыс., прилёт ${fmtTime(a.arriveAt)}, возврат ${fmtTime(a.backAt)}`);
    } catch (e) {
      say(`атака ${p.coords} не ушла: ${e.message}`);
      break;
    }
  }
  return { log, attacks };
}

function round(from) {
  const log = [];
  const say = m => { log.push(`${fmtTime(Date.now())} ${m}`); console.error(m); };
  switchPlanet(from);
  // Не трогаем цели, к которым уже летит атака (с любой планеты). Сразу после смены планеты обзор
  // бывает ещё пустым, поэтому читаем его повторно и добавляем атаки из списка флота этой планеты.
  sleep(2000);
  let rows = overview();
  if (!rows.length) { sleep(3000); rows = overview(); }
  const st = fleetStatus();
  const busy = new Set([
    ...rows.filter(r => /цель: Атаковать/.test(r)).flatMap(r => r.match(/\d+:\d+:\d+/g) || []),
    ...st.fleets.filter(f => f.mission === "Атаковать").map(f => f.to),
  ]);
  const free = st.slots.total - st.slots.used;
  say(`слоты ${st.slots.used}/${st.slots.total}, мега-транспортов на планете ${st.ships["Мега-транспорт"] || 0}`);
  if (free < 1) return { log };
  const list = targetsNear(from, busy);
  const spied = spy(list.slice(0, free * 3).map(t => t.coords), free).filter(r => r.sent).map(r => r.coords);
  say(`шпионы ушли: ${spied.join(", ") || "никуда"}`);
  if (!spied.length) return { log };
  const spies = fleetStatus().fleets.filter(f => f.mission === "Шпионаж" && spied.includes(f.to) && f.back < Date.now() + 2 * 3.6e6);
  const last = spies.length ? Math.max(...spies.map(f => f.back)) : Date.now() + 60e3;
  say(`последний шпион вернётся в ${fmtTime(last)}`);
  if (last > Date.now()) idle(last - Date.now() + 15000);
  openSpyReports();
  const reports = readReports(spied.length + 5).filter(r => spied.includes(r.coords));
  storeReports(reports);
  const data = new Map(loadData().targets.map(t => [t.coords, t]));
  const plan = spied.map(c => data.get(c)).filter(t => t && reports.some(r => r.coords === t.coords))
    .map(t => { const g = SK.guards(t); return { coords: t.coords, loot: lootNow(t), guards: g.fleet + g.defense,
      megas: megasFor(lootNow(t), SK.distance(SK.parseCoords(from), SK.parseCoords(t.coords))) }; })
    .sort((a, b) => b.loot - a.loot);
  for (const p of plan) say(`${p.coords}: добыча ${Math.round(p.loot / 1e3)} тыс.${p.guards ? `, защита/флот ${p.guards}` : ""}`);
  const attacks = [];
  for (const p of plan.filter(p => p.loot >= MIN_LOOT && !p.guards)) {
    try {
      const a = attack(p.coords, p.megas);
      attacks.push({ ...a, loot: p.loot });
      say(`АТАКА ${p.coords}: ${p.megas} мега, добыча ~${Math.round(p.loot / 1e3)} тыс., прилёт ${fmtTime(a.arriveAt)}, возврат ${fmtTime(a.backAt)}`);
    } catch (e) {
      say(`атака ${p.coords} не ушла: ${e.message}`);
      break;
    }
  }
  return { log, attacks };
}

/**
 * Шпионы на цели галактики `galaxy` со своей планеты этой же галактики: без флота и обороны, склад полон
 * или добыча от MIN_LOOT, от большей добычи к меньшей. Цели с отчётом моложе часа пропускаем.
 * Всё время стоим на вкладке «Галактика». Если зонд не ушёл (красная ошибка внизу — слоты флота заняты),
 * ждём ближайшего возврата своих шпионов по расчёту времени полёта и шлём дальше. Отчёты не читаем.
 * Цели с активными игроками (без i в статусе) только выводим в консоль. Стоп на `total` отправленных.
 */
function sweep(galaxy, total) {
  galaxy = Number(galaxy);
  if (!galaxy) throw new Error("укажите галактику: sweep <галактика> [сколько]");
  total = Number(total) || Infinity;
  const from = myPlanets().find(c => SK.parseCoords(c).g === galaxy);
  if (!from) throw new Error(`в галактике ${galaxy} нет своей планеты`);
  const now = Date.now(), mine = new Set(myPlanets());
  const full = t => { const prod = SK.production(t); return SK.resourcesAt(t, now, prod).some((v, i) => v >= prod.caps[i]); };
  const list = loadData().targets
    .filter(t => SK.parseCoords(t.coords).g === galaxy && !mine.has(t.coords) && !t.detailsUnknown && now - t.time > 3.6e6)
    .filter(t => { const g = SK.guards(t); return g.fleet + g.defense === 0; })
    .map(t => ({ coords: t.coords, loot: lootNow(t, now), full: full(t) }))
    .filter(t => t.full || t.loot >= MIN_LOOT)
    .sort((a, b) => b.loot - a.loot);
  console.log(`галактика ${galaxy}: целей ${list.length}, шлём с ${from}`);
  switchPlanet(from);
  menu("Галактика");
  const sent = [], returns = [], view = {};
  for (const t of list) {
    if (sent.length >= total) break;
    for (;;) {
      const r = spyOne(t.coords, view);
      if (r.sent) {
        const flight = SK.flightSeconds(SK.distance(SK.parseCoords(from), SK.parseCoords(t.coords)), PROBE_SPEED, 100);
        returns.push(Date.now() + 2 * flight * 1000);
        sent.push(t.coords);
        console.log(`${sent.length}/${Math.min(total, list.length)} шпион → ${t.coords}, добыча ~${Math.round(t.loot / 1e3)} тыс.${t.full ? ", склад полон" : ""}, вернётся ${fmtTime(returns[returns.length - 1])}`);
        break;
      }
      if (!r.tapped) { console.log(`${t.coords}: ${r.why}`); break; }
      const pending = returns.filter(b => b > Date.now());
      const until = pending.length ? Math.min(...pending) + 5e3 : Date.now() + 60e3;
      console.log(`слоты заняты (${r.log || "нет записи"}), жду до ${fmtTime(until)}`);
      idle(until - Date.now());
    }
  }
  return { sent: sent.length, targets: sent };
}

/** Экспедиция с VRNville: шаблон (81 мега + 3 уничтожителя), флагман — если дома и броня выше 50%. */
function expedition() {
  switchPlanet(EXPEDITION_FROM);
  const before = fleetStatus();
  if (before.expeditions.used >= before.expeditions.total) throw new Error("все слоты экспедиций заняты");
  if (before.slots.used >= before.slots.total) throw new Error("нет свободного слота флота");
  let flagship = null;
  if (before.ships["Флагман"]) {
    // Вкладки «Флот | Симулятор | Флагман | Аукцион» вверху страницы.
    scrollTop();
    tap(646, 447);
    sleep(2500);
    const armor = screen().map(n => n.text.match(/^(\d+)% \(/)).find(Boolean);
    flagship = armor ? +armor[1] : null;
    scrollTop();
    tap(225, 447);
    sleep(2500);
  }
  tapText("Экспедиция [0:0:0]", { scrolls: 6 });
  const mega = shipField("Мега-транспорт"), destroyer = shipField("Уничтожитель");
  if (mega.text !== "81" || destroyer.text !== "3") throw new Error(`шаблон дал ${mega.text} мега и ${destroyer.text} уничтожителей`);
  const withFlagship = flagship > 50;
  if (withFlagship) { setField(shipField("Флагман"), 1); hideKeyboard(); }
  tapText("Продолжить", { scrolls: 6 });
  const flight = setTarget(EXPEDITION_TARGET);
  tapText("Продолжить");
  sendWithMission("Экспедиция");
  const after = fleetStatus();
  if (after.expeditions.used !== before.expeditions.used + 1) throw new Error("экспедиция не появилась в списке — проверьте вручную");
  const sent = after.fleets.filter(f => f.mission === "Экспедиция").sort((a, b) => b.arrive - a.arrive)[0];
  return { flagship, withFlagship, ...flight, arriveAt: sent?.arrive, backAt: sent?.back, expeditions: after.expeditions };
}

// ---- команды ----

function lock() {
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK); return; } catch {
      const age = Date.now() - fs.statSync(LOCK).mtimeMs;
      if (age > 10 * 60e3) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
      if (i > 300) throw new Error("телефон занят другой командой");
      sleep(2000);
    }
  }
}
const unlock = () => fs.rmSync(LOCK, { recursive: true, force: true });

function withLock(fn) {
  lock();
  try { return fn(); } finally { unlock(); }
}

/** Подождать, отпустив телефон для других команд (проверки атак). */
function idle(ms) {
  unlock();
  try { sleep(ms); } finally { lock(); }
}

const COMMANDS = {
  /** Чужие флоты в обзоре (всё, что не начинается с «Ваш»). */
  attacks() {
    const rows = overview();
    return { checked: new Date().toLocaleTimeString("ru"), rows: rows.length, foreign: rows.filter(r => !/^Ваш /.test(r)) };
  },
  overview,
  /** Прочитать шпионские отчёты (первая страница) и записать в данные. */
  reports(max) {
    openSpyReports();
    const reports = readReports(Number(max) || 20);
    const updated = storeReports(reports);
    return reports.map(r => ({ coords: r.coords, time: new Date(r.time).toLocaleString("ru"), incomplete: r.incomplete,
      resources: r.resources, fleet: r.fleet, defense: r.defense, stored: updated.some(u => u.coords === r.coords && u.time === r.time) }));
  },
  spy: (...targets) => spy(targets),
  round,
  strike,
  sweep,
  pull: pullData,
  fleet: from => { if (from) switchPlanet(from); return fleetStatus(); },
  attack: (to, megas) => attack(to, Number(megas)),
  expedition,
  /** Цели для шпионажа: без флота и обороны, добыча по оценке от 500 тыс., не активные по галактике. */
  candidates(n = 20) {
    const now = Date.now(), mine = new Set(myPlanets()), status = loadState().status;
    return loadData().targets
      .filter(t => !mine.has(t.coords) && !t.detailsUnknown)
      .filter(t => { const g = SK.guards(t); return g.fleet + g.defense === 0; })
      .filter(t => !(status[t.coords] && !/i/i.test(status[t.coords].status) && now - status[t.coords].at < 24 * 3.6e6))
      .map(t => { const near = nearestPlanet(t.coords), loot = lootNow(t, now);
        return { coords: t.coords, loot, ageH: +((now - t.time) / 3.6e6).toFixed(1), from: near.coords, megas: megasFor(loot, near.dist) }; })
      .filter(t => t.loot >= MIN_LOOT)
      .sort((a, b) => b.loot - a.loot)
      .slice(0, Number(n));
  },
  planet: coords => { switchPlanet(coords); return "ok"; },
  galaxy: gs => { const [g, s] = gs.split(":").map(Number); return galaxy(g, s); },
  scan,
  push: pushGalaxy,
  screen: () => screen().filter(n => VISIBLE(n) && n.text).map(n => `${n.x},${n.y}${n.click ? "*" : " "} ${n.text}`).join("\n"),
};

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!COMMANDS[cmd]) { console.error("команды: " + Object.keys(COMMANDS).join(", ")); process.exit(2); }
  try {
    // pull только читает файл с телефона и не трогает экран — может идти во время обхода.
    const out = cmd === "pull" ? COMMANDS[cmd](...args) : withLock(() => COMMANDS[cmd](...args));
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1));
  } catch (e) {
    console.error("ОШИБКА: " + e.message);
    process.exit(1);
  }
}

module.exports = { adb, screen, find, tap, tapText, setField, menu, switchPlanet, galaxy, overview, sleep, swipe, scrollTop,
                   visibleLines, joinOverlap, withLock, screencap, chooseRange, COMMANDS, DATA, loadData, saveData, loadGalaxy };
