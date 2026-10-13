// Интерфейс. Данные — в IndexedDB этого браузера: каждый отчёт отдельной записью, настройки — одной.
// Расчёты — core.js.
const DB_NAME = "space-kings-recon";
const LEGACY_KEY = "space-kings-recon-v1";  // localStorage старых версий, переносится при первом запуске
const MEGA = { id: "mega", name: "Мега транспорт", drive: "impulse", base: 7000, capacity: 350000, consumption: 100 };
const DEFAULT_SETTINGS = {
  planets: [],   // мои планеты: {coords, name}
  engines: { combustion: 0, impulse: 0, hyperspace: 0 },
  ships: [MEGA],
  shipId: "mega",
  speed: 100,
  loot: 50,
  filter: "all", // all | open | guarded
  sort: "loot",   // loot | coords
  pageSize: 20,
  backup: { at: 0, changedAt: 0, snoozeUntil: 0 },  // напоминание о резервной копии
};
const PAGE_SIZES = [10, 20, 50];
const BACKUP_EVERY = 3 * 24 * 3.6e6;  // напоминать, если копии нет дольше 3 дней
const SNOOZE = 24 * 3.6e6;
const FILTERS = { all: "Все цели", open: "Без защиты", guarded: "С защитой" };
const SORTS = {
  // Сначала планеты с полным складом: они простаивают. Дальше — по добыче.
  loot: { name: "По добыче", compare: (a, b) => (b.full.some(Boolean) - a.full.some(Boolean)) || b.total - a.total },
  coords: { name: "По координатам", compare: (a, b) => {
    const x = SK.parseCoords(a.report.coords), y = SK.parseCoords(b.report.coords);
    return x.g - y.g || x.s - y.s || x.p - y.p;
  } },
};

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

function currentShip() {
  return settings.ships.find(s => s.id === settings.shipId) || settings.ships[0];
}

// ---- Цели ----

function targetView(report, now) {
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
    full: atArrival.map((v, i) => v >= prod.caps[i]),
    guards: SK.guards(report),
    ships: best && SK.shipsNeeded(total, ship, best.dist, settings.speed),
  };
}

const guarded = v => v.guards.fleet + v.guards.defense > 0;

function unitTable(title, units) {
  const rows = Object.entries(units);
  if (!rows.length) return "";
  return `<tr><td colspan="2"><b>${title}</b></td></tr>` + rows.map(([n, c]) =>
    `<tr><td>${esc(n)}${SK.HARMLESS.has(n) ? ' <span class="muted">(не учитывается)</span>' : ""}</td><td>${fmt(c)}</td></tr>`).join("");
}

function card(v, now) {
  const r = v.report, p = v.prod, b = r.buildings, ship = currentShip();
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
    <div class="spread"><span class="loot">${fmtShort(v.total)}</span><span>${pills}</span></div>
    <div class="res">${SK.RESOURCES.map((n, i) => `<div>${n}<b>${fmt(v.loot[i])}</b></div>`).join("")}</div>
    <div class="route">${route}</div>
    ${cargo ? `<div class="route">${cargo}</div>` : ""}
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
        ${unitTable("Флот", r.fleet)}
        ${unitTable("Оборона", r.defense)}
      </table>
    </details>
  </article>`;
}

function renderTargets(now) {
  const all = Object.values(targets);
  const views = all.map(r => targetView(r, now))
    .filter(v => settings.filter === "all" || (settings.filter === "guarded") === guarded(v))
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
    : all.length ? `<p class="empty">Нет целей для фильтра «${FILTERS[settings.filter]}».</p>`
    : `<p class="empty">${db ? "Пока нет отчётов. Вставьте шпионский доклад выше — здесь появится, сколько ресурсов вы заберёте и сколько лететь." : "Загрузка…"}</p>`;
}

// ---- Мои данные ----

function renderPlanets() {
  $("planets").innerHTML = settings.planets.length
    ? settings.planets.map((p, i) => `<div class="item">
        <input class="num" value="${esc(p.coords)}" data-planet="${i}" data-field="coords" aria-label="Координаты" inputmode="numeric">
        <input value="${esc(p.name || "")}" data-planet="${i}" data-field="name" placeholder="Название" aria-label="Название">
        <button class="danger" data-delete-planet="${i}" aria-label="Удалить ${esc(p.coords)}">Удалить</button></div>`).join("")
    : `<p class="empty">Добавьте планеты, с которых летаете: время полёта считается от ближайшей.</p>`;
}

function renderSettings() {
  for (const d of Object.keys(SK.DRIVES)) $("eng-" + d).value = settings.engines[d] ?? 0;
  $("ship").innerHTML = settings.ships.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("ship").value = currentShip().id;
  $("speed").value = settings.speed;
  $("loot").value = settings.loot;
  $("filter").value = settings.filter;
  $("sort").value = settings.sort;
  $("page-size").value = settings.pageSize;
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
  renderSettings();
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
    settings.planets[+el.dataset.planet][field] = value;
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
$("speed").addEventListener("change", e => { settings.speed = +e.target.value; save(); });
$("loot").addEventListener("change", e => { settings.loot = Math.min(100, Math.max(1, +e.target.value || 50)); save(); });

// Вид списка: сбрасывает на первую страницу и не считается изменением данных.
const view = patch => { Object.assign(settings, patch); page = 1; save({ changed: false }); };
$("filter").addEventListener("change", e => view({ filter: e.target.value }));
$("sort").addEventListener("change", e => view({ sort: e.target.value }));
$("page-size").addEventListener("change", e => view({ pageSize: +e.target.value }));

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
render();
init()
  .then(render)
  .catch(e => setStatus("report-status", `Хранилище браузера недоступно (${e?.name || e}). Данные не сохранятся.`, "err"));
setInterval(tick, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

// Просим браузер не удалять данные при нехватке места.
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
