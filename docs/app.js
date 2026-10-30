// Интерфейс. Данные — в IndexedDB этого браузера: каждый отчёт отдельной записью, настройки — одной.
// Расчёты — core.js, бой и звёзды смерти — battle.js (в фоне, ds-worker.js), подбор атаки — attack.js (в фоне, attack-worker.js).
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
  filter: "all", // all | open | guarded
  onlyFull: false,        // только с полным складом
  onlyIncomplete: false,  // только с неизвестной защитой и постройками
  minLoot: 0,             // добыча от, тыс.; 0 — без ограничения
  minDeut: 0,             // добыча в пересчёте на дейтерий от, тыс.; 0 — без ограничения
  sort: "loot",   // loot | lootOnly | deut | coords | distance
  distFrom: "",   // своя планета, от которой сортировать по расстоянию
  pageSize: 20,
  minesOpen: false,  // показан топ шахт
  attackOpen: false, // показан подбор атаки
  attackFrom: "",    // своя планета, с которой лететь в подборе атаки
  attackDs: true,    // подбирать составы со звёздами смерти
  backup: { at: 0, changedAt: 0, snoozeUntil: 0 },  // напоминание о резервной копии
};
const PAGE_SIZES = [10, 20, 50];
const BACKUP_EVERY = 3 * 24 * 3.6e6;  // напоминать, если копии нет дольше 3 дней
const SNOOZE = 24 * 3.6e6;
const FILTERS = { all: "Все цели", open: "Без защиты", guarded: "С защитой" };
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
let page = 1;
let db = null;
let pendingImport = null;
const openDetails = new Set();  // раскрытые «Расчёт» переживают перерисовку

function normalizeSettings(saved) {
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
  // Корабли из старых версий: без трюма и расхода топлива.
  s.ships = s.ships.map(ship => ({ ...(ship.id === "mega" ? MEGA : { capacity: 0, consumption: 0 }), ...ship }));
  s.backup = { ...DEFAULT_SETTINGS.backup, ...s.backup };
  s.techs = { ...s.techs };
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

/** Одна транзакция: настройки, добавленные и удалённые отчёты; `clear` — сначала стереть все отчёты. */
function write({ put = [], remove = [], clear = false } = {}) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["targets", "meta"], "readwrite");
    const store = tx.objectStore("targets");
    if (clear) store.clear();
    for (const r of put) store.put(r);
    for (const c of remove) store.delete(c);
    tx.objectStore("meta").put(settings, "settings");
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
      <button class="small danger" data-delete-target="${esc(r.coords)}">Удалить</button>
    </div>
    <div class="muted" style="font-size:13px">отчёт ${dateTime(r.time)}, ${age(now - r.time)} назад</div>
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
  const views = all.map(r => targetView(r, now, origin))
    .filter(v => settings.filter === "all" || (settings.filter === "guarded") === guarded(v))
    .filter(v => !settings.onlyFull || v.full.some(Boolean))
    .filter(v => !settings.onlyIncomplete || v.report.detailsUnknown)
    .filter(v => v.total >= settings.minLoot * 1000)
    .filter(v => v.deut >= settings.minDeut * 1000)
    .sort((SORTS[settings.sort] || SORTS.loot).compare);
  const pages = Math.max(1, Math.ceil(views.length / settings.pageSize));
  page = Math.min(Math.max(1, page), pages);
  const from = (page - 1) * settings.pageSize;
  const shown = views.slice(from, from + settings.pageSize);

  $("filter-count").textContent = views.length
    ? `${fmt(from + 1)}–${fmt(from + shown.length)} из ${fmt(views.length)}` + (views.length < all.length ? ` (всего ${fmt(all.length)})` : "")
    : "";
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
  // Пустая температура — худшая для слота, как у целей.
  const planets = settings.planets.map(p => ({
    label: p.name || p.coords,
    levels: MINE_FIELDS.map(([f]) => p[f] || 0),
    temp: p.temp ?? SK.SLOT_TEMP[SK.parseCoords(p.coords).p],
  }));
  $("mines-body").innerHTML = planets.length
    ? SK.nextMines(planets, 20).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.planet.label)}</td><td>${r.mine} ${r.level}</td>
        <td>${fmtShort(r.cost[0])} / ${fmtShort(r.cost[1])}</td><td>${fmtShort(r.deut)}</td><td>${hours(r.hours)}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">Добавьте свои планеты ниже, с уровнями шахт и температурой.</td></tr>`;
}

