// Интерфейс. Данные — в IndexedDB этого браузера: каждый отчёт отдельной записью, настройки — одной.
// Расчёты — core.js, бой и звёзды смерти — battle.js (в фоне, ds-worker.js), модель атаки — attack.js,
// самый дешёвый флот — cheapest.js (оценки флотов — в потоках cheapest-worker.js).
const DB_NAME = "space-kings-recon";
const LEGACY_KEY = "space-kings-recon-v1";  // localStorage старых версий, переносится при первом запуске
const MEGA = { id: "mega", name: "Мега транспорт", drive: "impulse", base: 7000, capacity: 350000, consumption: 100 };
const DEFAULT_SETTINGS = {
  // мои планеты: {coords, name, metal, crystal, deut, temp}; metal, crystal, deut — уровни шахт,
  // temp — средняя температура, null — худшая для слота
  planets: [],
  engines: { combustion: 0, impulse: 0, hyperspace: 0 },
  techs: {},        // мои боевые исследования {название: уровень}; реактивный двигатель — из engines
  premium: false,   // премиум-атакер: +50% к атаке, щитам и броне моих кораблей
  ships: [MEGA],
  shipId: "mega",
  speed: 100,
  loot: 50,
  filter: "all", // all | open | guarded | planet (подходящие для планеты distFrom)
  onlyFull: false,        // только с полным складом
  onlyIncomplete: false,  // только с неизвестной защитой и постройками
  minLoot: 0,             // добыча от, тыс.; 0 — без ограничения
  minDeut: 0,             // добыча в пересчёте на дейтерий от, тыс.; 0 — без ограничения
  sort: "loot",   // loot | lootOnly | deut | coords | distance
  distFrom: "",   // своя планета, от которой сортировать по расстоянию
  pageSize: 20,
  minesOpen: false,  // показан топ шахт
  // Бонусы к выработке шахт и естественного прироста (экран «Производство» в игре): премиум +50%, альянс и станции — в процентах.
  prodBonus: { premium: true, alliance: 10, stations: 10 },
  colonization: 9,   // уровень колонизационной технологии
  cheapFrom: "",     // своя планета, с которой лететь в подборе самого дешёвого флота
  // Список активных планет по карте галактики.
  activeSort: "coords",  // coords | distance
  activeFrom: "",        // своя планета, от которой считать расстояние
  activeStrong: false,   // показывать сильных (S)
  activeNoob: false,     // показывать слабых (N)
  activePlayer: "",      // часть ника
  showHidden: false,     // в целях — только скрытые по карте (активные, удалённые, исчезнувшие)
  backup: { at: 0, changedAt: 0, snoozeUntil: 0 },  // напоминание о резервной копии
};
const PAGE_SIZES = [10, 20, 50];
const BACKUP_EVERY = 3 * 24 * 3.6e6;  // напоминать, если копии нет дольше 3 дней
const SNOOZE = 24 * 3.6e6;
const FILTERS = { all: "Все цели", open: "Без защиты", guarded: "С защитой", planet: "Подходящие для планеты" };
// Фильтр planet: цели без защиты в галактике планеты; чем дальше (в системах), тем больше нужна добыча в дейтерии.
const PLANET_MIN_DEUT = [[10, 200e3], [20, 250e3], [40, 300e3], [75, 350e3], [100, 400e3], [Infinity, 450e3]];
const SORTS = {
  // Сначала планеты с полным складом: они простаивают. Дальше — по добыче.
  loot: { name: "По добыче", compare: (a, b) => (b.full.some(Boolean) - a.full.some(Boolean)) || b.total - a.total },
  lootOnly: { name: "По добыче без учёта склада", compare: (a, b) => b.total - a.total },
  deut: { name: "По добыче в дейтерии", compare: (a, b) => b.deut - a.deut },
  coords: { name: "По координатам", compare: byCoords },
  // Ближние раньше; без своих планет расстояния нет — по координатам.
  distance: { name: "По расстоянию", compare: (a, b) => (a.dist ?? 0) - (b.dist ?? 0) || byCoords(a, b) },
};

function byCoords(a, b) {
  const x = SK.parseCoords(a.report.coords), y = SK.parseCoords(b.report.coords);
  return x.g - y.g || x.s - y.s || x.p - y.p;
}

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Math.floor(n).toLocaleString("ru-RU");
const fmtShort = n => n >= 1e6 ? (n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " млн"
  : n >= 1e3 ? Math.floor(n / 1e3).toLocaleString("ru-RU") + " тыс." : fmt(n);
const pad = n => String(n).padStart(2, "0");
const duration = sec => `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const dateTime = ms => { const d = new Date(ms); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${clock(ms)}`; };
const age = ms => { const m = Math.floor(ms / 60000); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; };

let settings = normalizeSettings(null);
let targets = {};   // координаты -> последний шпионский отчёт
// Карта галактики от бота (bot/sk.js scan): systems {"г:с": время просмотра}, planets {"г:с:п": {planet, moon, debris, player, status, alliance, at}}.
let galaxy = { systems: {}, planets: {} };
let page = 1;
let activePage = 1;
let db = null;
let pendingImport = null;
const openDetails = new Set();  // раскрытые «Расчёт» переживают перерисовку

function normalizeSettings(saved) {
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
  // Корабли из старых версий: без трюма и расхода топлива.
  s.ships = s.ships.map(ship => ({ ...(ship.id === "mega" ? MEGA : { capacity: 0, consumption: 0 }), ...ship }));
  s.backup = { ...DEFAULT_SETTINGS.backup, ...s.backup };
  s.techs = { ...s.techs };
  s.prodBonus = { ...DEFAULT_SETTINGS.prodBonus, ...s.prodBonus };
  for (const k of ["attackOpen", "attackFrom", "attackDs"]) delete s[k];  // убранный подбор атаки
  if (!s.backup.at) s.backup.at = Date.now();  // отсчёт — с первого запуска
  if (!PAGE_SIZES.includes(s.pageSize)) s.pageSize = DEFAULT_SETTINGS.pageSize;
  return s;
}

// ---- Хранилище ----

const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

function openDb() {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore("targets", { keyPath: "coords" });
    req.result.createObjectStore("meta");
  };
  return done(req);
}

/**
 * Одна транзакция: настройки, добавленные и удалённые отчёты; `clear` — сначала стереть все отчёты;
 * `map` — записать карту галактики (она хранится отдельно от отчётов, одной записью).
 */
function write({ put = [], remove = [], clear = false, map = false } = {}) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["targets", "meta"], "readwrite");
    const store = tx.objectStore("targets");
    if (clear) store.clear();
    for (const r of put) store.put(r);
    for (const c of remove) store.delete(c);
    tx.objectStore("meta").put(settings, "settings");
    if (map) tx.objectStore("meta").put(galaxy, "galaxy");
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/**
 * Применить изменение: перерисовать сразу, записать в фоне.
 * `changed: false` — служебная запись (сортировка, страница), не считается изменением данных.
 */
function save({ changed = true, ...ops } = {}) {
  if (changed) settings.backup.changedAt = Date.now();
  render();
  if (!db) return Promise.resolve();
  return write(ops).catch(e => setStatus("report-status", `Не удалось сохранить данные (${e?.name || e}). Скачайте резервную копию.`, "err"));
}

