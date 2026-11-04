// Аналитическая (без случайности) модель боя: те же правила, что в docs/battle.js, но вместо прогона отдельных
// юнитов — матожидания. Для каждого типа хранится распределение юнитов по оставшейся броне; за раунд:
//   • выстрелов у стрелка типа i в среднем 1 / Σ_j (p_j / r_ij), p_j — доля целей типа j, r — скорострел (1, если нет);
//   • каждая цель получает от стрелков типа i Пуассон(λ_i) попаданий, λ_i = N_i · E[выстрелов_i] / N_целей —
//     одинаково для любой цели, потому что цель выбирается равномерно (мёртвые в этом раунде тоже ловят выстрелы);
//   • типы стрелков бьют по очереди, в порядке списка, как в бою (поэтому лёгкая оборона, стоящая в списке первой,
//     снимает щиты до выстрелов тяжёлой); по цепочке попаданий точно считаются щит (целыми 1%, отскок), броня
//     и шанс взрыва — динамикой по состояниям (ячейки щита × броня с шагом 1%, остаток делится между соседними
//     шагами), с весами Пуассона.
// Конец боя: вероятность, что сторона выбита целиком, — Π по типам (доля погибших)^(число юнитов);
// дальше бой идёт только в оставшейся вероятности, состояние стороны — при условии, что она не выбита.
//
// Сверено с Монте-Карло (435 боёв, 100 прогонов): при ≥30 юнитах у каждой стороны в 90% боёв ошибка потерь
// атакующего ≤ 0.7% стоимости флота (макс. 7%), уничтоженной обороны ≤ 0.5% (макс. 6%); в ~20 раз быстрее 100 прогонов.
// Хуже при единицах крупных юнитов (ЗС): там важен разброс, и вероятность победы около порога ошибается до 25%.
//
// Общий код страницы (cheapest-worker.js) и game-data. Сверка с Монте-Карло — node game-data/analytic.js [прогонов МК].
const ANALYTIC = (() => {
  const B = typeof BATTLE !== "undefined" ? BATTLE : require("./battle.js");

  const RES = 100;  // шаг брони — 1% от полной
  const EPS = 1e-9;
  const TAIL = 1e-6;  // хвост Пуассона и массы мельче этого не досчитываем
  // Состояние юнита: c ячеек щита (0..100) × броня k шагов (0..RES), индекс c * W + k.
  const W = RES + 1, SIZE = 101 * W;
  // Рабочие буферы roundOn — разреженное распределение по состояниям: значения v, отметка m «индекс в списке» и
  // список занятых индексов l[0..n). Вне вызова все пустые, поэтому чистим только занятые индексы.
  const buffer = () => ({ v: new Float64Array(SIZE), m: new Uint8Array(SIZE), l: new Int32Array(SIZE), n: 0 });
  const BUF = [buffer(), buffer(), buffer()];
  const put = (b, s, x) => { if (!b.m[s]) { b.m[s] = 1; b.l[b.n++] = s; } b.v[s] += x; };

  /** Сторона: {тип: Float64Array(W) — ожидаемое число живых по броне в шагах}. */
  const sideOf = spec => Object.fromEntries(Object.entries(spec).filter(([, n]) => n > 0)
    .map(([name, n]) => { const a = new Float64Array(W); a[RES] = n; return [name, a]; }));
  const total = a => { let s = 0; for (let k = 0; k < W; k++) s += a[k]; return s; };
  const counts = side => Object.fromEntries(Object.entries(side).map(([n, a]) => [n, total(a)]));

  /**
   * Один раунд по цели типа t: start — Float64Array(W) (броня → масса живых), hits — [{dmg, lambda}] по типам
   * стрелков в порядке стрельбы. Возвращает {alive: Float64Array(W) (броня → масса), dead: доля погибших}.
   */
  function roundOn(t, start, hits) {
    const n = total(start), alive = new Float64Array(W);
    if (!n) return { alive, dead: 0 };
    // Распределение по состояниям — в буферах BUF (разреженно); погибшие выпадают.
    const shield = t.shield, cell = shield / 100, q = t.hull / RES, hull0 = t.hull, tiny = TAIL * 1e-3;
    let [dist, next, out] = BUF;
    for (let k = 0; k < W; k++) if (start[k] > 0) put(dist, 100 * W + k, start[k] / n);  // щит полный
    // Типы стрелков бьют по очереди (как в бою: в порядке списка), каждый — Пуассон(λ) попаданий.
    for (const h of hits) {
      const dmg = h.dmg, lambda = h.lambda;
      if (lambda < EPS || !dmg || (shield > 0 && dmg < cell)) continue;  // нет попаданий или отскок
      const cells = cell > 0 ? Math.floor(dmg / cell + 1e-9) : 0;
      let logP = -lambda, cum = 0;
      for (let hit = 0; ; hit++) {
        const p = Math.exp(logP), dv = dist.v, dl = dist.l, dn = dist.n;
        let mass = 0;
        for (let i = 0; i < dn; i++) { const s = dl[i], w = dv[s]; put(out, s, p * w); mass += w; }
        cum += p;
        if (cum > 1 - TAIL || mass < TAIL) break;
        for (let i = 0; i < dn; i++) {  // ещё одно попадание
          const s = dl[i], w = dv[s];
          dv[s] = 0; dist.m[s] = 0;
          if (w < tiny) continue;
          const c = (s / W) | 0, k = s - c * W;
          if (dmg <= c * cell + 1e-9) { put(next, s - cells * W, w); continue; }  // щит поглощает целыми ячейками
          const hull = k * q - (dmg - c * cell);
          if (hull <= 0) continue;
          // Взрыв с вероятностью 1 − left; броню делим между соседними шагами, чтобы среднее не сдвигалось
          // (иначе мелкие попадания по крупной броне, как у ЗС, округлялись бы в ноль).
          const left = hull / hull0, x = hull / q, k2 = Math.floor(x), f = x - k2, ws = left < 0.7 ? w * left : w;
          put(next, k2 > 1 ? k2 : 1, ws * (1 - f));
          if (f > 0) put(next, k2 + 1, ws * f);
        }
        dist.n = 0;
        [dist, next] = [next, dist];
        logP += Math.log(lambda / (hit + 1));
      }
      const dv = dist.v, dl = dist.l;
      for (let i = 0; i < dist.n; i++) { const s = dl[i]; put(out, s, (1 - cum) * dv[s]); dv[s] = 0; dist.m[s] = 0; }  // хвост Пуассона (< TAIL)
      dist.n = 0;
      [dist, out] = [out, dist];
    }
    let aliveMass = 0;
    const dv = dist.v, dl = dist.l;
    for (let i = 0; i < dist.n; i++) {
      const s = dl[i], v = dv[s];
      dv[s] = 0; dist.m[s] = 0;
      alive[s % W] += v * n;
      aliveMass += v;
    }
    dist.n = 0;
    return { alive, dead: Math.max(0, 1 - aliveMass) };
  }

  /** Новое состояние стороны `targets` под огнём `shooters` (обе — на начало раунда) и вероятность, что она выбита. */
  function volley(shooters, targets, ST, TT) {
    const tc = counts(targets), N = Object.values(tc).reduce((a, b) => a + b, 0);
    const hits = [];
    for (const [name, m] of Object.entries(shooters)) {
      const ni = total(m), t = ST[name];
      if (ni < EPS) continue;
      let inv = 0;
      for (const [j, nj] of Object.entries(tc)) inv += nj / N / (t.rf[j] || 1);
      hits.push({ dmg: t.attack, lambda: ni / inv / N });
    }
    const next = {};
    let logWipe = 0;
    for (const [name, m] of Object.entries(targets)) {
      const r = roundOn(TT[name], m, hits);
      next[name] = r.alive;
      logWipe += tc[name] * Math.log(Math.max(r.dead, 1e-300));
    }
    return { next, wipe: Math.exp(logWipe) };
  }

  /**
   * Сторона после раунда при условии, что она не выбита (вероятность выбить — w): живые × 1/(1 − w),
   * но не больше, чем было в начале раунда (независимость юнитов — приближение, без ограничения при w → 1 разносит).
   */
  function survived(after, w, before) {
    return Object.fromEntries(Object.entries(after).map(([n, a]) => {
      const was = total(before[n]), now = total(a), f = now > 0 ? Math.min(w < 1 ? 1 / (1 - w) : Infinity, was / now) : 0;
      const b = new Float64Array(W);
      for (let k = 0; k < W; k++) b[k] = a[k] * f;
      return [n, b];
    }));
  }

  /**
   * Бой в матожиданиях. Возвращает {att, def — ожидаемые уцелевшие по типам, win: {att, def, draw} — вероятности}.
   * attTypes / defTypes — из B.types().
   */
  function analyze(attSpec, defSpec, attTypes, defTypes) {
    let A = sideOf(attSpec), D = sideOf(defSpec), m = 1;
    const win = { att: 0, def: 0, draw: 0 }, endA = {}, endD = {};
    const acc = (to, side, w) => { for (const [n, c] of Object.entries(counts(side))) to[n] = (to[n] || 0) + c * w; };
    for (let round = 0; round < 6 && m > EPS; round++) {
      const toD = volley(A, D, attTypes, defTypes), toA = volley(D, A, defTypes, attTypes);
      const wA = toA.wipe, wD = toD.wipe;
      // Состояние стороны при условии, что она не выбита.
      const A2 = survived(toA.next, wA, A), D2 = survived(toD.next, wD, D);
      win.att += m * wD * (1 - wA); acc(endA, A2, m * wD * (1 - wA));
      win.def += m * wA * (1 - wD); acc(endD, D2, m * wA * (1 - wD));
      win.draw += m * wA * wD;
      m *= (1 - wA) * (1 - wD);
      A = A2; D = D2;
    }
    win.draw += m; acc(endA, A, m); acc(endD, D, m);
    return { att: endA, def: endD, win };
  }


  return { analyze };
})();

if (typeof module !== "undefined") module.exports = ANALYTIC;