// ---- Подбор атаки ----

// Поля юнитов цели: оборона и корабли.
const ATTACK_DEFENSE = Object.keys(BATTLE.UNITS).filter(n => ATTACK.DEFENSE.has(n));
const ATTACK_FLEET = Object.keys(BATTLE.UNITS).filter(n => !ATTACK.DEFENSE.has(n));
let attackTechs = null;   // технологии цели из отчёта; null — считаем равными моим
let attackWorker = null;  // идёт подбор
let attackTop = null;     // результат последнего подбора

/** Своя планета, с которой лететь: выбранная или первая. */
const attackOrigin = () => settings.planets.find(p => p.coords === settings.attackFrom) || settings.planets[0];

function renderAttack() {
  $("attack-toggle").textContent = settings.attackOpen ? "Скрыть" : "Показать";
  $("attack-toggle").setAttribute("aria-expanded", settings.attackOpen);
  $("attack").hidden = !settings.attackOpen;
  $("attack-from").innerHTML = settings.planets.length
    ? settings.planets.map(p => `<option value="${esc(p.coords)}">${esc(p.coords)}${p.name ? " " + esc(p.name) : ""}</option>`).join("")
    : `<option value="">Добавьте свои планеты</option>`;
  $("attack-from").value = attackOrigin()?.coords ?? "";
  $("attack-ds").checked = settings.attackDs;
}

function attackUnitFields() {
  const field = n => `<label>${esc(n)} <input type="number" min="0" class="num" data-attack-unit="${esc(n)}" inputmode="numeric" placeholder="0"></label>`;
  $("attack-defense").innerHTML = ATTACK_DEFENSE.map(field).join("");
  $("attack-fleet").innerHTML = ATTACK_FLEET.map(field).join("");
}

function renderAttackTechs() {
  const t = attackTechs;
  $("attack-techs").textContent = t
    ? `Технологии цели из отчёта: оружие ${t["Оружейная технология"]}, щиты ${t["Щитовая технология"]}, броня ${t["Броня космических кораблей"]}.`
    : "Технологии цели считаются равными моим (без премиума).";
}

/** Заполнить поля из вставленного отчёта; флот и оборону неполного отчёта берём из сохранённого по этой цели. */
function fillAttack() {
  const [fresh] = SK.parseReports($("attack-report").value);
  if (!fresh) { setStatus("attack-fill-status", "Не нашёл отчёт: нужен текст «Шпионский доклад с … [г:с:п] от …».", "err"); return; }
  const r = SK.mergeReport(targets[fresh.coords], fresh) || targets[fresh.coords];
  $("attack-to").value = r.coords;
  SK.RESOURCES.forEach((n, i) => { $("attack-res-" + i).value = r.resources[n] || ""; });
  const units = { ...r.defense, ...r.fleet };
  for (const el of document.querySelectorAll("[data-attack-unit]")) el.value = units[el.dataset.attackUnit] || "";
  const unknown = Object.keys(units).filter(n => !BATTLE.UNITS[n] && !SK.HARMLESS.has(n));
  attackTechs = Object.keys(r.research || {}).length ? Object.fromEntries(BATTLE.TECHS.map(t => [t, r.research[t] || 0])) : null;
  renderAttackTechs();
  $("attack-report").value = "";
  setStatus("attack-fill-status", r.detailsUnknown ? "Неполный отчёт: флот и оборона цели неизвестны, проверьте поля."
    : unknown.length ? `Не учитываются: ${unknown.join(", ")}.`
    : `Заполнено из отчёта ${dateTime(r.time)}${r.time === fresh.time ? "" : " (сохранённого: он новее)"}.`,
    r.detailsUnknown || unknown.length ? "err" : "ok");
}

function clearAttack() {
  for (const el of $("attack").querySelectorAll("input[type=number], #attack-to")) el.value = "";
  attackTechs = null;
  renderAttackTechs();
  setStatus("attack-fill-status", "");
}