async function init() {
  db = await openDb();
  const saved = await done(db.transaction("meta").objectStore("meta").get("settings"));
  if (saved) {
    settings = normalizeSettings(saved);
    for (const r of await done(db.transaction("targets").objectStore("targets").getAll())) targets[r.coords] = r;
    galaxy = await done(db.transaction("meta").objectStore("meta").get("galaxy")) || galaxy;
    return;
  }
  // Первый запуск этой версии: перенести данные из localStorage, если они есть.
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch { /* нет старых данных */ }
  const { targets: oldTargets = {}, ...oldSettings } = legacy || {};
  settings = normalizeSettings(oldSettings);
  targets = { ...oldTargets };
  await write({ put: Object.values(targets) });
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* не мешает работе */ }
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = "status " + (kind || "");
}

/** Своя планета, от которой сортировать по расстоянию: выбранная или первая. */
function distOrigin() {
  return settings.planets.find(p => p.coords === settings.distFrom) || settings.planets[0];
}

function currentShip() {
  return settings.ships.find(s => s.id === settings.shipId) || settings.ships[0];
}

// ---- Карта галактики ----

// Неактивный — в статусе есть i или I; остальные буквы (N, S, v…) не важны.
const isInactive = status => /i/i.test(status || "");
const systemOf = coords => coords.slice(0, coords.lastIndexOf(":"));

/**
 * Позиция по карте: null — статус неизвестен, { free: true } — позиция свободна, иначе запись позиции
 * (deleted — планета удалена, manual — время ручной правки). Ручная правка действует и в непросмотренной системе.
 * Отчёт `reportTime` новее просмотра системы, где позиция была пуста, — там новая колония: статус неизвестен.
 */
function seen(coords, reportTime = 0) {
  const p = galaxy.planets[coords], at = galaxy.systems[systemOf(coords)];
  if (p?.manual || (p && at)) return p;
  return at && reportTime <= at ? { free: true } : null;
}

/** Цель для налёта: игрок неактивен или статус неизвестен. */
const raidable = s => !s || (!s.free && !s.deleted && isInactive(s.status));

/** Добавить карту из файла (SK.mergeGalaxy). Возвращает число обновлённых систем и пришедших правок. */
function mergeGalaxy(from) {
  const r = SK.mergeGalaxy(galaxy, from);
  galaxy = r.galaxy;
  return r.count;
}

/** Ручная правка позиции: mark — moon | deleted | active | S | N, on — включено. */
function markPlanet(coords, mark, on) {
  const old = galaxy.planets[coords]
    || { planet: targets[coords]?.planet || "", player: "", status: "i", moon: false, debris: false, alliance: "" };
  const p = { ...old, manual: Date.now() };
  if (mark === "moon") p.moon = on;
  else if (mark === "deleted") { if (on) p.deleted = true; else delete p.deleted; }
  else {
    // Статус собирается заново: i/I (неактивный; буква запоминается в idle, чтобы вернуть её после «активного»),
    // S, N; отпуск (v) сохраняется.
    const st = old.status || "", flag = f => mark === f ? on : st.includes(f);
    const active = mark === "active" ? on : !isInactive(st);
    const idle = st.match(/[iI]/)?.[0] || old.idle || "i";
    if (active && isInactive(st)) p.idle = idle;
    p.status = (active ? "" : idle) + (flag("S") ? "S" : "") + (flag("N") ? "N" : "") + (st.includes("v") ? "v" : "");
  }
  galaxy.planets[coords] = p;
  save({ map: true });
}

const openEdits = new Set();  // раскрытые «Изменить статус» переживают перерисовку

function statusEditor(coords) {
  const p = galaxy.planets[coords], st = p?.status || "";
  const box = (mark, label, on) => `<label class="check"><input type="checkbox" data-mark="${mark}" data-mark-coords="${esc(coords)}"${on ? " checked" : ""}> ${label}</label>`;
  return `<details data-edit="${esc(coords)}"${openEdits.has(coords) ? " open" : ""}><summary>Изменить статус</summary><div class="row">
    ${box("moon", "Луна", p?.moon)}${box("deleted", "Удалена", p?.deleted)}${box("active", "Активный", p && !isInactive(st))}
    ${box("S", "Сильный (S)", st.includes("S"))}${box("N", "Слабый (N)", st.includes("N"))}</div></details>`;
}

// ---- Цели ----

function targetView(report, now, origin) {
  const ship = currentShip();
  const routes = SK.routes(report.coords, settings.planets, ship, settings.engines, settings.speed);
  const best = routes[0];
  const arrival = best ? now + best.seconds * 1000 : now;
  const prod = SK.production(report);
  const atArrival = SK.resourcesAt(report, arrival, prod);
  const loot = atArrival.map(v => Math.floor(v * settings.loot / 100));
  const total = loot.reduce((a, b) => a + b, 0);
  return {
    report, prod, routes, best, arrival, atArrival, loot, total,
    deut: SK.inDeut(loot),  // добыча в пересчёте на дейтерий: 4 металла = 2 кристалла = 1 дейтерий
    dist: routes.find(rt => rt.from === origin)?.dist,
    // Уровни хранилищ неизвестны — не знаем, полон ли склад.
    full: atArrival.map((v, i) => !report.detailsUnknown && v >= prod.caps[i]),
    guards: SK.guards(report),
    ships: best && SK.shipsNeeded(total, ship, best.dist, settings.speed),
    seen: seen(report.coords, report.time),
  };
}

// ---- Звёзды смерти для сноса ----

// Исследования, которые вводятся в настройках: всё боевое, кроме реактивного двигателя (он в «Двигателях»).
const MY_TECHS = BATTLE.TECHS.filter(t => t !== "Реактивный двигатель");
const myTechs = () => ({ ...settings.techs, "Реактивный двигатель": settings.engines.combustion || 0 });
const dsResults = new Map();  // ключ расчёта → число ЗС; null — не посчитать; undefined у has() — в очереди
let dsWorker = null, dsRedraw = 0;

/** Защитники цели (флот и оборона без флагмана и ракет) и её технологии: из отчёта или, если их там нет, мои. */
function dsTask(report) {
  if (report.detailsUnknown) return null;
  const side = {};
  for (const sec of [report.defense, report.fleet])
    for (const [n, k] of Object.entries(sec)) if (k > 0 && !SK.HARMLESS.has(n)) side[n] = k;
  if (!Object.keys(side).length) return null;
  const own = !Object.keys(report.research || {}).length;
  // Премиума у цели не бывает.
  const def = { techs: own ? myTechs() : Object.fromEntries(BATTLE.TECHS.map(t => [t, report.research[t] || 0])) };
  const att = { techs: myTechs(), premium: settings.premium };
  return { side, att, def, own, key: JSON.stringify([report.coords, report.time, att, def.techs]) };
}

/** Число ЗС с запасом 5%: из кэша или поставить в очередь фонового расчёта (тогда undefined). */
function deathStars(task) {
  if (dsResults.has(task.key)) return dsResults.get(task.key);
  if (typeof Worker === "undefined") return null;
  if (!dsWorker) {
    dsWorker = new Worker("ds-worker.js");
    dsWorker.onmessage = ({ data }) => {
      dsResults.set(data.key, data.n);
      // Ответы приходят пачкой — перерисовать один раз.
      clearTimeout(dsRedraw);
      dsRedraw = setTimeout(() => renderTargets(Date.now()), 200);
    };
  }
  dsResults.set(task.key, undefined);
  dsWorker.postMessage({ key: task.key, side: task.side, att: task.att, def: task.def });
  return undefined;
}

// Защита неизвестна (только неполные отчёты) — не считаем цель открытой.
const guarded = v => v.report.detailsUnknown || v.guards.fleet + v.guards.defense > 0;

/** Фильтр planet: без защиты, в галактике origin, добыча в дейтерии не меньше порога по удалённости в системах. */
function fitsPlanet(v, origin) {
  const a = SK.parseCoords(origin.coords), b = SK.parseCoords(v.report.coords);
  if (a.g !== b.g || guarded(v)) return false;
  const systems = Math.abs(a.s - b.s);
  return v.deut >= PLANET_MIN_DEUT.find(([upTo]) => systems <= upTo)[1];
}

