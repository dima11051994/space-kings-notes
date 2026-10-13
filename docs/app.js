// Интерфейс: состояние в localStorage этого браузера, расчёты — core.js.
const STORAGE_KEY = "space-kings-recon-v1";
const MEGA = { id: "mega", name: "Мега транспорт", drive: "impulse", base: 7000, capacity: 350000, consumption: 100 };
const DEFAULT_STATE = {
  targets: {},   // координаты -> последний шпионский отчёт
  planets: [],   // мои планеты: {coords, name}
  engines: { combustion: 0, impulse: 0, hyperspace: 0 },
  ships: [MEGA],
  shipId: "mega",
  speed: 100,
  loot: 50,
  filter: "all", // all | open | guarded
};
const FILTERS = { all: "Все цели", open: "Без защиты", guarded: "С защитой" };

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

let state = load();
const openDetails = new Set();  // раскрытые «Расчёт» переживают перерисовку

function load() {
  try { return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return normalize(null); }  // пустое или недоступное хранилище — начинаем с умолчаний
}

function normalize(saved) {
  const s = { ...structuredClone(DEFAULT_STATE), ...saved };
  // Корабли из старых версий: без трюма и расхода топлива.
  s.ships = s.ships.map(ship => ({ ...(ship.id === "mega" ? MEGA : { capacity: 0, consumption: 0 }), ...ship }));
  return s;
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { setStatus("data-status", "Браузер не дал сохранить данные. Сделайте резервную копию.", "err"); }
  render();
}

function setStatus(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = "status " + (kind || "");
}

function currentShip() {
  return state.ships.find(s => s.id === state.shipId) || state.ships[0];
}

// ---- Цели ----

function targetView(report, now) {
  const ship = currentShip();
  const routes = SK.routes(report.coords, state.planets, ship, state.engines, state.speed);
  const best = routes[0];
  const arrival = best ? now + best.seconds * 1000 : now;
  const atArrival = SK.resourcesAt(report, arrival);
  const loot = atArrival.map(v => Math.floor(v * state.loot / 100));
  const total = loot.reduce((a, b) => a + b, 0);
  return {
    report, routes, best, arrival, atArrival, loot, total,
    full: SK.storageFull(report, arrival),
    guards: SK.guards(report),
    ships: best && SK.shipsNeeded(total, ship, best.dist, state.speed),
  };
}

const guarded = v => v.guards.fleet + v.guards.defense > 0;

function unitTable(title, units) {
  const rows = Object.entries(units);
  if (!rows.length) return "";
  return `<tr><td colspan="2"><b>${title}</b></td></tr>` + rows.map(([n, c]) =>
    `<tr><td>${esc(n)}${SK.HARMLESS.has(n) ? ' <span class="muted">(не учитывается)</span>' : ""}</td><td>${fmt(c)}</td></tr>`).join("");
}

function renderTargets(now) {
  const all = Object.values(state.targets).map(r => targetView(r, now));
  const views = all
    .filter(v => state.filter === "all" || (state.filter === "guarded") === guarded(v))
    // Сначала планеты с полным складом: они простаивают. Дальше — по добыче.
    .sort((a, b) => (b.full.some(Boolean) - a.full.some(Boolean)) || b.total - a.total);
  $("filter-count").textContent = `${views.length} из ${all.length}`;
  if (!views.length) {
    $("targets").innerHTML = all.length
      ? `<p class="empty">Нет целей для фильтра «${FILTERS[state.filter]}».</p>`
      : `<p class="empty">Пока нет отчётов. Вставьте шпионский доклад выше — здесь появится, сколько ресурсов вы заберёте и сколько лететь.</p>`;
    return;
  }
  const ship = currentShip();
  $("targets").innerHTML = views.map(v => {
    const r = v.report, p = SK.production(r), b = r.buildings;
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
  }).join("");
}

// ---- Мои данные ----

function renderPlanets() {
  $("planets").innerHTML = state.planets.length
    ? state.planets.map((p, i) => `<div class="item">
        <input class="num" value="${esc(p.coords)}" data-planet="${i}" data-field="coords" aria-label="Координаты" inputmode="numeric">
        <input value="${esc(p.name || "")}" data-planet="${i}" data-field="name" placeholder="Название" aria-label="Название">
        <button class="danger" data-delete-planet="${i}" aria-label="Удалить ${esc(p.coords)}">Удалить</button></div>`).join("")
    : `<p class="empty">Добавьте планеты, с которых летаете: время полёта считается от ближайшей.</p>`;
}

function renderSettings() {
  for (const d of Object.keys(SK.DRIVES)) $("eng-" + d).value = state.engines[d] ?? 0;
  $("ship").innerHTML = state.ships.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("");
  $("ship").value = currentShip().id;
  $("speed").value = state.speed;
  $("loot").value = state.loot;
  $("filter").value = state.filter;
  const driveOptions = sel => Object.entries(SK.DRIVES)
    .map(([k, d]) => `<option value="${k}"${k === sel ? " selected" : ""}>${d.name}</option>`).join("");
  $("ships").innerHTML = state.ships.map(s => `<div class="card ship">
      <div class="spread"><input value="${esc(s.name)}" data-ship="${esc(s.id)}" data-field="name" aria-label="Название корабля" style="flex:1 1 0">
        ${state.ships.length > 1 ? `<button class="danger" data-delete-ship="${esc(s.id)}">Удалить</button>` : ""}</div>
      <div class="grid2">
        <label>Двигатель <select data-ship="${esc(s.id)}" data-field="drive">${driveOptions(s.drive)}</select></label>
        <label>Базовая скорость <input type="number" min="1" value="${s.base}" data-ship="${esc(s.id)}" data-field="base" inputmode="numeric"></label>
        <label>Трюм <input type="number" min="0" value="${s.capacity}" data-ship="${esc(s.id)}" data-field="capacity" inputmode="numeric"></label>
        <label>Расход топлива <input type="number" min="0" value="${s.consumption}" data-ship="${esc(s.id)}" data-field="consumption" inputmode="numeric"></label>
      </div>
      <div class="muted" style="font-size:13px">Скорость с двигателями: <span class="num">${fmt(SK.shipSpeed(s, state.engines))}</span></div>
    </div>`).join("");
}