/** Входные данные подбора из полей (attack.js: context); строка — что не так. */
function attackConfig() {
  const from = attackOrigin(), to = $("attack-to").value.trim();
  if (!from) return "Добавьте свою планету в «Моих планетах».";
  if (!SK.parseCoords(to)) return "Укажите координаты цели, например 8:306:4.";
  const defense = {};
  for (const el of document.querySelectorAll("[data-attack-unit]")) {
    const k = Math.max(0, Math.floor(+el.value || 0));
    if (k) defense[el.dataset.attackUnit] = k;
  }
  return {
    speed: settings.speed,
    attacker: { techs: myTechs(), premium: settings.premium },
    defender: { techs: attackTechs || myTechs() },
    defense,
    available: settings.attackDs ? {} : { [BATTLE.DS]: 0 },
    half: SK.RESOURCES.map((_, i) => Math.floor(Math.max(0, +$("attack-res-" + i).value || 0) * settings.loot / 100)),
    dists: [SK.distance(SK.parseCoords(from.coords), SK.parseCoords(to))],
  };
}

function stopAttack() {
  attackWorker?.terminate();
  attackWorker = null;
  $("attack-run").disabled = false;
  $("attack-stop").hidden = true;
}

function runAttack() {
  const cfg = attackConfig();
  if (typeof cfg === "string") { setStatus("attack-status", cfg, "err"); return; }
  if (typeof Worker === "undefined") { setStatus("attack-status", "Браузер не умеет считать в фоне.", "err"); return; }
  stopAttack();
  attackTop = null;
  $("attack-results").innerHTML = "";
  $("attack-run").disabled = true;
  $("attack-stop").hidden = false;
  const started = Date.now(), seconds = () => Math.round((Date.now() - started) / 1000);
  setStatus("attack-status", "Считаю…");
  attackWorker = new Worker("attack-worker.js");
  attackWorker.onmessage = ({ data }) => {
    if (data.log) { setStatus("attack-status", `Считаю, ${seconds()} с: ${data.log}`); return; }
    stopAttack();
    if (data.error) { setStatus("attack-status", "Ошибка расчёта: " + data.error, "err"); return; }
    attackTop = data.top;
    setStatus("attack-status", `Готово за ${seconds()} с, дистанция ${fmt(cfg.dists[0])}.`, "ok");
    renderAttackResults();
  };
  attackWorker.onerror = e => { stopAttack(); setStatus("attack-status", "Ошибка расчёта: " + (e.message || e), "err"); };
  attackWorker.postMessage({ cfg });
}

/** Сумма в металле со знаком: выгода бывает отрицательной. */
const money = n => (n < 0 ? "−" : "") + fmtShort(Math.abs(n));

function renderAttackResults() {
  // Проигрывающие составы не нужны: показываем побеждающие хотя бы в половине боёв.
  const wins = attackTop.filter(c => c.r.win >= 0.5);
  const list = obj => Object.entries(obj).map(([n, k]) => `${esc(n)} <span class="num">${k}</span>`).join(", ");
  const lost = r => Object.fromEntries(Object.entries(r.lost).filter(([, v]) => v >= 0.05)
    .map(([n, v]) => [n, v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })]));
  $("attack-results").innerHTML = !wins.length
    ? `<p class="empty">Ни один состав не побеждает даже флотом в 10 раз дороже обороны цели.</p>`
    : wins.map((c, i) => `<article class="card">
        <div class="spread"><span><b>${i + 1}.</b> <span class="profit">${money(c.r.profit)}</span> <span class="muted">выгода</span></span>
          <span class="pill ${c.r.win >= 0.95 ? "ok" : "warn"}">победа ${Math.round(c.r.win * 100)}%</span></div>
        <div>${esc(c.share)}</div>
        <div class="route">${list(Object.fromEntries(Object.entries(c.fleet).map(([n, k]) => [n, fmt(k)])))}</div>
        <div class="muted" style="font-size:13px">добыча ${fmtShort(c.r.loot)} + обломки ${fmtShort(c.r.debris)}
          − потери ${fmtShort(c.r.loss)} − топливо ${fmtShort(c.r.fuel)}</div>
        ${Object.keys(lost(c.r)).length ? `<div class="muted" style="font-size:13px">гибнет в среднем: ${list(lost(c.r))}</div>` : ""}
      </article>`).join("")
      + (wins.length < attackTop.length ? `<p class="empty">Остальные составы чаще проигрывают.</p>` : "");
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
  $("min-loot").value = settings.minLoot || "";
  $("min-deut").value = settings.minDeut || "";
  const origin = distOrigin();
  $("dist-from").hidden = settings.sort !== "distance" || !origin;
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
  renderAttack();
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
$("min-loot").addEventListener("change", e => view({ minLoot: Math.max(0, +e.target.value || 0) }));
$("min-deut").addEventListener("change", e => view({ minDeut: Math.max(0, +e.target.value || 0) }));
$("page-size").addEventListener("change", e => view({ pageSize: +e.target.value }));
$("mines-toggle").addEventListener("click", () => { settings.minesOpen = !settings.minesOpen; save({ changed: false }); });
$("attack-toggle").addEventListener("click", () => { settings.attackOpen = !settings.attackOpen; save({ changed: false }); });
$("attack-from").addEventListener("change", e => { settings.attackFrom = e.target.value; save({ changed: false }); });
$("attack-ds").addEventListener("change", e => { settings.attackDs = e.target.checked; save({ changed: false }); });
$("attack-fill").addEventListener("click", fillAttack);
$("attack-clear").addEventListener("click", clearAttack);
$("attack-run").addEventListener("click", runAttack);
$("attack-stop").addEventListener("click", () => { stopAttack(); setStatus("attack-status", "Остановлено."); });