function unitTable(title, units) {
  const rows = Object.entries(units);
  if (!rows.length) return "";
  return `<tr><td colspan="2"><b>${title}</b></td></tr>` + rows.map(([n, c]) =>
    `<tr><td>${esc(n)}${SK.HARMLESS.has(n) ? ' <span class="muted">(не учитывается)</span>' : ""}</td><td>${fmt(c)}</td></tr>`).join("");
}

function card(v, now) {
  const r = v.report, p = v.prod, b = r.buildings, ship = currentShip();
  const task = dsTask(r), ds = task && deathStars(task);
  const dsLine = !task ? ""
    : `Звёзд смерти для сноса: ${ds === undefined ? '<span class="muted">считаю…</span>'
      : ds === null ? '<span class="muted">не посчитать</span>' : ds === Infinity ? "больше 4 096" : `<b class="num">${fmt(ds)}</b>`}`
      + ` <span class="muted">(+5%${task.own ? ", технологии цели — мои: в отчёте их нет" : ""})</span>`;
  const t = task?.def.techs;
  const route = v.best
    ? `из <b class="num">${esc(v.best.from.coords)}</b>${v.best.from.name ? " " + esc(v.best.from.name) : ""} · <b class="num">${duration(v.best.seconds)}</b> · прилёт <b class="num">${clock(v.arrival)}</b>`
    : `<span class="pill warn">Добавьте свою планету, чтобы считать полёт</span>`;
  const cargo = !v.ships ? ""
    : v.ships.count === Infinity ? `<span class="pill warn">${esc(ship.name)}: топливо не помещается в трюм</span>`
    : `<b class="num">${fmt(v.ships.count)}</b> × ${esc(ship.name)} · топливо <span class="num">${fmt(v.ships.fuel)}</span>`
      + (ship.consumption ? "" : ` <span class="pill warn">расход топлива не задан</span>`);
  const pills = [
    ...SK.RESOURCES.filter((_, i) => v.full[i]).map(n => `<span class="pill warn">склад полон: ${n.toLowerCase()}</span>`),
    v.guards.fleet ? `<span class="pill danger">флот ${fmt(v.guards.fleet)}</span>` : "",
    v.guards.defense ? `<span class="pill danger">оборона ${fmt(v.guards.defense)}</span>` : "",
    v.report.detailsUnknown ? `<span class="pill warn">неполный отчёт: защита неизвестна</span>` : "",
    guarded(v) ? "" : `<span class="pill ok">без защиты</span>`,
  ].join(" ");
  const levels = [
    ["Рудник металла", b["Рудник по добыче металла"]], ["Рудник кристалла", b["Рудник по добыче кристаллов"]],
    ["Синтезатор дейтерия", b["Синтезатор дейтерия"]], ["Солнечная ЭС", b["Солнечная электростанция"]],
    ["Термоядерная ЭС", b["Термоядерная электростанция"]], ["Энергетическая технология", r.research["Энергетическая технология"]],
  ];
  return `<article class="card">
    <div class="spread">
      <span><span class="coords">${esc(r.coords)}</span> <span class="muted">${esc(r.planet)}</span></span>
      <span class="row">${task ? `<button class="small" data-cheapest="${esc(r.coords)}">Дешёвый флот</button>` : ""}
        <button class="small danger" data-delete-target="${esc(r.coords)}">Удалить</button></span>
    </div>
    <div class="muted" style="font-size:13px">отчёт ${dateTime(r.time)}, ${age(now - r.time)} назад · ${v.seen
      ? `${esc(v.seen.player || "—")} (${esc(v.seen.status)})${v.seen.alliance ? " · " + esc(v.seen.alliance) : ""}${v.seen.moon ? " · луна" : ""}`
        + (v.seen.manual ? ` · изменено ${dateTime(v.seen.manual)}` : "")
      : `<span class="pill warn">статус неизвестен: ${galaxy.systems[systemOf(r.coords)] ? "отчёт новее карты" : "система не просмотрена"}</span>`}</div>
    ${statusEditor(r.coords)}
    <div class="spread"><span><span class="loot">${fmtShort(v.total)}</span> <span class="muted num">≈ ${fmtShort(v.deut)} дейт.</span></span><span>${pills}</span></div>
    <div class="res">${SK.RESOURCES.map((n, i) => `<div>${n}<b>${fmt(v.loot[i])}</b></div>`).join("")}</div>
    <div class="route">${route}</div>
    ${cargo ? `<div class="route">${cargo}</div>` : ""}
    ${dsLine ? `<div class="route">${dsLine}</div>` : ""}
    <details data-coords="${esc(r.coords)}"${openDetails.has(r.coords) ? " open" : ""}>
      <summary>Расчёт и отчёт</summary>
      <table>
        ${SK.RESOURCES.map((n, i) => `<tr><td>${n}: в отчёте → при прилёте</td><td>${fmt(r.resources[n] || 0)} → ${fmt(v.atArrival[i])}</td></tr>`).join("")}
        ${SK.RESOURCES.map((n, i) => `<tr><td>${n}: в час / склад</td><td>${fmt(p.rates[i])} / ${fmtShort(p.caps[i])}</td></tr>`).join("")}
        <tr><td>Энергия / потребление шахт</td><td>${fmt(p.energy)} / ${fmt(p.consumption)} (${(p.factor * 100).toFixed(1)}%)</td></tr>
        <tr><td>Температура (худшая для слота)</td><td>${p.temp}</td></tr>
        ${levels.map(([n, l]) => `<tr><td>${n}</td><td>${l ?? "—"}</td></tr>`).join("")}
        ${v.ships && v.ships.count !== Infinity ? `<tr><td>Свободно в трюме одного корабля</td><td>${fmt(v.ships.free)}</td></tr>` : ""}
        ${v.routes.map(rt => `<tr><td>Полёт из ${esc(rt.from.coords)}${rt.from.name ? " " + esc(rt.from.name) : ""}</td><td>${duration(rt.seconds)}</td></tr>`).join("")}
        ${t ? `<tr><td>Технологии цели${task.own ? " (мои)" : ""}: оружие / щиты / броня</td><td>${t["Оружейная технология"]} / ${t["Щитовая технология"]} / ${t["Броня космических кораблей"]}</td></tr>` : ""}
        ${unitTable("Флот", r.fleet)}
        ${unitTable("Оборона", r.defense)}
      </table>
    </details>
  </article>`;
}

