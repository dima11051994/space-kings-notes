// Самая выгодная атака на цель: перебор составов военного флота (доли по стоимости шагом 10%) и его размера;
// мега-транспорты добираются под вывоз добычи. Общий код страницы (attack-worker.js) и game-data/best-attack.js.
// Выгода = добыча + обломки (30% металла и кристалла погибших кораблей обеих сторон) − потери − топливо,
// всё в металле по курсу металл 1 : кристалл 2 : дейтерий 4. Бой — battle.js.
const ATTACK = (() => {
  const B = typeof BATTLE !== "undefined" ? BATTLE : require("./battle.js");
  const S = typeof SK !== "undefined" ? SK : require("./core.js");

  // С карточек игры (game-data/units.json): металл, кристалл, дейтерий, расход топлива, трюм.
  const UNITS = {
    "Малый транспорт": [2000, 2000, 0, 20, 5000],
    "Большой транспорт": [6000, 6000, 0, 50, 25000],
    "Лёгкий истребитель": [3000, 1000, 0, 20, 50],
    "Тяжёлый истребитель": [6000, 4000, 0, 75, 100],
    "Крейсер": [20000, 7000, 2000, 300, 800],
    "Линкор": [45000, 15000, 0, 500, 1500],
    "Колонизатор": [10000, 20000, 10000, 1000, 7500],
    "Переработчик": [10000, 6000, 2000, 300, 20000],
    "Шпионский зонд": [0, 1000, 0, 1, 5],
    "Бомбардировщик": [50000, 25000, 15000, 1000, 500],
    "Солнечный спутник": [0, 2000, 500, 0, 0],
    "Уничтожитель": [60000, 50000, 15000, 1000, 2000],
    "Звезда смерти": [5000000, 4000000, 1000000, 1, 1000000],
    "Линейный крейсер": [30000, 40000, 15000, 250, 750],
    "Мега-транспорт": [40000, 30000, 10000, 100, 250000],
    "Ракетная установка": [2000, 0, 0, 0, 0],
    "Легкий лазер": [1500, 500, 0, 0, 0],
    "Тяжёлый лазер": [6000, 2000, 0, 0, 0],
    "Ионное орудие": [2000, 6000, 0, 0, 0],
    "Пушка Гаусса": [20000, 15000, 2000, 0, 0],
    "Плазменное орудие": [50000, 50000, 30000, 0, 0],
    "Малый щитовой купол": [10000, 10000, 0, 0, 0],
    "Большой щитовой купол": [50000, 50000, 0, 0, 0],
  };
  const PRICE = [1, 2, 4];
  const MILITARY = ["Лёгкий истребитель", "Тяжёлый истребитель", "Крейсер", "Линкор", "Бомбардировщик",
                    "Уничтожитель", "Звезда смерти", "Линейный крейсер"];
  const MEGA = "Мега-транспорт";
  const SHORT = { "Лёгкий истребитель": "ЛИ", "Тяжёлый истребитель": "ТИ", "Крейсер": "Кр", "Линкор": "Лк", "Бомбардировщик": "Бомб",
                  "Уничтожитель": "Унич", "Звезда смерти": "ЗС", "Линейный крейсер": "ЛинКр" };
  const LONG = Object.fromEntries(Object.entries(SHORT).map(([n, s]) => [s, n]));
  // Составы, чаще всех попадавшие в верхние 10% в game-data/attack-study (40 лучших и 40 лучших без ЗС), и чистые составы.
  // Полный перебор (best-attack.js) идёт по ~11 000 составам — для телефона это слишком долго.
  const LEADERS = ["ЗС 100", "Кр 10 + ЗС 60 + ЛинКр 30", "ЗС 80 + ЛинКр 20", "ЗС 50 + ЛинКр 50", "ЗС 30 + ЛинКр 70",
    "Лк 10 + Бомб 10 + ЗС 30 + ЛинКр 50", "Бомб 10 + ЗС 10 + ЛинКр 80", "Бомб 10 + ЛинКр 90", "Бомб 10 + ЗС 30 + ЛинКр 60",
    "Бомб 10 + Унич 10 + ЗС 10 + ЛинКр 70", "Лк 10 + Бомб 10 + ЛинКр 80", "Кр 10 + Бомб 10 + ЗС 10 + ЛинКр 70", "Бомб 20 + ЛинКр 80",
    "Бомб 10 + ЗС 20 + ЛинКр 70", "Бомб 20 + ЗС 20 + ЛинКр 60", "Бомб 20 + Унич 10 + ЛинКр 70", "Бомб 10 + Унич 10 + ЗС 30 + ЛинКр 50",
    "Лк 10 + Бомб 10 + Унич 10 + ЛинКр 70", "Бомб 10 + Унич 10 + ЗС 50 + ЛинКр 30", "Лк 10 + Бомб 10 + ЗС 20 + ЛинКр 60", "ЛИ 10 + ЗС 90",
    "Кр 10 + Бомб 10 + ЛинКр 80", "Кр 10 + Бомб 10 + ЗС 20 + ЛинКр 60", "Кр 10 + ЗС 40 + ЛинКр 50", "Кр 10 + Бомб 20 + ЛинКр 70",
    "Бомб 10 + ЗС 40 + ЛинКр 50", "Бомб 10 + Унич 10 + ЗС 20 + ЛинКр 60", "Лк 10 + Бомб 10 + ЗС 10 + ЛинКр 70", "Бомб 10 + Унич 10 + ЛинКр 80",
    "ЗС 40 + ЛинКр 60", "Бомб 10 + Унич 20 + ЗС 30 + ЛинКр 40", "Кр 10 + Бомб 10 + ЗС 30 + ЛинКр 50", "Кр 10 + Лк 10 + Бомб 10 + ЛинКр 70",
    "Бомб 30 + ЛинКр 70", "Бомб 20 + ЗС 10 + ЛинКр 70", "Унич 10 + ЗС 60 + ЛинКр 30", "Лк 10 + Бомб 20 + ЛинКр 70",
    "Лк 10 + Бомб 10 + ЗС 40 + ЛинКр 40", "Лк 10 + Бомб 10 + Унич 10 + ЗС 20 + ЛинКр 50", "Лк 10 + Бомб 10 + Унич 20 + ЛинКр 60",
    "Кр 20 + Бомб 10 + ЛинКр 70", "Лк 20 + Бомб 10 + ЛинКр 70", "Кр 10 + Лк 20 + Бомб 10 + ЛинКр 60", "ЛинКр 100",
    "Бомб 10 + Унич 20 + ЛинКр 70", "Бомб 10 + Унич 30 + ЛинКр 60", "Лк 20 + Бомб 20 + Унич 30 + ЛинКр 30", "Кр 10 + ЛинКр 90",
    "Кр 10 + Бомб 10 + Унич 10 + ЛинКр 70", "Лк 20 + Бомб 20 + ЛинКр 60", "Лк 10 + Бомб 20 + Унич 10 + ЛинКр 60", "Бомб 10 + Унич 40 + ЛинКр 50",
    "Лк 10 + Бомб 20 + Унич 40 + ЛинКр 30", "Лк 20 + Бомб 10 + Унич 10 + ЛинКр 60", "Кр 10 + Унич 10 + ЛинКр 80", "Кр 10 + Лк 10 + ЛинКр 80",
    "Лк 30 + Бомб 20 + ЛинКр 50", "Бомб 30 + Унич 70", "Кр 20 + ЛинКр 80", "Кр 10 + Бомб 20 + Унич 10 + ЛинКр 60", "Кр 10 + Лк 20 + ЛинКр 70",
    "Кр 20 + Лк 10 + Бомб 10 + ЛинКр 60", "Лк 10 + Бомб 30 + ЛинКр 60", "Лк 10 + ЛинКр 90", "Бомб 10 + Унич 50 + ЛинКр 40",
    "Бомб 30 + Унич 50 + ЛинКр 20", "Бомб 30 + Унич 40 + ЛинКр 30", "Лк 10 + Бомб 10 + Унич 30 + ЛинКр 50",
    "ЛИ 100", "ТИ 100", "Кр 100", "Лк 100", "Бомб 100", "Унич 100"];

  const LOOT = 0.5;        // забираем половину ресурсов планеты
  const DEBRIS = 0.3;      // в обломки — 30% металла и кристалла погибших кораблей (подтверждено в игре)
  const CARGO_BONUS = 1.4; // трюм с нашими технологиями: у мега-транспорта 250 000 на карточке, 350 000 в игре
  const STEP = 10;         // доли состава — по 10%
  const GROWTH = 1.25;     // размер флота растёт ступенями ×1.25
  const SWEEP_RUNS = 4;

  const costOf = n => UNITS[n].slice(0, 3).reduce((s, v, r) => s + v * PRICE[r], 0);
  const debrisOf = n => DEBRIS * (UNITS[n][0] * PRICE[0] + UNITS[n][1] * PRICE[1]);
  const DEFENSE = new Set(["Ракетная установка", "Легкий лазер", "Тяжёлый лазер", "Ионное орудие", "Пушка Гаусса",
                           "Плазменное орудие", "Малый щитовой купол", "Большой щитовой купол"]);
  const defenseCost = defense => Object.entries(defense).reduce((s, [n, k]) => s + k * (UNITS[n] ? costOf(n) : 0), 0);
  /** Ресурсы [металл, кристалл, дейтерий] в металле. */
  const value = res => res.reduce((s, v, r) => s + v * PRICE[r], 0);

  /** Состав в виде «ЛИ 10 + ЗС 90» (порядок MILITARY) и обратно. */
  const mixKey = mix => Object.entries(mix).map(([n, v]) => `${SHORT[n]} ${Math.round(v * 100)}`).join(" + ") || "только мега";
  const parseMix = key => Object.fromEntries(key.split(" + ").map(p => { const [s, v] = p.split(" "); return [LONG[s], v / 100]; }));

  /**
   * Всё, что нужно для оценки флота. cfg: { speed, attacker: {techs, premium}, defender: {techs},
   * defense: {юнит: число} — оборона и флот цели, half: [м, к, д] — сколько можно увезти, dists: [дистанция], available }.
   */
  function context(cfg) {
    const fuelOne = (n, dist) => S.fuelPerShip({ consumption: UNITS[n][3] }, dist, cfg.speed);
    // Топливо занимает трюм (formulas.md), поэтому корабль вывозит трюм − топливо.
    const free = (n, dist) => Math.max(0, UNITS[n][4] * CARGO_BONUS - fuelOne(n, dist));
    return {
      ...cfg, fuelOne, free,
      A: B.types(cfg.attacker.techs, cfg.attacker.premium),
      D: B.types(cfg.defender.techs, false),
      halfTotal: cfg.half.reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Средние за `runs` боёв: победа, обломки, потери, погибшие по типам и `at` — добыча, топливо и выгода
   * на каждой дистанции ctx.dists. Поля loot / fuel / profit верхнего уровня — для первой дистанции.
   */
  function evaluate(ctx, fleet, runs) {
    const avg = { win: 0, debris: 0, loss: 0, lost: {},
      at: ctx.dists.map(dist => ({ dist, loot: 0,
        fuel: PRICE[2] * (1 + Math.round(Object.entries(fleet).reduce((s, [n, k]) => s + k * ctx.fuelOne(n, dist), 0)))
      })) };
    for (let i = 0; i < runs; i++) {
      const r = B.battle(fleet, ctx.defense, ctx.A, ctx.D);
      let loss = 0, debris = 0;
      for (const [n, k] of Object.entries(fleet)) {
        const dead = k - (r.att[n] || 0);
        loss += dead * costOf(n);
        debris += dead * debrisOf(n);
        avg.lost[n] = (avg.lost[n] || 0) + dead / runs;
      }
      // Обломки дают только корабли цели, не оборона.
      for (const [n, k] of Object.entries(ctx.defense)) if (!DEFENSE.has(n)) debris += (k - (r.def[n] || 0)) * debrisOf(n);
      avg.win += (r.winner === "att") / runs;
      avg.debris += debris / runs; avg.loss += loss / runs;
      // Трюма может не хватить: тогда каждого ресурса берём поровну по доле.
      if (r.winner === "att" && ctx.halfTotal) for (const a of avg.at) {
        const cap = Object.entries(r.att).reduce((s, [n, k]) => s + k * ctx.free(n, a.dist), 0);
        a.loot += value(ctx.half) * Math.min(1, cap / ctx.halfTotal) / runs;
      }
    }
    for (const a of avg.at) a.profit = a.loot + avg.debris - avg.loss - a.fuel;
    Object.assign(avg, { loot: avg.at[0].loot, fuel: avg.at[0].fuel, profit: avg.at[0].profit });
    return avg;
  }

  /** Все доли военных типов шагом STEP%, в сумме 100%; типы, которых нет совсем, не берём. */
  function allMixes(available) {
    const types = MILITARY.filter(n => available[n] !== 0), out = [];
    (function rec(i, left, acc) {
      if (i === types.length - 1) { out.push([...acc, left]); return; }
      for (let k = 0; k <= left; k++) rec(i + 1, left - k, [...acc, k]);
    })(0, 100 / STEP, []);
    return out.map(parts => Object.fromEntries(types.map((n, i) => [n, parts[i] * STEP / 100]).filter(([, v]) => v > 0)));
  }

  /** Составы-лидеры без типов, которых нет совсем. */
  const leaders = available => LEADERS.map(parseMix).filter(mix => Object.keys(mix).every(n => available[n] !== 0));

  /**
   * Военный флот на бюджет по долям + мега-транспорты, чтобы вывезти остаток добычи с самой дальней дистанции
   * (на ближних трюма тогда тоже хватит); null — столько кораблей нет.
   */
  function fleetFor(ctx, budget, mix) {
    const far = Math.max(...ctx.dists), fleet = {};
    for (const [n, share] of Object.entries(mix)) {
      const k = Math.floor(budget * share / costOf(n));
      if (k > 0) fleet[n] = k;
    }
    const carried = Object.entries(fleet).reduce((s, [n, k]) => s + k * ctx.free(n, far), 0);
    const megas = Math.ceil(Math.max(0, ctx.halfTotal - carried) / ctx.free(MEGA, far));
    if (megas > 0) fleet[MEGA] = megas;
    return Object.entries(fleet).some(([n, k]) => k > (ctx.available[n] ?? Infinity)) ? null : fleet;
  }

  const keyOf = fleet => JSON.stringify(Object.entries(fleet).sort());

  /** Состав по фактическому флоту: доли военных кораблей по стоимости (малый бюджет может не купить ни одного корабля доли). */
  function share(fleet) {
    const mil = Object.entries(fleet).filter(([n]) => n !== MEGA), total = mil.reduce((s, [n, k]) => s + k * costOf(n), 0);
    return mil.map(([n, k]) => `${n} ${Math.round(k * costOf(n) / total * 100)}%`).join(" + ") || "только мега-транспорты";
  }

  /**
   * Перебор составов `mixes`: флот каждого растёт ступенями ×GROWTH. Состав выбывает, когда после победы его выгода
   * дважды подряд не улучшила его же лучшую ни на одной дистанции. run(флоты, боёв) → результаты evaluate по порядку.
   * Возвращает все оценённые флоты { fleet, mix, budget, r }; `withMegas` — оценить и «только мега-транспорты».
   * Состав без побед бросаем, когда флот дороже обороны цели в `giveUp` раз (и дороже 1 млрд).
   */
  async function sweep(cfg, { run, mixes, withMegas = true, giveUp = 100, log = () => {} }) {
    const ctx = context(cfg);
    const defCost = defenseCost(cfg.defense);
    const all = new Map();
    const state = mixes.map(mix => ({ mix, best: cfg.dists.map(() => -Infinity), worse: 0, won: false, done: false }));
    const megasOnly = fleetFor(ctx, 0, {});
    if (withMegas && megasOnly && Object.keys(megasOnly).length)
      all.set(keyOf(megasOnly), { fleet: megasOnly, mix: {}, budget: 0, r: (await run([megasOnly], SWEEP_RUNS))[0] });
    const start = Math.max(1e5, defCost / 4), limit = Math.max(1e9, defCost * giveUp);
    for (let budget = start; state.some(s => !s.done); budget *= GROWTH) {
      // Больше кораблей, чем есть, — дальше этому составу расти некуда.
      for (const s of state) if (!s.done && !fleetFor(ctx, budget, s.mix)) s.done = true;
      const active = state.filter(s => !s.done);
      const fleets = active.map(s => fleetFor(ctx, budget, s.mix));
      const todo = new Map();
      fleets.forEach((f, i) => { const k = keyOf(f); if (!all.has(k) && !todo.has(k)) todo.set(k, { f, mix: active[i].mix }); });
      const results = await run([...todo.values()].map(t => t.f), SWEEP_RUNS);
      [...todo.entries()].forEach(([k, t], i) => all.set(k, { fleet: t.f, mix: t.mix, budget, r: results[i] }));
      active.forEach((s, i) => {
        // Бюджета не хватило ещё на один корабль — флот тот же, это не ухудшение (важно для дорогих ЗС).
        const key = keyOf(fleets[i]);
        if (key === s.last) return;
        s.last = key;
        const e = all.get(key);
        if (e.r.win >= 0.75) s.won = true;
        let better = false;
        e.r.at.forEach((a, d) => { if (a.profit > s.best[d]) { s.best[d] = a.profit; better = true; } });
        if (better) s.worse = 0;
        else if (s.won && ++s.worse >= 2) s.done = true;
        if (!s.won && budget > limit) s.done = true;
      });
      log(`бюджет ${Math.round(budget / 1e6)} млн: составов ${active.length}, новых флотов ${todo.size}`);
    }
    return [...all.values()];
  }

  /**
   * Лучшие `top` составов, у каждого — самый выгодный размер, от большей выгоды к меньшей. После перебора
   * `finalMixes` лучших составов (у каждого `finalSizes` лучших размеров) пересчитываются за `finalRuns` боёв.
   */
  async function best(cfg, { run, mixes, top = 10, finalMixes = 30, finalSizes = 3, finalRuns = 40, giveUp, log = () => {} }) {
    const all = await sweep(cfg, { run, mixes, giveUp, log });
    const byMix = new Map();
    for (const c of all.sort((a, b) => b.r.profit - a.r.profit)) {
      const k = share(c.fleet), list = byMix.get(k) || byMix.set(k, []).get(k);
      if (list.length < finalSizes) list.push(c);
    }
    const candidates = [...byMix.values()].slice(0, finalMixes).flat();
    log(`уточняю ${candidates.length} флотов по ${finalRuns} боёв`);
    const final = await run(candidates.map(c => c.fleet), finalRuns);
    candidates.forEach((c, i) => { c.r = final[i]; });
    // Сначала побеждающие хотя бы в половине боёв: малый проигрывающий флот теряет немного и иначе обходит победителей.
    const rank = (a, b) => (b.r.win >= 0.5) - (a.r.win >= 0.5) || b.r.profit - a.r.profit;
    // У каждого состава — только лучший размер.
    return [...new Map(candidates.sort(rank).reverse().map(c => [share(c.fleet), c])).values()]
      .sort(rank).slice(0, top).map(c => ({ ...c, share: share(c.fleet) }));
  }

  /** Оценка флотов в этом же потоке: run для sweep / best. */
  function local(cfg) {
    const ctx = context(cfg);
    return async (fleets, runs) => fleets.map(f => evaluate(ctx, f, runs));
  }

  return { UNITS, DEFENSE, MILITARY, MEGA, SHORT, LEADERS, LOOT, costOf, defenseCost, value, mixKey, parseMix, allMixes, leaders,
           context, evaluate, fleetFor, share, sweep, best, local };
})();

if (typeof module !== "undefined") module.exports = ATTACK;