const goToPage = n => { page = n; tick(); $("h-targets").scrollIntoView({ block: "start" }); };
$("page").addEventListener("change", e => goToPage(+e.target.value));
$("page-prev").addEventListener("click", () => goToPage(page - 1));
$("page-next").addEventListener("click", () => goToPage(page + 1));

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
  if (t.dataset.deletePlanet && confirmDelete()) { settings.planets.splice(+t.dataset.deletePlanet, 1); save(); }
  if (t.dataset.deleteShip && confirmDelete()) {
    settings.ships = settings.ships.filter(s => s.id !== t.dataset.deleteShip);
    if (!settings.ships.some(s => s.id === settings.shipId)) settings.shipId = settings.ships[0].id;
    save();
  }
});

$("targets").addEventListener("toggle", e => {
  const c = e.target.dataset.coords;
  if (c) e.target.open ? openDetails.add(c) : openDetails.delete(c);
}, true);

// ---- Резервная копия файлом ----

function backupFile() {
  const d = new Date();
  const name = `space-kings-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  const data = JSON.stringify({ format: "space-kings-recon", version: 2, exportedAt: d.getTime(), settings, targets: Object.values(targets) });
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

/** Резервная копия этой версии или старой (JSON из поля «Показать JSON»). */
function readBackup(text) {
  const data = JSON.parse(text);
  if (data?.format === "space-kings-recon" && Array.isArray(data.targets)) return { settings: data.settings, targets: data.targets };
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
    setStatus("data-status", `В файле ${fmt(pendingImport.targets.length)} целей и ${pendingImport.settings?.planets?.length ?? 0} своих планет.`);
  } catch {
    pendingImport = null;
    setStatus("data-status", "Это не резервная копия «Разведки». Выберите файл, скачанный кнопкой «Скачать файл».", "err");
  }
});

$("import-merge").addEventListener("click", () => {
  const { put } = mergeReports(pendingImport.targets);
  $("import-actions").hidden = true;
  setStatus("data-status", `Добавлено и обновлено отчётов: ${fmt(put.length)}. Свои планеты и настройки не менялись.`, "ok");
  pendingImport = null;
  save({ put });
});

$("import-replace").addEventListener("click", () => {
  settings = normalizeSettings(pendingImport.settings);
  targets = Object.fromEntries(pendingImport.targets.map(r => [r.coords, r]));
  $("import-actions").hidden = true;
  setStatus("data-status", "Все данные заменены данными из файла.", "ok");
  pendingImport = null;
  page = 1;
  save({ clear: true, put: Object.values(targets) });
});

// ---- Запуск ----

$("speed").innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${100 - i * 10}">${100 - i * 10}%</option>`).join("");
$("filter").innerHTML = Object.entries(FILTERS).map(([k, n]) => `<option value="${k}">${n}</option>`).join("");
$("sort").innerHTML = Object.entries(SORTS).map(([k, o]) => `<option value="${k}">${o.name}</option>`).join("");
$("page-size").innerHTML = PAGE_SIZES.map(n => `<option value="${n}">по ${n}</option>`).join("");
attackUnitFields();
renderAttackTechs();
render();
init()
  .then(render)
  .catch(e => setStatus("report-status", `Хранилище браузера недоступно (${e?.name || e}). Данные не сохранятся.`, "err"));
setInterval(tick, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

// Просим браузер не удалять данные при нехватке места.
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