function renderTargets(now) {
  const all = Object.values(targets);
  const origin = distOrigin();
  // Без своих планет подбирать не для чего — как «Все цели».
  const forPlanet = settings.filter === "planet" && origin;
  // Только неактивные: активных, удалённых и исчезнувшие по карте планеты не показываем ни в одном фильтре —
  // кроме режима «Показать скрытые» (только они: проверить и вернуть статус).
  const inactive = all.filter(r => raidable(seen(r.coords, r.time)) !== settings.showHidden);
  const hidden = settings.showHidden ? 0 : all.length - inactive.length;
  const views = inactive.map(r => targetView(r, now, origin))
    .filter(v => forPlanet ? fitsPlanet(v, origin)
      : settings.filter === "all" || settings.filter === "planet" || (settings.filter === "guarded") === guarded(v))
    .filter(v => !settings.onlyFull || v.full.some(Boolean))
    .filter(v => !settings.onlyIncomplete || v.report.detailsUnknown)
    .filter(v => v.total >= settings.minLoot * 1000)
    .filter(v => v.deut >= settings.minDeut * 1000)
    .sort((forPlanet ? SORTS.distance : SORTS[settings.sort] || SORTS.loot).compare);
  const pages = Math.max(1, Math.ceil(views.length / settings.pageSize));
  page = Math.min(Math.max(1, page), pages);
  const from = (page - 1) * settings.pageSize;
  const shown = views.slice(from, from + settings.pageSize);

  $("filter-count").textContent = (views.length
    ? `${fmt(from + 1)}–${fmt(from + shown.length)} из ${fmt(views.length)}` + (views.length < all.length ? ` (всего ${fmt(all.length)})` : "")
    : "") + (hidden ? ` · скрыто активных и исчезнувших: ${fmt(hidden)}` : "");
  $("pager").hidden = pages < 2;
  $("page").innerHTML = Array.from({ length: pages }, (_, i) => `<option value="${i + 1}">${i + 1} из ${pages}</option>`).join("");
  $("page").value = page;
  $("page-prev").disabled = page <= 1;
  $("page-next").disabled = page >= pages;

  $("targets").innerHTML = shown.length ? shown.map(v => card(v, now)).join("")
    : all.length ? `<p class="empty">Нет целей для выбранных фильтров.</p>`
    : `<p class="empty">${db ? "Пока нет отчётов. Вставьте шпионский доклад выше — здесь появится, сколько ресурсов вы заберёте и сколько лететь." : "Загрузка…"}</p>`;
}

// ---- Мои данные ----

// Уровни шахт своей планеты: поле в настройках и подпись.
const MINE_FIELDS = [["metal", "Металл"], ["crystal", "Кристалл"], ["deut", "Дейтерий"]];

function renderPlanets() {
  $("planets").innerHTML = settings.planets.length
    ? settings.planets.map((p, i) => `<div class="card planet">
        <div class="row">
          <input class="num" value="${esc(p.coords)}" data-planet="${i}" data-field="coords" aria-label="Координаты" inputmode="numeric">
          <input value="${esc(p.name || "")}" data-planet="${i}" data-field="name" placeholder="Название" aria-label="Название">
          <button class="danger" data-delete-planet="${i}" aria-label="Удалить ${esc(p.coords)}">Удалить</button>
        </div>
        <div class="grid4">
          ${MINE_FIELDS.map(([f, name]) => `<label>${name} <input type="number" min="0" value="${p[f] || 0}"
            data-planet="${i}" data-field="${f}" inputmode="numeric"></label>`).join("")}
          <label>Темп., °C <input type="number" step="any" value="${p.temp ?? ""}" data-planet="${i}" data-field="temp"
            placeholder="${SK.SLOT_TEMP[SK.parseCoords(p.coords).p]}" title="Средняя температура. Пусто — худшая для слота"></label>
        </div></div>`).join("")
    : `<p class="empty">Добавьте планеты, с которых летаете: время полёта считается от ближайшей.</p>`;
}

const hours = h => !isFinite(h) ? "—" : h < 48 ? h.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " ч"
  : `${fmt(h / 24)} д ${Math.floor(h % 24)} ч`;

function renderMines() {
  $("mines-toggle").textContent = settings.minesOpen ? "Скрыть топ-20" : "Показать топ-20";
  $("mines-toggle").setAttribute("aria-expanded", settings.minesOpen);
  $("mines").hidden = !settings.minesOpen;
  if (!settings.minesOpen) return;
  const b = settings.prodBonus;
  const bonus = 1 + (b.premium ? 0.5 : 0) + (b.alliance + b.stations) / 100;
  $("bonus-premium").checked = b.premium;
  $("bonus-alliance").value = b.alliance;
  $("bonus-stations").value = b.stations;
  $("colonization").value = settings.colonization;
  $("bonus-total").textContent = `Выработка ×${bonus.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}: окупаемость ниже уже с бонусами.`;
  // Пустая температура — худшая для слота, как у целей.
  const planets = settings.planets.map(p => ({
    label: p.name || p.coords,
    levels: MINE_FIELDS.map(([f]) => p[f] || 0),
    temp: p.temp ?? SK.SLOT_TEMP[SK.parseCoords(p.coords).p],
  }));
  const top = SK.nextMines(planets, 20, bonus);
  $("mines-body").innerHTML = planets.length
    ? top.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.planet.label)}</td><td>${r.mine} ${r.level}</td>
        <td>${fmtShort(r.cost[0])} / ${fmtShort(r.cost[1])}</td><td>${fmtShort(r.deut)}</td><td>${hours(r.hours)}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">Добавьте свои планеты ниже, с уровнями шахт и температурой.</td></tr>`;
  renderColonyAdvice(planets, top[0], bonus);
}

/** Пора ли изучать следующий уровень колонизации: окупаемость новой колонии против лучшей шахты на старых планетах. */
function renderColonyAdvice(planets, bestMine, bonus) {
  const el = $("colony-advice");
  if (!planets.length || !bestMine) { el.textContent = ""; return; }
  // Колонию считаем на самой холодной своей планете: так обычно и выбирают позицию (больше дейтерия).
  const temp = Math.min(...planets.map(p => p.temp));
  const c = SK.colonyPlan(settings.colonization + 1, temp, bonus);
  const plan = `Колонизация ${c.level}: технология ${fmtShort(c.tech)} в дейтерии, с шахтами колонии до ${c.levels.join(" / ")} — `
    + `${fmtShort(c.cost)}, доход ${fmtShort(c.income)} дейтерия в час, окупаемость ${hours(c.hours)}.`;
  const due = bestMine.hours >= c.hours;
  el.className = due ? "status ok" : "muted";
  el.textContent = due
    ? `Пора изучать колонизацию ${c.level}: лучшая шахта окупается за ${hours(bestMine.hours)}, а новая колония — быстрее. ${plan}`
    : `Колонизация ${c.level} пока не выгодна: шахты окупаются быстрее (лучшая — ${hours(bestMine.hours)}). `
      + `Изучать, когда окупаемость лучшей шахты дойдёт до ${hours(c.hours)}. ${plan}`;
}

/** Сумма в металле со знаком: выгода бывает отрицательной. */
const money = n => (n < 0 ? "−" : "") + fmtShort(Math.abs(n));

// ---- Самый дешёвый флот (cheapest.js) ----

const CHEAP_SHOWN = 5;  // столько лучших составов показываем
let cheapData = null;   // Promise { excluded, table } — справочник и исключённые составы, грузятся один раз
let cheapPool = null;   // идёт подбор: потоки cheapest-worker.js

/** Своя планета, с которой лететь: выбранная или первая. */
const cheapOrigin = () => settings.planets.find(p => p.coords === settings.cheapFrom) || settings.planets[0];

function renderCheap() {
  $("cheap-from").innerHTML = settings.planets.length
    ? settings.planets.map(p => `<option value="${esc(p.coords)}">${esc(p.coords)}${p.name ? " " + esc(p.name) : ""}</option>`).join("")
    : `<option value="">Добавьте свои планеты</option>`;
  $("cheap-from").value = cheapOrigin()?.coords ?? "";
}

/** Распаковать gzip (сервер мог уже распаковать сам — тогда байты как есть); null — браузер не умеет. */
async function gunzip(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream === "undefined") return null;
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

/** Справочник симуляций и исключённые составы; без справочника подбор стартует со всей сетки (дольше). */
function loadCheapData() {
  const get = (url, how) => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r[how](); });
  cheapData ||= Promise.all([get("excluded-mixes.json", "json"), get("dominance-top.bin.gz", "arrayBuffer").then(gunzip)])
    .then(([ex, bytes]) => ({ excluded: new Set(ex.mixes), table: bytes && CHEAPEST.table(bytes) }))
    .catch(e => { cheapData = null; throw e; });
  return cheapData;
}

