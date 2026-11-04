// Самый дешёвый флот против заданной обороны: составы военного флота (доли по стоимости шагом 10%) и их размер.
// Добыча не учитывается. Общий код страницы (app.js, потоки cheapest-worker.js) и game-data/best-attack.js.
// Чистые потери = погибшие корабли + топливо флота − (обломки − топливо переработчиков, чтобы их собрать);
// обломки — 30% металла и кристалла погибших кораблей обеих сторон; всё в металле по курсу 1 : 2 : 4.
//
// Стартовые составы — REF_MIXES лучших по итогам перебора game-data/dominance.js для ближайших оборон сетки
// (справочник dominance-top.bin.gz; там — 500 млн и наши технологии у обеих сторон), дальше — соседи шагом 10%.
// Размер флота и соседей подбирает аналитическая модель боя (analytic.js, в матожиданиях) с технологиями этой цели;
// лучший по модели флот перепроверяется Монте-Карло (battle.js, сверен с симулятором игры): модель сходится
// с ним в пределах ±0.4% потерь. Звёзды смерти — отдельно: только ЗС, все размеры проверяются Монте-Карло.
//
// Оценки флотов считают потоки: env = { run(флоты, боёв) → Promise результатов evaluateLoss в том же порядке,
// size — потоков, excluded — Set ключей составов, которые не перебираем (game-data/attack-study),
// table — справочник (table(bytes)) или null, log(текст) }.
const CHEAPEST = (() => {
  const B = typeof BATTLE !== "undefined" ? BATTLE : require("./battle.js");
  const A = typeof ATTACK !== "undefined" ? ATTACK : require("./attack.js");
  const { analyze } = typeof ANALYTIC !== "undefined" ? ANALYTIC : require("./analytic.js");
  const { MILITARY, mixKey, share, defenseCost, value } = A;

  const TOP = 10;
  const MIN_WIN = 0.9;      // годится флот, побеждающий хотя бы в 90% боёв
  const VERIFY_MIXES = 5;   // с verify "all" — столько лучших составов (у каждого — VERIFY_SIZES размеров) проверяем Монте-Карло
  const VERIFY_SIZES = 2;
  const VERIFY_RUNS = 100;
  // Поиск: стартовые составы, затем соседи (шаг 10%) REFINE_TOP лучших — не меньше REFINE_MIN_ROUNDS раз и дальше,
  // пока улучшается лучший, но не больше REFINE_ROUNDS раз.
  const COARSE = 2;
  const REF_MIXES = 5;      // столько стартовых составов из справочника (без него — вся сетка шагом COARSE)
  const REF_NEAR = 5;       // столько ближайших оборон сетки усредняем
  const REFINE_TOP = 20;
  const REFINE_MIN_ROUNDS = 3;
  const REFINE_ROUNDS = 10;
  // Размер флота: порог победы — с точностью PRECISION по бюджету, дальше рост ×CLIMB, пока чистые потери падают.
  const PRECISION = 1.1;
  const CLIMB = 1.25;
  const POLISH = [1.12, 1.06];  // доводка вокруг лучшего размера
  const RECYCLER = "Переработчик";

  /**
   * Чистые потери флота `fleet` (в металле) на каждой дистанции ctx.dists: runs = 0 — аналитикой (матожидания),
   * иначе в среднем за runs боёв Монте-Карло. Поля как у A.evaluate (win, lost, at[].profit = −чистые потери),
   * чтобы годился A.sweep / A.best, плюс loss, debris, at[].fuel / recyclers / recFuel / net, net2 — средний
   * квадрат потерь (для склейки кусков) и sd — ошибка среднего МК.
   */
  function evaluateLoss(ctx, fleet, runs) {
    const fuelOf = dist => value([0, 0, 1 + Math.round(Object.entries(fleet).reduce((s, [n, k]) => s + k * ctx.fuelOne(n, dist), 0))]);
    const avg = { win: 0, loss: 0, debris: 0, lost: {}, net2: 0,
      at: ctx.dists.map(dist => ({ dist, fuel: fuelOf(dist), recyclers: 0, recFuel: 0, net: 0 })) };
    const add = (att, def, win, w) => {
      let loss = 0, debris = 0, amount = 0;  // amount — металл + кристалл в обломках, штук
      const wreck = (n, dead) => {
        if (A.DEFENSE.has(n)) return;  // оборона обломков не даёт
        debris += dead * A.debrisOf(n);
        amount += dead * A.DEBRIS * (A.UNITS[n][0] + A.UNITS[n][1]);
      };
      for (const [n, k] of Object.entries(fleet)) {
        const dead = k - (att[n] || 0);
        loss += dead * A.costOf(n);
        wreck(n, dead);
        avg.lost[n] = (avg.lost[n] || 0) + dead * w;
      }
      for (const [n, k] of Object.entries(ctx.defense)) wreck(n, k - (def[n] || 0));
      avg.win += win * w; avg.loss += loss * w; avg.debris += debris * w;
      avg.at.forEach((a, d) => {
        // Переработчики летят с той же дистанции, топливо занимает их трюм; невыгодные обломки не собираем.
        const free = ctx.free(RECYCLER, a.dist), count = amount > 1e-6 && free > 0 ? Math.ceil(amount / free) : 0;
        const recFuel = count ? value([0, 0, 1 + Math.round(count * ctx.fuelOne(RECYCLER, a.dist))]) : 0;
        const collect = debris > recFuel, net = loss + a.fuel - (collect ? debris - recFuel : 0);
        a.recyclers += (collect ? count : 0) * w; a.recFuel += (collect ? recFuel : 0) * w; a.net += net * w;
        if (d === 0) avg.net2 += net * net * w;
      });
    };
    if (!runs) {
      const r = analyze(fleet, ctx.defense, ctx.A, ctx.D);
      add(r.att, r.def, r.win.att, 1);
    } else for (let i = 0; i < runs; i++) {
      const r = B.battle(fleet, ctx.defense, ctx.A, ctx.D);
      add(r.att, r.def, r.winner === "att", 1 / runs);
    }
    for (const a of avg.at) a.profit = -a.net;
    const sd = runs ? Math.sqrt(Math.max(0, avg.net2 - avg.at[0].net ** 2) / runs) : 0;
    return { ...avg, sd, fuel: avg.at[0].fuel, net: avg.at[0].net, profit: avg.at[0].profit };
  }

  /** Составы из типов `types` с долями, кратными step десятым (в сумме 100%), кроме `excluded`. */
  function grid(types, step, excluded = new Set()) {
    const out = [];
    (function rec(i, left, acc) {
      if (i === types.length - 1) { out.push([...acc, left]); return; }
      for (let k = 0; k <= left; k += step) rec(i + 1, left - k, [...acc, k]);
    })(0, 10, []);
    return out.map(parts => Object.fromEntries(types.map((n, i) => [n, parts[i] / 10]).filter(([, v]) => v > 0)))
      .filter(mix => !excluded.has(mixKey(mix)));
  }

  /** Соседи состава: 10% переходит от одного типа к другому (типы из `types`), кроме `excluded`. */
  function neighbors(mix, types, excluded) {
    const out = [];
    for (const from of Object.keys(mix)) for (const to of types) {
      if (to === from) continue;
      const m = { ...mix, [from]: Math.round(mix[from] * 10 - 1) / 10, [to]: Math.round(((mix[to] || 0) * 10) + 1) / 10 };
      if (!m[from]) delete m[from];
      const sorted = Object.fromEntries(types.filter(n => m[n]).map(n => [n, m[n]]));  // порядок как у mixKey в сетке
      if (!excluded.has(mixKey(sorted))) out.push(sorted);
    }
    return out;
  }

  /**
   * Подбор размера флота — шаг за шагом: sizeState(mix, budget, limit, near) — начало, sizeStep(s, f, e) — учесть флот f
   * на бюджет s.cur (null — столько кораблей нет, {} — бюджета не хватает ни на один корабль) и его оценку
   * e = { r: { win, net } } (null для null / {}), после чего s.cur — следующий бюджет, пока s.phase !== "done".
   * Сначала порог победы: бюджет ×2 или /2, пока победа (MIN_WIN) не окажется между проигрышем и победой, затем
   * делением пополам до точности PRECISION. Если порог известен примерно (near — бюджет, с которого побеждал
   * тот же состав против похожей обороны), поиск начинается с него, а шаг растёт от ×PRECISION до ×2 (квадратом),
   * если угадали плохо. После поиска s.hi — найденный порог (Infinity — не побеждает). От лучшего найденного
   * бюджет растёт ×CLIMB, пока чистые потери падают — до двух шагов без улучшения (больше флот — меньше гибнет,
   * но больше топлива); затем доводка ÷/× POLISH вокруг лучшего. s.best — лучшая побеждающая оценка, s.bestBudget — её бюджет.
   */
  const sizeState = (mix, budget, limit, near) =>
    ({ mix, cur: near || budget, grow: near ? PRECISION : 2, limit, lo: 0, hi: Infinity, phase: "find", best: null });

  function sizeStep(s, f, e) {
    const win = !!e && e.r.win >= MIN_WIN, better = win && (!s.best || e.r.net < s.best.r.net);
    if (better) { s.best = e; s.bestBudget = s.cur; }
    if (s.phase === "climb") {
      // Два шага подряд без улучшения или кораблей больше нет — переходим к доводке.
      s.worse = better ? 0 : s.worse + 1;
      if (f && s.worse < 2) s.cur *= CLIMB;
      else { s.phase = "polish"; s.step = POLISH[0]; s.dir = -1; s.cur = s.bestBudget / s.step; }
      return;
    }
    if (s.phase === "polish") {
      // Шаг CLIMB мог перепрыгнуть минимум: вокруг лучшего — ÷ и × на каждый шаг POLISH, пока улучшается.
      if (better) s.cur = s.bestBudget * s.step ** s.dir;
      else if (s.dir < 0) { s.dir = 1; s.cur = s.bestBudget * s.step; }
      else {
        s.step = POLISH[POLISH.indexOf(s.step) + 1];
        if (s.step) { s.dir = -1; s.cur = s.bestBudget / s.step; } else s.phase = "done";
      }
      return;
    }
    if (win) s.hi = s.cur; else s.lo = s.cur;
    if (!f && !win) s.cap = true;  // больше кораблей нет — выше не подняться
    const grow = s.grow;
    s.grow = Math.min(2, grow * grow);
    if (s.hi === Infinity) {
      if (s.cap || s.cur * grow > s.limit) s.phase = "done"; else s.cur *= grow;
    } else if (s.lo === 0) s.cur /= grow;
    else if (s.hi / s.lo > PRECISION * (1 + 1e-9)) s.cur = Math.sqrt(s.lo * s.hi);
    // Лучший по потерям побеждающий флот мог встретиться и выше порога (при удвоении) — растём от него.
    else { s.phase = "climb"; s.worse = 0; s.cur = s.bestBudget * CLIMB; }
  }

  /**
   * Лучший размер каждого состава из `starts` ([{ mix, budget }] — откуда начинать): sizeStep для всех составов
   * вместе, чтобы потоки были заняты. Все оценённые флоты — в `seen` (ключ флота → { fleet, mix, budget, r });
   * возвращает { mixKey → лучший побеждающий }.
   */
  async function sizes(ctx, env, starts, seen, limit) {
    const states = starts.map(({ mix, budget }) => sizeState(mix, budget, limit));
    for (let active = states; active.length; active = states.filter(s => s.phase !== "done")) {
      const fleets = active.map(s => A.fleetFor(ctx, s.cur, s.mix));
      const todo = new Map();
      fleets.forEach((f, i) => {
        const k = f && JSON.stringify(f);
        if (f && Object.keys(f).length && !seen.has(k) && !todo.has(k)) todo.set(k, { fleet: f, mix: active[i].mix, budget: active[i].cur });
      });
      const results = await env.run([...todo.values()].map(t => t.fleet), 0);
      [...todo.entries()].forEach(([k, t], i) => seen.set(k, { ...t, r: results[i] }));
      active.forEach((s, i) => {
        const f = fleets[i];
        sizeStep(s, f, f && Object.keys(f).length ? seen.get(JSON.stringify(f)) : null);
      });
    }
    return new Map(states.filter(s => s.best).map(s => [mixKey(s.mix), s.best]));
  }

  /**
   * Монте-Карло: по `runs` боёв на каждый флот `fleets`; бои одного флота делятся на куски по потокам
   * (не меньше 10 боёв в куске), чтобы несколько флотов не оставляли потоки без дела. Итог — как у evaluateLoss.
   */
  async function monteCarlo(env, fleets, runs) {
    const parts = Math.max(1, Math.min(Math.floor(runs / 10), Math.ceil(env.size / fleets.length)));
    const counts = Array.from({ length: parts }, (_, i) => Math.floor(runs * (i + 1) / parts) - Math.floor(runs * i / parts));
    return Promise.all(fleets.map(async fleet => {
      const rs = await Promise.all(counts.map(n => env.run([fleet], n).then(([r]) => r)));
      // Среднее кусков с весом числа боёв — поле за полем (числа, массивы at, объект lost).
      const mean = xs => typeof xs[0] === "number" ? xs.reduce((s, x, i) => s + (x || 0) * counts[i], 0) / runs
        : Array.isArray(xs[0]) ? xs[0].map((_, j) => mean(xs.map(x => x[j])))
        : Object.fromEntries([...new Set(xs.flatMap(Object.keys))].map(k => [k, mean(xs.map(x => x[k] ?? 0))]));
      const r = mean(rs);
      r.sd = Math.sqrt(Math.max(0, r.net2 - r.net ** 2) / runs);
      return r;
    }));
  }

  // ---- Справочник: итоги game-data/dominance.js (сжимает game-data/dominance-top.js pack) ----
  //
  // Формат (после gzip): uint32 длина заголовка, заголовок JSON { budget, types, mixes, distSystems, dists, k, parts },
  // затем обороны: по `parts` байт — номера типов в `types` (каждый — 1/parts бюджета, повторы складываются),
  // затем на каждую оборону × дистанцию k записей: uint16 номер состава в `mixes` (EMPTY — пусто) и uint8
  // отставание чистых потерь от лучшего, в GAP_STEP бюджета (255 — 25.5% и больше).
  const EMPTY = 0xffff;
  const GAP_STEP = 0.001;

  /** Справочник из распакованных байтов (Uint8Array). */
  function table(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), len = view.getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
    const ND = head.distSystems.length, D = (bytes.length - 4 - len) / (head.parts + ND * head.k * 3);
    const refs = bytes.subarray(4 + len, 4 + len + D * head.parts), top = 4 + len + D * head.parts;
    /** Top-k обороны j на дистанции d: Map(номер состава → отставание в GAP_STEP). */
    const gaps = (j, d) => {
      const out = new Map();
      for (let r = 0, o = top + (j * ND + d) * head.k * 3; r < head.k; r++, o += 3) {
        const f = view.getUint16(o, true);
        if (f !== EMPTY) out.set(f, bytes[o + 2]);
      }
      return out;
    };
    return { ...head, D, refs, gaps };
  }

  /**
   * Ближайшие к `defense` обороны сетки T (по долям стоимости типов, расстояние L1; купола и типы вне сетки
   * не учитываются) и ближайшая сохранённая дистанция к `dist`. null — в обороне нет типов сетки.
   */
  function references(T, defense, dist) {
    const share = new Float64Array(T.types.length);
    let sum = 0;
    T.types.forEach((n, t) => { share[t] = (defense[n] || 0) * A.costOf(n); sum += share[t]; });
    if (!sum) return null;
    for (let t = 0; t < share.length; t++) share[t] /= sum;
    const q = new Float64Array(T.types.length), near = [];
    for (let j = 0; j < T.D; j++) {
      q.fill(0);
      for (let p = 0; p < T.parts; p++) q[T.refs[j * T.parts + p]] += 1 / T.parts;
      let l1 = 0;
      for (let t = 0; t < q.length; t++) l1 += Math.abs(q[t] - share[t]);
      if (near.length < REF_NEAR || l1 < near.at(-1).l1) {
        near.push({ j, l1 });
        near.sort((a, b) => a.l1 - b.l1);
        if (near.length > REF_NEAR) near.pop();
      }
    }
    const d = T.dists.reduce((b, x, i) => Math.abs(Math.log(x / dist)) < Math.abs(Math.log(T.dists[b] / dist)) ? i : b, 0);
    const describe = j => {
      const n = new Map();
      for (let p = 0; p < T.parts; p++) { const k = T.types[T.refs[j * T.parts + p]]; n.set(k, (n.get(k) || 0) + 100 / T.parts); }
      return [...n].map(([k, v]) => `${k} ${v}%`).join(" + ");
    };
    return { d, distSystems: T.distSystems[d], near: near.map(x => ({ ...x, key: describe(x.j) })) };
  }

  /**
   * Составы-кандидаты для `defense` на дистанции `dist`: средневзвешенное (вес 1/(L1 + 0.05)) отставание
   * от лучшего по ближайшим оборонам сетки; состав вне top-k обороны считается с отставанием 25.5%.
   * Возвращает до `count` лучших { mix, key, gap — доля бюджета обороны } и refs — что взяли; null — см. references.
   */
  function candidates(T, defense, dist, count, allow = () => true) {
    const refs = references(T, defense, dist);
    if (!refs) return null;
    const near = refs.near.map(({ j, l1 }) => ({ w: 1 / (l1 + 0.05), gaps: T.gaps(j, refs.d) }));
    const wsum = near.reduce((s, x) => s + x.w, 0);
    const list = [...new Set(near.flatMap(x => [...x.gaps.keys()]))].map(f => {
      const s = near.reduce((s, x) => s + x.w * (x.gaps.has(f) ? x.gaps.get(f) : 255), 0);
      return { mix: A.parseMix(T.mixes[f]), key: T.mixes[f], gap: s / wsum * GAP_STEP };
    }).filter(c => allow(c.mix)).sort((a, b) => a.gap - b.gap).slice(0, count);
    return { list, refs };
  }

  /** Стартовые составы: REF_MIXES лучших по справочнику из типов `types`; без справочника или с full — вся сетка COARSE. */
  function starts(cfg, env, types, full) {
    const allowed = new Set(types);
    const c = !full && env.table && candidates(env.table, cfg.defense, cfg.dists[0], REF_MIXES, mix => Object.keys(mix).every(n => allowed.has(n)));
    if (!c || !c.list.length) {
      if (!full) env.log("справочника нет или он не подходит — перебираю всю сетку");
      return { mixes: grid(types, COARSE, env.excluded), refs: null };
    }
    env.log(`ближайшие обороны сетки (дистанция ${c.refs.distSystems} систем):\n` +
            c.refs.near.map(x => `  ${x.key} (L1 ${x.l1.toFixed(2)})`).join("\n"));
    env.log(`стартовые составы:\n` + c.list.map(x => `  ${x.key} (отставание ~${(x.gap * 100).toFixed(1)}%)`).join("\n"));
    return { mixes: c.list.map(x => x.mix), refs: c.refs, start: c.list };
  }

  /**
   * Лучшие `top` составов (у каждого — лучший размер). Аналитикой: составы `mixList`, затем, если даны `types`,
   * соседи (шаг 10%) REFINE_TOP лучших, пока лучший улучшается (REFINE_MIN_ROUNDS…REFINE_ROUNDS раз) — размер
   * соседа ищется от бюджета родителя. verify "best" — Монте-Карло проверяется только лучший по модели флот (если
   * не побеждает в MIN_WIN боёв — следующий), "all" — у VERIFY_MIXES лучших составов по verifySizes размеров.
   * Итог — сначала побеждающие в MIN_WIN боёв, затем по чистым потерям. c.model — оценка аналитики,
   * c.r — Монте-Карло (c.verified) или та же аналитика.
   */
  async function search(cfg, env, mixList, top, { types, verify = "best", verifySizes = VERIFY_SIZES } = {}) {
    const t0 = Date.now(), ctx = A.context(cfg), seen = new Map();
    const defCost = defenseCost(cfg.defense), limit = Math.max(1e9, defCost * 100);
    const best = await sizes(ctx, env, mixList.map(mix => ({ mix, budget: Math.max(1e5, defCost) })), seen, limit);
    env.log(`стартовых составов ${mixList.length}, флотов ${seen.size}`);
    const tried = new Set(mixList.map(mixKey));
    const bestNet = () => Math.min(...[...best.values()].map(e => e.r.net));
    for (let round = 0; types && round < REFINE_ROUNDS; round++) {
      const before = bestNet(), next = [];
      for (const e of [...best.values()].sort((a, b) => a.r.net - b.r.net).slice(0, REFINE_TOP))
        for (const mix of neighbors(e.mix, types, env.excluded)) if (!tried.has(mixKey(mix))) { tried.add(mixKey(mix)); next.push({ mix, budget: e.budget }); }
      if (!next.length) break;
      for (const [k, e] of await sizes(ctx, env, next, seen, limit)) best.set(k, e);
      env.log(`уточнение ${round + 1}: соседей ${next.length}, флотов всего ${seen.size}`);
      if (round + 1 >= REFINE_MIN_ROUNDS && !(bestNet() < before)) break;  // лучший перестал улучшаться
    }
    const all = [...seen.values()];
    const ranked = all.filter(c => c.r.win >= MIN_WIN).sort((a, b) => a.r.net - b.r.net);
    for (const c of ranked) c.model = c.r;
    env.log(`перебор аналитикой ${((Date.now() - t0) / 1e3).toFixed(0)} с, флотов ${all.length}`);
    const check = async list => {
      const checked = await monteCarlo(env, list.map(c => c.fleet), VERIFY_RUNS);
      list.forEach((c, i) => { c.r = checked[i]; c.verified = true; });
    };
    let candidates;
    if (verify === "all") {
      const byMix = new Map();
      for (const c of ranked) {
        const list = byMix.get(share(c.fleet)) || byMix.set(share(c.fleet), []).get(share(c.fleet));
        if (list.length < verifySizes) list.push(c);
      }
      candidates = [...byMix.values()].slice(0, VERIFY_MIXES).flat();
      env.log(`проверяю ${candidates.length} лучших Монте-Карло по ${VERIFY_RUNS} боёв`);
      await check(candidates);
    } else {
      // Модель сходится с Монте-Карло в пределах ±0.4% потерь и шанс победы не завышает (без ЗС), поэтому
      // проверяем только лучший по модели; если он побеждает реже MIN_WIN — следующий.
      candidates = [];
      for (const c of ranked.slice(0, VERIFY_MIXES * VERIFY_SIZES)) {
        await check([c]);
        candidates.push(c);
        env.log(`Монте-Карло ${VERIFY_RUNS} боёв: ${share(c.fleet)} — победа ${Math.round(c.r.win * 100)}%`);
        if (c.r.win >= MIN_WIN) break;
      }
      candidates.push(...ranked.filter(c => !c.verified));
    }
    const rank = (a, b) => (b.r.win >= MIN_WIN) - (a.r.win >= MIN_WIN) || a.r.net - b.r.net;
    return [...new Map([...candidates].sort(rank).reverse().map(c => [share(c.fleet), c])).values()]
      .sort(rank).slice(0, top).map(c => ({ ...c, share: share(c.fleet) }));
  }

  /**
   * Весь подбор для cfg (как у A.context, без добычи: half — нули): { top — TOP лучших составов без ЗС,
   * ds — лучший флот из одних ЗС или null, start — стартовые составы справочника, refs — его ближайшие обороны }.
   * onlyDS — только ЗС; full — старт со всей сетки; mc — Монте-Карло для VERIFY_MIXES составов, не только лучшего.
   * ЗС слишком медленные, чтобы идти в общем флоте: составы с ними не перебираем, только ЗС — отдельно.
   */
  async function best(cfg, env, { onlyDS = false, full = false, mc = false } = {}) {
    const types = MILITARY.filter(n => n !== B.DS && cfg.available[n] !== 0);
    const s = onlyDS ? { mixes: [] } : starts(cfg, env, types, full);
    const top = onlyDS ? [] : await search(cfg, env, s.mixes, TOP, { types, verify: mc ? "all" : "best" });
    // Для нескольких ЗС модель завышает шанс победы — проверяем Монте-Карло все размеры, что побеждают по модели.
    const ds = cfg.available[B.DS] === 0 ? [] : await search(cfg, env, [{ [B.DS]: 1 }], 1, { verify: "all", verifySizes: Infinity });
    return { top, ds: ds[0] || null, start: s.start || null, refs: s.refs || null };
  }

  return { TOP, MIN_WIN, COARSE, EMPTY, GAP_STEP, evaluateLoss, grid, neighbors, sizeState, sizeStep, monteCarlo, table, references, candidates, search, best };
})();

if (typeof module !== "undefined") module.exports = CHEAPEST;