function render() {
  const now = Date.now();
  $("clock").textContent = clock(now);
  renderTargets(now);
  renderPlanets();
  renderSettings();
}

// Таймер обновляет только цели: поля ввода ниже не перерисовываются, пока их редактируют.
function tick() {
  const now = Date.now();
  $("clock").textContent = clock(now);
  renderTargets(now);
}

// ---- События ----

$("report-save").addEventListener("click", () => {
  const reports = SK.parseReports($("report-text").value);
  if (!reports.length) {
    setStatus("report-status", "Не нашёл отчёт. Текст должен начинаться с «Шпионский доклад с …».", "err");
    return;
  }
  let added = 0, stale = 0;
  for (const r of reports) {
    const old = state.targets[r.coords];
    if (old && old.time >= r.time) { stale++; continue; }
    state.targets[r.coords] = r;
    added++;
  }
  if (added) $("report-text").value = "";
  setStatus("report-status",
    `Сохранено: ${added}` + (stale ? `, пропущено (есть отчёт новее или такой же): ${stale}` : ""), added ? "ok" : "err");
  save();
});

$("planet-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("planet-coords"), coords = input.value.trim();
  if (!SK.parseCoords(coords)) { input.setCustomValidity("Формат: галактика:система:планета, например 8:306:4"); input.reportValidity(); return; }
  if (state.planets.some(p => p.coords === coords)) { input.setCustomValidity("Эта планета уже в списке"); input.reportValidity(); return; }
  state.planets.push({ coords, name: $("planet-name").value.trim() });
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
    state.planets[+el.dataset.planet][field] = value;
    save();
  } else if (el.dataset.ship) {
    const ship = state.ships.find(s => s.id === el.dataset.ship);
    ship[field] = ["base", "capacity", "consumption"].includes(field) ? Math.max(0, +el.value || 0) : el.value.trim();
    save();
  }
});

for (const d of Object.keys(SK.DRIVES)) {
  $("eng-" + d).addEventListener("change", e => { state.engines[d] = Math.max(0, +e.target.value || 0); save(); });
}
$("ship").addEventListener("change", e => { state.shipId = e.target.value; save(); });
$("speed").addEventListener("change", e => { state.speed = +e.target.value; save(); });
$("loot").addEventListener("change", e => { state.loot = Math.min(100, Math.max(1, +e.target.value || 50)); save(); });
$("filter").addEventListener("change", e => { state.filter = e.target.value; save(); });

$("ship-add").addEventListener("click", () => {
  state.ships.push({ id: "s" + Date.now(), name: "Новый корабль", drive: "combustion", base: 1, capacity: 0, consumption: 0 });
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
  if (t.dataset.deleteTarget && confirmDelete()) { delete state.targets[t.dataset.deleteTarget]; save(); }
  if (t.dataset.deletePlanet && confirmDelete()) { state.planets.splice(+t.dataset.deletePlanet, 1); save(); }
  if (t.dataset.deleteShip && confirmDelete()) {
    state.ships = state.ships.filter(s => s.id !== t.dataset.deleteShip);
    if (!state.ships.some(s => s.id === state.shipId)) state.shipId = state.ships[0].id;
    save();
  }
});

$("targets").addEventListener("toggle", e => {
  const c = e.target.dataset.coords;
  if (c) e.target.open ? openDetails.add(c) : openDetails.delete(c);
}, true);

$("export").addEventListener("click", () => {
  $("data-text").value = JSON.stringify(state, null, 1);
  setStatus("data-status", "Скопируйте текст и сохраните в заметках или файле.", "ok");
});
$("copy").addEventListener("click", async () => {
  $("data-text").value = JSON.stringify(state, null, 1);
  try { await navigator.clipboard.writeText($("data-text").value); setStatus("data-status", "Скопировано в буфер обмена.", "ok"); }
  catch { $("data-text").select(); setStatus("data-status", "Не удалось скопировать автоматически — текст выделен, скопируйте вручную.", "err"); }
});
$("import").addEventListener("click", () => {
  try {
    const data = JSON.parse($("data-text").value);
    if (typeof data !== "object" || !data.targets || !Array.isArray(data.planets)) throw new Error();
    $("import-confirm").hidden = false;
    setStatus("data-status", `В копии ${Object.keys(data.targets).length} целей и ${data.planets.length} планет. Нажмите «Заменить все данные».`);
  } catch { setStatus("data-status", "Это не резервная копия: вставьте JSON, полученный кнопкой «Показать JSON».", "err"); }
});
$("import-confirm").addEventListener("click", () => {
  state = normalize(JSON.parse($("data-text").value));
  $("import-confirm").hidden = true;
  setStatus("data-status", "Данные загружены.", "ok");
  save();
});

// ---- Запуск ----

$("speed").innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${100 - i * 10}">${100 - i * 10}%</option>`).join("");
$("filter").innerHTML = Object.entries(FILTERS).map(([k, n]) => `<option value="${k}">${n}</option>`).join("");
render();
setInterval(tick, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

// Просим браузер не удалять данные при нехватке места.
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