/**
 * Потоки для оценки флотов цели cfg: { run(флоты, боёв) → Promise оценок, size, close() }. Флоты раздаются
 * из общей очереди свободным потокам; после close() ждущие оценки отклоняются.
 */
function cheapWorkers(cfg) {
  const size = Math.min(8, navigator.hardwareConcurrency || 4), queue = [], idle = [], busy = new Map();
  let closed = false, nextId = 0;
  const give = w => {
    const task = queue.shift();
    if (!task) { idle.push(w); return; }
    busy.set(w, task);
    w.postMessage({ id: nextId++, fleet: task.fleet, runs: task.runs });
  };
  const workers = Array.from({ length: size }, () => {
    const w = new Worker("cheapest-worker.js");
    w.postMessage({ cfg });
    w.onmessage = ({ data }) => {
      const task = busy.get(w);
      busy.delete(w);
      if (data.error) task.reject(new Error(data.error)); else task.resolve(data.r);
      give(w);
    };
    w.onerror = e => { e.preventDefault(); busy.get(w)?.reject(new Error(e.message || "ошибка потока")); busy.delete(w); give(w); };
    idle.push(w);
    return w;
  });
  const run = (fleets, runs) => Promise.all(fleets.map(fleet => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("остановлено")); return; }
    queue.push({ fleet, runs, resolve, reject });
    if (idle.length) give(idle.pop());
  })));
  const close = () => {
    closed = true;
    workers.forEach(w => w.terminate());
    for (const t of [...queue, ...busy.values()]) t.reject(new Error("остановлено"));
    queue.length = 0;
    busy.clear();
  };
  return { run, size, close };
}

/** Входные данные подбора по отчёту (cheapest.js: best); строка — что не так. */
function cheapConfig(r) {
  const from = cheapOrigin();
  if (!from) return "Добавьте свою планету в «Моих планетах».";
  if (r.detailsUnknown) return "Неполный отчёт: оборона и флот цели неизвестны.";
  const defense = {};
  for (const sec of [r.defense, r.fleet])
    for (const [n, k] of Object.entries(sec || {})) if (k > 0 && BATTLE.UNITS[n] && !SK.HARMLESS.has(n)) defense[n] = k;
  if (!Object.keys(defense).length) return "У цели нет ни обороны, ни флота — нападать можно любым флотом.";
  const own = !Object.keys(r.research || {}).length;
  return {
    to: r.coords, speed: settings.speed, own,
    attacker: { techs: myTechs(), premium: settings.premium },
    // Премиума у цели не бывает.
    defender: { techs: own ? myTechs() : Object.fromEntries(BATTLE.TECHS.map(t => [t, r.research[t] || 0])) },
    defense, available: {}, half: [0, 0, 0],
    dists: [SK.distance(SK.parseCoords(from.coords), SK.parseCoords(r.coords))],
  };
}

function stopCheap() {
  cheapPool?.close();
  cheapPool = null;
  $("cheap-run").disabled = false;
  $("cheap-stop").hidden = true;
}

/** Подбор по отчёту r (вставленному или сохранённому). */
async function runCheap(r) {
  const cfg = cheapConfig(r);
  $("cheap-results").innerHTML = "";
  $("cheap-target").textContent = "";
  if (typeof cfg === "string") { setStatus("cheap-status", cfg, "err"); return; }
  if (typeof Worker === "undefined") { setStatus("cheap-status", "Браузер не умеет считать в фоне.", "err"); return; }
  stopCheap();
  const t = cfg.defender.techs;
  $("cheap-target").textContent = `Цель ${r.coords}, отчёт ${dateTime(r.time)}: оборона и флот ${fmtShort(ATTACK.defenseCost(cfg.defense))}, `
    + `дистанция ${fmt(cfg.dists[0])}; технологии цели ${cfg.own ? "— мои (в отчёте их нет)" : `оружие ${t["Оружейная технология"]}, щиты ${t["Щитовая технология"]}, броня ${t["Броня космических кораблей"]}`}.`;
  $("cheap-run").disabled = true;
  $("cheap-stop").hidden = false;
  const started = Date.now(), seconds = () => Math.round((Date.now() - started) / 1000);
  setStatus("cheap-status", "Загружаю справочник…");
  const pool = cheapPool = cheapWorkers(cfg);
  try {
    const data = await loadCheapData();
    if (pool !== cheapPool) return;
    const env = { ...pool, ...data, log: text => { if (pool === cheapPool) setStatus("cheap-status", `Считаю, ${seconds()} с: ${text.split("\n")[0]}`); } };
    const res = await CHEAPEST.best(cfg, env);
    if (pool !== cheapPool) return;
    stopCheap();
    setStatus("cheap-status", `Готово за ${seconds()} с${data.table ? "" : " (без справочника: браузер не распаковал его, перебрана вся сетка)"}.`, "ok");
    renderCheapResults(res);
  } catch (e) {
    if (pool !== cheapPool) return;  // остановлено или начат новый подбор
    stopCheap();
    setStatus("cheap-status", "Ошибка расчёта: " + (e?.message || e), "err");
  }
}

function cheapCard(title, c) {
  const r = c.r, a = r.at[0];
  const list = obj => Object.entries(obj).map(([n, k]) => `${esc(n)} <span class="num">${k}</span>`).join(", ");
  const lost = Object.fromEntries(Object.entries(r.lost).filter(([, v]) => v >= 0.05)
    .map(([n, v]) => [n, v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })]));
  return `<article class="card">
    <div class="spread"><span><b>${title}</b> <span class="profit">${money(r.net)}</span> <span class="muted">чистые потери</span></span>
      <span class="pill ${r.win >= 0.95 ? "ok" : "warn"}">победа ${Math.round(r.win * 100)}%</span></div>
    <div>${esc(c.share)}</div>
    <div class="route">${list(Object.fromEntries(Object.entries(c.fleet).map(([n, k]) => [n, fmt(k)])))}</div>
    <div class="muted" style="font-size:13px">потери флота ${money(r.loss)} + топливо ${money(a.fuel)} − обломки ${money(r.debris)}
      + топливо переработчиков ${money(a.recFuel)}${a.recyclers ? ` (переработчиков ${fmt(Math.ceil(a.recyclers))})` : ""}</div>
    ${Object.keys(lost).length ? `<div class="muted" style="font-size:13px">гибнет в среднем: ${list(lost)}</div>` : ""}
    <div class="muted" style="font-size:13px">${c.verified ? `проверено 100 боями: ±${money(r.sd)}, модель ${money(c.model.net)}` : "по модели боя, без проверки боями"}</div>
  </article>`;
}

function renderCheapResults({ top, ds, start, refs }) {
  const shown = top.slice(0, CHEAP_SHOWN);
  $("cheap-results").innerHTML = (shown.length
    ? shown.map((c, i) => cheapCard(`${i + 1}.`, c)).join("")
    : `<p class="empty">Без звёзд смерти ни один флот не побеждает в 90% боёв даже за 100× стоимости обороны.</p>`)
    + (ds ? cheapCard("Только звёзды смерти:", ds) : `<p class="empty">Одни звёзды смерти не побеждают в 90% боёв.</p>`)
    + (start ? `<details><summary>Справочник: похожие обороны и стартовые составы</summary><table>
        <tr><td colspan="2"><b>Ближайшие обороны сетки (дистанция ${refs.distSystems} систем)</b></td></tr>
        ${refs.near.map(x => `<tr><td>${esc(x.key)}</td><td>L1 ${x.l1.toFixed(2)}</td></tr>`).join("")}
        <tr><td colspan="2"><b>Стартовые составы</b></td></tr>
        ${start.map(x => `<tr><td>${esc(x.key)}</td><td>отставание ~${(x.gap * 100).toFixed(1)}%</td></tr>`).join("")}
      </table></details>` : "");
}

