// Расчёты Space Kings: разбор шпионских отчётов, прирост ресурсов, полёт. Формулы — formulas.md.
const SK = (() => {
  const HEADER = /Шпионский доклад с (.+?) \[(\d+:\d+:\d+)\] от (\d\d)-(\d\d)-(\d{4}) (\d\d):(\d\d):(\d\d)/g;
  const SECTIONS = { "Флот": "fleet", "Защита": "defense", "Постройки": "buildings", "Исследования": "research" };
  const PAIR = /(\D+?)\s+(\d[\d.]*)(?=\s|$)/g;
  // Конец отчёта в пакете: кнопки под отчётом и заголовок следующего сообщения.
  const REPORT_END = /^(Атаковать|Симулятор атаки|Ракетный симулятор|Шанс обнаружения|\d\d\.\d\d\.\d\d \d\d:\d\d:\d\d )/;
  const DETAILS = ["fleet", "defense", "buildings", "research"];
  // Мало зондов: в отчёте только ресурсы, флот, оборона, постройки и исследования не видны.
  const INCOMPLETE = /Отч[её]т неполный/;

  // Худшая (самая высокая) средняя температура по слоту: меньше всего дейтерия.
  const SLOT_TEMP = { 1: 260, 2: 210, 3: 160, 4: 110, 5: 100, 6: 90, 7: 80, 8: 70,
                      9: 60, 10: 50, 11: 40, 12: 30, 13: -10, 14: -50, 15: -90 };

  // Прирост скорости за уровень двигателя, доля от базовой скорости.
  const DRIVES = {
    combustion: { name: "Реактивный", bonus: 0.1 },
    impulse: { name: "Импульсный", bonus: 0.2 },
    hyperspace: { name: "Гиперпространственный", bonus: 0.3 },
  };

  // Не мешают грабежу: флагман не воюет, ракеты не стреляют по флоту.
  const HARMLESS = new Set(["Флагман", "Ракета-перехватчик", "Межпланетная ракета"]);

  /** Все отчёты из текста (можно вставить несколько подряд). */
  function parseReports(text) {
    const headers = [...text.matchAll(HEADER)];
    return headers.map((m, i) => {
      const body = text.slice(m.index + m[0].length, i + 1 < headers.length ? headers[i + 1].index : text.length);
      const [, planet, coords, dd, mm, yyyy, h, mi, s] = m;
      const report = {
        planet, coords,
        time: new Date(+yyyy, +mm - 1, +dd, +h, +mi, +s).getTime(),
        resources: {},
        incomplete: INCOMPLETE.test(body),
      };
      // Полный отчёт: раздел без строк — значит, там пусто. Неполный: разделов нет.
      if (!report.incomplete) for (const k of DETAILS) report[k] = {};
      let section = "resources";
      for (const raw of body.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (REPORT_END.test(line)) break;
        if (SECTIONS[line]) { section = SECTIONS[line]; report[section] ??= {}; continue; }
        for (const [, name, value] of line.matchAll(PAIR)) {
          report[section][name.trim()] = Number(value.replace(/\./g, ""));
        }
      }
      return report;
    });
  }

  /**
   * Новый отчёт поверх сохранённого; null, если сохранённый не старше.
   * Полный отчёт заменяет всё, кроме исследований, если их в нём не видно. Неполный обновляет время и ресурсы, а флот, оборону, постройки
   * и исследования берёт из сохранённого; если сохранённого нет, они неизвестны (`detailsUnknown`).
   */
  function mergeReport(old, fresh) {
    if (old && old.time >= fresh.time) return null;
    const { incomplete, ...merged } = fresh;
    if (!incomplete) {
      // Исследований не видно (мало зондов) — оставляем прежние: технологии со временем не падают.
      if (!Object.keys(merged.research).length && old?.research) merged.research = old.research;
      return { ...merged, detailsUnknown: false };
    }
    for (const k of DETAILS) merged[k] = old?.[k] ?? {};
    merged.detailsUnknown = old ? !!old.detailsUnknown : true;
    return merged;
  }

  function parseCoords(text) {
    const m = String(text).trim().match(/^(\d+):(\d+):(\d+)$/);
    return m && { g: +m[1], s: +m[2], p: +m[3] };
  }

  // Естественный прирост в час (металл, кристалл, дейтерий): идёт без шахт и не зависит от энергии.
  // Сверено с игрой 13-10-2026.
  const NATURAL = [750, 375, 0];

  const growth = (level, base) => base * level * 1.1 ** level;

  /** Прирост в час и данные для пояснения расчёта. */
  function production(report) {
    const b = report.buildings;
    const lm = b["Рудник по добыче металла"] || 0;
    const lc = b["Рудник по добыче кристаллов"] || 0;
    const ld = b["Синтезатор дейтерия"] || 0;
    const lf = b["Термоядерная электростанция"] || 0;
    const temp = SLOT_TEMP[parseCoords(report.coords).p];
    // «Энергия» в отчёте — выработка планеты; шахты работают на долю, которую она покрывает.
    const energy = report.resources["Энергия"] || 0;
    const consumption = growth(lm, 50) + growth(lc, 50) + growth(ld, 100);
    const factor = consumption ? Math.min(1, energy / consumption) : 1;
    return {
      temp, energy, consumption, factor,
      rates: [
        NATURAL[0] + growth(lm, 150) * factor,
        NATURAL[1] + growth(lc, 100) * factor,
        growth(ld, 50) * (1.36 - 0.004 * temp) * factor - growth(lf, 50),
      ],
      caps: ["Хранилище металла", "Хранилище кристаллов", "Емкость для дейтерия"]
        .map(n => 500000 * 1.5 ** (b[n] || 0)),
    };
  }

  // Ценность ресурсов в металле: 1 дейтерий = 2 кристалла = 4 металла.
  const VALUE = [1, 2, 4];
  /** Ресурсы [металл, кристалл, дейтерий] в пересчёте на дейтерий. */
  const inDeut = amounts => amounts.reduce((sum, a, r) => sum + a * VALUE[r], 0) / VALUE[2];
  // Стоимость 1-го уровня, рост стоимости за уровень, производство на уровне L и до какого уровня считать.
  const MINES = [
    { name: "Металл", res: 0, max: 45, cost: [60, 15, 0], factor: 1.5, prod: L => growth(L, 150) },
    { name: "Кристалл", res: 1, max: 40, cost: [48, 24, 0], factor: 1.6, prod: L => growth(L, 100) },
    { name: "Дейтерий", res: 2, max: 42, cost: [225, 75, 0], factor: 1.5,
      prod: (L, temp) => growth(L, 50) * (1.36 - 0.004 * temp) },
  ];

  /** За сколько часов прирост от уровня вернёт его стоимость, всё в пересчёте на металл. */
  function mineLevel(m, level, temp) {
    const cost = m.cost.map(c => c * m.factor ** (level - 1));
    const gain = m.prod(level, temp) - m.prod(level - 1, temp);
    const deut = inDeut(cost);
    return { mine: m.name, level, cost, deut, gain, hours: gain > 0 ? deut * VALUE[2] / (gain * VALUE[m.res]) : Infinity };
  }

  /**
   * Следующие уровни шахт на всех планетах, от быстрой окупаемости к медленной; энергия не учитывается.
   * deut — стоимость уровня в пересчёте на дейтерий.
   * planets: [{levels: [металл, кристалл, дейтерий], temp}]. Окупаемость растёт с уровнем,
   * поэтому уровень попадает в список только после предыдущего уровня той же шахты.
   */
  function nextMines(planets, count) {
    return planets.flatMap(p => MINES.flatMap((m, i) => {
      const from = p.levels[i] || 0;
      return Array.from({ length: Math.max(0, m.max - from) },
        (_, k) => ({ planet: p, ...mineLevel(m, from + k + 1, p.temp) }));
    })).sort((a, b) => a.hours - b.hours).slice(0, count);
  }

  const RESOURCES = ["Металл", "Кристалл", "Дейтерий"];

  /** Ресурсы на планете в момент `at` (мс). Рост останавливается на заполненном хранилище. */
  function resourcesAt(report, at, { rates, caps } = production(report)) {
    const hours = Math.max(0, at - report.time) / 3.6e6;
    return RESOURCES.map((name, i) => {
      const start = report.resources[name] || 0;
      const rate = rates[i];
      return rate > 0 ? Math.max(start, Math.min(caps[i], start + rate * hours))
                      : Math.max(0, start + rate * hours);
    });
  }

  /** Боевые единицы, которые помешают грабежу: флот и оборона без флагмана и ракет. */
  function guards(report) {
    const count = section => Object.entries(section)
      .filter(([name]) => !HARMLESS.has(name))
      .reduce((sum, [, n]) => sum + n, 0);
    return { fleet: count(report.fleet), defense: count(report.defense) };
  }

  /** Топливо на один корабль в одну сторону (формула OGame). */
  function fuelPerShip(ship, dist, speedPercent) {
    return (ship.consumption || 0) * dist / 35000 * (speedPercent / 100 + 1) ** 2;
  }

  /** Сколько кораблей нужно, чтобы вывезти `amount`: топливо занимает часть трюма. */
  function shipsNeeded(amount, ship, dist, speedPercent) {
    const fuel = fuelPerShip(ship, dist, speedPercent);
    const free = (ship.capacity || 0) - fuel;
    if (free <= 0) return { count: Infinity, fuel: Infinity, free };
    const count = Math.ceil(amount / free);
    return { count, fuel: count ? 1 + Math.round(fuel * count) : 0, free };
  }

  function distance(a, b) {
    if (a.g !== b.g) return Math.abs(a.g - b.g) * 20000;
    if (a.s !== b.s) return Math.abs(a.s - b.s) * 5 * 19 + 2700;
    if (a.p !== b.p) return Math.abs(a.p - b.p) * 5 + 1000;
    return 5;
  }

  function shipSpeed(ship, engines) {
    return ship.base * (1 + DRIVES[ship.drive].bonus * (engines[ship.drive] || 0));
  }

  /** Время полёта в секундах; speedPercent — 10…100. */
  function flightSeconds(dist, speed, speedPercent) {
    return Math.round((350000 / speedPercent * Math.sqrt(dist * 10 / speed) + 10) / 3);
  }

  /** Маршруты со всех моих планет до цели, от быстрого к медленному. */
  function routes(target, myPlanets, ship, engines, speedPercent) {
    const to = parseCoords(target);
    const speed = shipSpeed(ship, engines);
    return myPlanets
      .map(p => {
        const dist = distance(parseCoords(p.coords), to);
        return { from: p, dist, seconds: flightSeconds(dist, speed, speedPercent) };
      })
      .sort((a, b) => a.seconds - b.seconds);
  }

  return { parseReports, mergeReport, parseCoords, production, nextMines, inDeut, resourcesAt, guards, fuelPerShip, shipsNeeded,
           distance, shipSpeed, flightSeconds, routes, SLOT_TEMP, DRIVES, RESOURCES, HARMLESS };
})();

if (typeof module !== "undefined") module.exports = SK;