/** Подбор по вставленному отчёту; флот и оборону неполного отчёта берём из сохранённого по этой цели. */
function runCheapFromText() {
  const [fresh] = SK.parseReports($("cheap-report").value);
  if (!fresh) { setStatus("cheap-status", "Не нашёл отчёт: нужен текст «Шпионский доклад с … [г:с:п] от …».", "err"); return; }
  runCheap(SK.mergeReport(targets[fresh.coords], fresh) || targets[fresh.coords]);
}

// ---- Активные игроки (по карте галактики) ----

const ACTIVE_PAGE = 10;
const activeOrigin = () => settings.planets.find(p => p.coords === settings.activeFrom) || settings.planets[0];
const byCoordsStr = (a, b) => { const x = SK.parseCoords(a), y = SK.parseCoords(b); return x.g - y.g || x.s - y.s || x.p - y.p; };

/**
 * Планеты активных игроков, кроме своих (свой ник — владелец своих планет на карте), удалённых
 * и станций альянсов (без игрока; ручная правка без игрока — показываем).
 */
function activePlanets() {
  const mine = new Set(settings.planets.map(p => galaxy.planets[p.coords]?.player).filter(Boolean));
  return Object.entries(galaxy.planets).map(([coords, p]) => ({ coords, ...p, player: p.player || "" }))
    .filter(p => (p.player || p.manual) && !p.deleted && !isInactive(p.status) && !mine.has(p.player));
}

function renderActive() {
  const systems = Object.values(galaxy.systems), planets = Object.keys(galaxy.planets).length;
  $("galaxy-info").textContent = systems.length
    ? `Карта: ${fmt(systems.length)} систем, ${fmt(planets)} планет, просмотрена ${dateTime(Math.min(...systems))} – ${dateTime(Math.max(...systems))}.`
    : "Карты галактики пока нет: бот сканирует системы (node bot/sk.js scan …, затем push), файл загружается в «Резервной копии» → «Добавить из файла».";
  const origin = activeOrigin(), byDist = settings.activeSort === "distance" && !!origin;
  $("active-sort").value = settings.activeSort;
  $("active-from").hidden = !byDist;
  $("active-from").innerHTML = settings.planets.map(p =>
    `<option value="${esc(p.coords)}">от ${esc(p.coords)}${p.name ? " " + esc(p.name) : ""}</option>`).join("");
  if (origin) $("active-from").value = origin.coords;
  $("active-strong").checked = settings.activeStrong;
  $("active-noob").checked = settings.activeNoob;
  if (document.activeElement !== $("active-player")) $("active-player").value = settings.activePlayer;

  const all = activePlanets();
  $("active-players").innerHTML = [...new Set(all.map(p => p.player))].sort().map(n => `<option value="${esc(n)}">`).join("");
  const name = settings.activePlayer.trim().toLowerCase();
  const at = origin && SK.parseCoords(origin.coords);
  const list = all
    .filter(p => !name || p.player.toLowerCase().includes(name))
    .filter(p => (settings.activeStrong || !(p.status || "").includes("S")) && (settings.activeNoob || !(p.status || "").includes("N")))
    .map(p => ({ ...p, dist: at && SK.distance(at, SK.parseCoords(p.coords)) }))
    .sort(byDist ? (a, b) => a.dist - b.dist || byCoordsStr(a.coords, b.coords) : (a, b) => byCoordsStr(a.coords, b.coords));
  const pages = Math.max(1, Math.ceil(list.length / ACTIVE_PAGE));
  activePage = Math.min(Math.max(1, activePage), pages);
  const from = (activePage - 1) * ACTIVE_PAGE, shown = list.slice(from, from + ACTIVE_PAGE);
  const players = new Set(list.map(p => p.player)).size;
  $("active-count").textContent = list.length
    ? `${fmt(from + 1)}–${fmt(from + shown.length)} из ${fmt(list.length)} планет, игроков ${fmt(players)}` : "";
  $("active-pager").hidden = pages < 2;
  $("active-page").textContent = `${activePage} из ${pages}`;
  $("active-prev").disabled = activePage <= 1;
  $("active-next").disabled = activePage >= pages;
  $("active").innerHTML = shown.length ? shown.map(p => `<div class="item" style="flex-wrap:wrap">
      <span class="grow"><b class="num">${esc(p.coords)}</b> ${esc(p.planet || "")}
        ${p.moon ? '<span class="pill">луна</span>' : ""} ${p.debris ? '<span class="pill">обломки</span>' : ""}<br>
        <span class="muted">${esc(p.player || "—")}${p.status ? ` (${esc(p.status)})` : ""}${p.alliance ? " · " + esc(p.alliance) : ""}</span></span>
      <span class="muted num" style="font-size:13px;text-align:right">${byDist ? `${fmt(p.dist)}<br>` : ""}${dateTime(p.manual || p.at)}${p.manual ? "<br>вручную" : ""}</span>
      <div style="flex-basis:100%">${statusEditor(p.coords)}</div>
    </div>`).join("")
    : `<p class="empty">${all.length ? "Нет планет для выбранных фильтров." : "Нет данных об активных игроках."}</p>`;
}

function renderSettings() {
  for (const d of Object.keys(SK.DRIVES)) $("eng-" + d).value = settings.engines[d] ?? 0;
  $("ship").innerHTML = settings.ships.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("ship").value = currentShip().id;
  $("speed").value = settings.speed;
  $("loot").value = settings.loot;
  $("filter").value = settings.filter;
  $("sort").value = settings.sort;
  $("only-full").checked = settings.onlyFull;
  $("only-incomplete").checked = settings.onlyIncomplete;
  $("show-hidden").checked = settings.showHidden;
  $("min-loot").value = settings.minLoot || "";
  $("min-deut").value = settings.minDeut || "";
  const origin = distOrigin();
  const forPlanet = settings.filter === "planet" && !!origin;
  $("sort").disabled = forPlanet;  // подходящие для планеты — всегда по расстоянию от неё
  $("dist-from").hidden = !(settings.sort === "distance" || forPlanet) || !origin;
  $("dist-from").innerHTML = settings.planets.map(p =>
    `<option value="${esc(p.coords)}">от ${esc(p.coords)}${p.name ? " " + esc(p.name) : ""}</option>`).join("");
  if (origin) $("dist-from").value = origin.coords;
  $("page-size").value = settings.pageSize;
  $("techs").innerHTML = MY_TECHS.map(t => `<label>${t.replace(/ (технология|космических кораблей)$/, "")}
    <input type="number" min="0" value="${settings.techs[t] || 0}" data-tech="${t}" inputmode="numeric"></label>`).join("");
  $("premium").checked = settings.premium;
  const driveOptions = sel => Object.entries(SK.DRIVES)
    .map(([k, d]) => `<option value="${k}"${k === sel ? " selected" : ""}>${d.name}</option>`).join("");
  $("ships").innerHTML = settings.ships.map(s => `<div class="card ship">
      <div class="spread"><input value="${esc(s.name)}" data-ship="${esc(s.id)}" data-field="name" aria-label="Название корабля" style="flex:1 1 0">
        ${settings.ships.length > 1 ? `<button class="danger" data-delete-ship="${esc(s.id)}">Удалить</button>` : ""}</div>
      <div class="grid2">
        <label>Двигатель <select data-ship="${esc(s.id)}" data-field="drive">${driveOptions(s.drive)}</select></label>
        <label>Базовая скорость <input type="number" min="1" value="${s.base}" data-ship="${esc(s.id)}" data-field="base" inputmode="numeric"></label>
        <label>Трюм <input type="number" min="0" value="${s.capacity}" data-ship="${esc(s.id)}" data-field="capacity" inputmode="numeric"></label>
        <label>Расход топлива <input type="number" min="0" value="${s.consumption}" data-ship="${esc(s.id)}" data-field="consumption" inputmode="numeric"></label>
      </div>
      <div class="muted" style="font-size:13px">Скорость с двигателями: <span class="num">${fmt(SK.shipSpeed(s, settings.engines))}</span></div>
    </div>`).join("");
}

function renderBackupReminder(now) {
  const b = settings.backup;
  const due = b.changedAt > b.at && now - b.at > BACKUP_EVERY && now > b.snoozeUntil;
  $("backup-reminder").hidden = !due;
  if (due) $("backup-age").textContent = `Резервной копии нет ${Math.floor((now - b.at) / (24 * 3.6e6))} дн., а данные с тех пор менялись.`;
}

function render() {
  const now = Date.now();
  $("clock").textContent = clock(now);
  renderBackupReminder(now);
  renderTargets(now);
  renderPlanets();
  renderMines();
  renderSettings();
  renderCheap();
  renderActive();
}

// Таймер обновляет только цели: поля ввода ниже не перерисовываются, пока их редактируют.
function tick() {
  const now = Date.now();
  $("clock").textContent = clock(now);
  renderBackupReminder(now);
  renderTargets(now);
}

// ---- Отчёты и свои данные ----

/**
 * Добавить отчёты: по каждой планете остаётся самый свежий.
 * Возвращает записи для сохранения и координаты с пометкой «добавлено» или «изменено».
 */
function mergeReports(reports) {
  const changes = new Map();
  // Старые отчёты раньше: в пакете может быть несколько отчётов по одной планете.
  for (const r of [...reports].sort((a, b) => a.time - b.time)) {
    const old = targets[r.coords];
    const merged = SK.mergeReport(old, r);
    if (!merged) continue;
    if (!changes.has(r.coords)) changes.set(r.coords, old ? "изменено" : "добавлено");
    targets[r.coords] = merged;
  }
  return { put: [...changes.keys()].map(c => targets[c]), changes };
}

function processReports(text) {
  const reports = SK.parseReports(text);
  $("report-changes").hidden = true;
  if (!reports.length) {
    setStatus("report-status", "Не нашёл отчёт. Текст должен содержать «Шпионский доклад с … [г:с:п] от …».", "err");
    return false;
  }
  const { put, changes } = mergeReports(reports);
  const skipped = reports.length - put.length;
  setStatus("report-status", `Отчётов: ${reports.length}, сохранено целей: ${put.length}`
    + (skipped ? `, пропущено (есть отчёт новее, такой же или повтор в пакете): ${skipped}` : "") + ".", put.length ? "ok" : "err");
  $("report-changes").textContent = [...changes].map(([c, mark]) => `${c} ${mark}`).join("\n");
  $("report-changes").hidden = !changes.size;
  if (put.length) save({ put });
  return put.length > 0;
}

$("report-save").addEventListener("click", () => {
  if (processReports($("report-text").value)) $("report-text").value = "";
});
$("report-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) processReports(await file.text());
});

$("planet-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("planet-coords"), coords = input.value.trim();
  if (!SK.parseCoords(coords)) { input.setCustomValidity("Формат: галактика:система:планета, например 8:306:4"); input.reportValidity(); return; }
  if (settings.planets.some(p => p.coords === coords)) { input.setCustomValidity("Эта планета уже в списке"); input.reportValidity(); return; }
  settings.planets.push({ coords, name: $("planet-name").value.trim() });
  input.value = $("planet-name").value = "";
  save();
});
document.addEventListener("input", e => e.target.setCustomValidity?.(""));

// Правка своих планет и кораблей прямо в списке: сохраняется при выходе из поля.
document.addEventListener("change", e => {
  const el = e.target, field = el.dataset.field;
  if (el.dataset.planet !== undefined) {
    const value = el.value.trim();
    if (field === "coords" && !SK.parseCoords(value)) {
      el.setCustomValidity("Формат: галактика:система:планета, например 8:306:4");
      el.reportValidity();
      return;
    }
    settings.planets[+el.dataset.planet][field] = field === "temp" ? (value === "" ? null : +value)
      : MINE_FIELDS.some(([f]) => f === field) ? Math.max(0, Math.floor(+value || 0)) : value;
    save();
  } else if (el.dataset.tech) {
    settings.techs[el.dataset.tech] = Math.max(0, Math.floor(+el.value || 0));
    save();
  } else if (el.dataset.ship) {
    const ship = settings.ships.find(s => s.id === el.dataset.ship);
    ship[field] = ["base", "capacity", "consumption"].includes(field) ? Math.max(0, +el.value || 0) : el.value.trim();
    save();
  } else if (el.dataset.mark) {
    markPlanet(el.dataset.markCoords, el.dataset.mark, el.checked);
  }
});

for (const d of Object.keys(SK.DRIVES)) {
  $("eng-" + d).addEventListener("change", e => { settings.engines[d] = Math.max(0, +e.target.value || 0); save(); });
}
$("ship").addEventListener("change", e => { settings.shipId = e.target.value; save(); });
$("premium").addEventListener("change", e => { settings.premium = e.target.checked; save(); });
$("speed").addEventListener("change", e => { settings.speed = +e.target.value; save(); });
$("loot").addEventListener("change", e => { settings.loot = Math.min(100, Math.max(1, +e.target.value || 50)); save(); });

// Вид списка: сбрасывает на первую страницу и не считается изменением данных.
const view = patch => { Object.assign(settings, patch); page = 1; save({ changed: false }); };
$("filter").addEventListener("change", e => view({ filter: e.target.value }));
$("sort").addEventListener("change", e => view({ sort: e.target.value }));
$("dist-from").addEventListener("change", e => view({ distFrom: e.target.value }));
$("only-full").addEventListener("change", e => view({ onlyFull: e.target.checked }));
$("only-incomplete").addEventListener("change", e => view({ onlyIncomplete: e.target.checked }));
$("show-hidden").addEventListener("change", e => view({ showHidden: e.target.checked }));
$("min-loot").addEventListener("change", e => view({ minLoot: Math.max(0, +e.target.value || 0) }));
$("min-deut").addEventListener("change", e => view({ minDeut: Math.max(0, +e.target.value || 0) }));
$("page-size").addEventListener("change", e => view({ pageSize: +e.target.value }));
$("bonus-premium").addEventListener("change", e => { settings.prodBonus.premium = e.target.checked; save(); });
for (const k of ["alliance", "stations"]) {
  $(`bonus-${k}`).addEventListener("change", e => { settings.prodBonus[k] = Math.max(0, +e.target.value || 0); save(); });
}
$("colonization").addEventListener("change", e => { settings.colonization = Math.max(0, Math.floor(+e.target.value || 0)); save(); });
$("mines-toggle").addEventListener("click",() => { settings.minesOpen = !settings.minesOpen; save({ changed: false }); });
$("cheap-from").addEventListener("change", e => { settings.cheapFrom = e.target.value; save({ changed: false }); });
$("cheap-run").addEventListener("click", runCheapFromText);
$("cheap-stop").addEventListener("click", () => { stopCheap(); setStatus("cheap-status", "Остановлено."); });

const goToPage = n => { page = n; tick(); $("h-targets").scrollIntoView({ block: "start" }); };
$("page").addEventListener("change", e => goToPage(+e.target.value));
$("page-prev").addEventListener("click", () => goToPage(page - 1));
$("page-next").addEventListener("click", () => goToPage(page + 1));

const activeView = patch => { Object.assign(settings, patch); activePage = 1; save({ changed: false }); };
$("active-sort").addEventListener("change", e => activeView({ activeSort: e.target.value }));
$("active-from").addEventListener("change", e => activeView({ activeFrom: e.target.value }));
$("active-strong").addEventListener("change", e => activeView({ activeStrong: e.target.checked }));
$("active-noob").addEventListener("change", e => activeView({ activeNoob: e.target.checked }));
// Ник фильтрует на лету, без перерисовки остальной страницы; сохраняется при выходе из поля.
$("active-player").addEventListener("input", e => { settings.activePlayer = e.target.value; activePage = 1; renderActive(); });
$("active-player").addEventListener("change", () => save({ changed: false }));
const goToActivePage = n => { activePage = n; renderActive(); $("h-active").scrollIntoView({ block: "start" }); };
$("active-prev").addEventListener("click", () => goToActivePage(activePage - 1));
$("active-next").addEventListener("click", () => goToActivePage(activePage + 1));

$("ship-add").addEventListener("click", () => {
  settings.ships.push({ id: "s" + Date.now(), name: "Новый корабль", drive: "combustion", base: 1, capacity: 0, consumption: 0 });
  save();
});

document.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  // Удаление — в два нажатия: первое меняет надпись кнопки.
  const confirmDelete = () => {
    if (t.dataset.armed) return true;
    t.dataset.armed = "1";
    t.textContent = "Точно удалить?";
    return false;
  };
  if (t.dataset.deleteTarget && confirmDelete()) {
    delete targets[t.dataset.deleteTarget];
    save({ remove: [t.dataset.deleteTarget] });
  }
  if (t.dataset.cheapest && targets[t.dataset.cheapest]) {
    runCheap(targets[t.dataset.cheapest]);
    $("h-cheapest").scrollIntoView({ block: "start" });
  }
  if (t.dataset.deletePlanet && confirmDelete()) { settings.planets.splice(+t.dataset.deletePlanet, 1); save(); }
  if (t.dataset.deleteShip && confirmDelete()) {
    settings.ships = settings.ships.filter(s => s.id !== t.dataset.deleteShip);
    if (!settings.ships.some(s => s.id === settings.shipId)) settings.shipId = settings.ships[0].id;
    save();
  }
});

for (const list of ["targets", "active"]) $(list).addEventListener("toggle", e => {
  const { coords, edit } = e.target.dataset;
  if (coords) e.target.open ? openDetails.add(coords) : openDetails.delete(coords);
  if (edit) e.target.open ? openEdits.add(edit) : openEdits.delete(edit);
}, true);

// ---- Резервная копия файлом ----

function backupFile() {
  const d = new Date();
  const name = `space-kings-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  const data = JSON.stringify({ format: "space-kings-recon", version: 2, exportedAt: d.getTime(), settings, targets: Object.values(targets), galaxy });
  return new File([data], name, { type: "application/json" });
}

function markBackup() {
  settings.backup.at = Date.now();
  save({ changed: false });
}

function downloadBackup() {
  const file = backupFile();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus("data-status", `Файл ${file.name} (${(file.size / 1048576).toFixed(1)} МБ) сохранён в «Загрузки».`, "ok");
  markBackup();
}

async function shareBackup() {
  const file = backupFile();
  try {
    await navigator.share({ files: [file], title: file.name });
    setStatus("data-status", `Файл ${file.name} отправлен.`, "ok");
    markBackup();
  } catch (e) {
    if (e?.name !== "AbortError") setStatus("data-status", "Не удалось поделиться файлом. Используйте «Скачать файл».", "err");
  }
}

/**
 * Резервная копия этой версии или старой (JSON из поля «Показать JSON»). Файл карты от бота (bot/sk.js push) —
 * тот же формат без настроек и отчётов, только с galaxy.
 */
function readBackup(text) {
  const data = JSON.parse(text);
  if (data?.format === "space-kings-recon" && Array.isArray(data.targets))
    return { settings: data.settings, targets: data.targets, galaxy: data.galaxy };
  if (data && typeof data.targets === "object" && Array.isArray(data.planets)) {
    const { targets: t, ...rest } = data;
    return { settings: rest, targets: Object.values(t) };
  }
  throw new Error("not a backup");
}

$("backup-download").addEventListener("click", downloadBackup);
$("backup-now").addEventListener("click", downloadBackup);
$("backup-share").addEventListener("click", shareBackup);
$("backup-share").hidden = !navigator.canShare?.({ files: [new File(["{}"], "x.json", { type: "application/json" })] });
$("backup-later").addEventListener("click", () => { settings.backup.snoozeUntil = Date.now() + SNOOZE; save({ changed: false }); });

$("backup-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  $("import-actions").hidden = true;
  if (!file) return;
  try {
    pendingImport = readBackup(await file.text());
    $("import-actions").hidden = false;
    // Без настроек (файл карты) заменять нечем: «Заменить» стёрло бы свои планеты.
    $("import-replace").hidden = !pendingImport.settings;
    const systems = Object.keys(pendingImport.galaxy?.systems || {}).length;
    setStatus("data-status", `В файле ${fmt(pendingImport.targets.length)} целей, ${pendingImport.settings?.planets?.length ?? 0} своих планет`
      + `${systems ? `, карта ${fmt(systems)} систем` : ""}.`);
  } catch {
    pendingImport = null;
    setStatus("data-status", "Это не резервная копия «Разведки». Выберите файл, скачанный кнопкой «Скачать файл».", "err");
  }
});

$("import-merge").addEventListener("click", () => {
  const { put } = mergeReports(pendingImport.targets);
  const systems = mergeGalaxy(pendingImport.galaxy);
  $("import-actions").hidden = true;
  setStatus("data-status", `Добавлено и обновлено отчётов: ${fmt(put.length)}, систем и правок карты: ${fmt(systems)}. `
    + "Свои планеты и настройки не менялись.", "ok");
  pendingImport = null;
  save({ put, map: systems > 0 });
});

$("import-replace").addEventListener("click", () => {
  settings = normalizeSettings(pendingImport.settings);
  targets = Object.fromEntries(pendingImport.targets.map(r => [r.coords, r]));
  // В старых копиях карты нет — тогда остаётся своя.
  const map = !!pendingImport.galaxy;
  if (map) galaxy = pendingImport.galaxy;
  $("import-actions").hidden = true;
  setStatus("data-status", `Все данные заменены данными из файла${map ? "" : " (карты в нём нет — карта галактики осталась прежней)"}.`, "ok");
  pendingImport = null;
  page = activePage = 1;
  save({ clear: true, put: Object.values(targets), map });
});

// ---- Запуск ----

$("speed").innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${100 - i * 10}">${100 - i * 10}%</option>`).join("");
$("filter").innerHTML = Object.entries(FILTERS).map(([k, n]) => `<option value="${k}">${n}</option>`).join("");
$("sort").innerHTML = Object.entries(SORTS).map(([k, o]) => `<option value="${k}">${o.name}</option>`).join("");
$("page-size").innerHTML = PAGE_SIZES.map(n => `<option value="${n}">по ${n}</option>`).join("");
render();
init()
  .then(render)
  .catch(e => setStatus("report-status", `Хранилище браузера недоступно (${e?.name || e}). Данные не сохранятся.`, "err"));
setInterval(tick, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

// Просим браузер не удалять данные при нехватке места.
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
