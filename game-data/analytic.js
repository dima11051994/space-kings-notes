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
// node game-data/analytic.js [прогонов МК] — сравнение с Монте-Карло docs/battle.js на целях game-data/attack-study.
const B = require("../docs/battle.js");

const RES = 100;  // шаг брони — 1% от полной
const EPS = 1e-9;
const TAIL = 1e-6;  // хвост Пуассона и массы мельче этого не досчитываем
// Состояние юнита: c ячеек щита (0..100) × броня k шагов (0..RES), индекс c * W + k; три рабочих буфера roundOn.
const W = RES + 1, BUF = [0, 1, 2].map(() => new Float64Array(101 * W));

/** Сторона: {тип: Map(броня в шагах → ожидаемое число живых)}. */
const sideOf = spec => Object.fromEntries(Object.entries(spec).filter(([, n]) => n > 0)
  .map(([name, n]) => [name, new Map([[RES, n]])]));
const total = m => { let s = 0; for (const v of m.values()) s += v; return s; };
const counts = side => Object.fromEntries(Object.entries(side).map(([n, m]) => [n, total(m)]));

/**
 * Один раунд по цели типа t: start — Map(броня → масса живых), hits — [{dmg, lambda}] по типам стрелков
 * в порядке стрельбы. Возвращает {alive: Map(броня → масса), dead: доля погибших}.
 */
function roundOn(t, start, hits) {
  const n = total(start);
  if (!n) return { alive: new Map(), dead: 0 };
  // Распределение по состояниям — разреженно: значения в буфере + список занятых индексов; погибшие выпадают.
  // Буферы общие (BUF): вне вызова все нулевые, поэтому чистим только занятые индексы.
  const cell = t.shield / 100, q = t.hull / RES;
  let [dist, next, out] = BUF, act = [];
  for (const [k, v] of start) { const s = 100 * W + k; if (!dist[s]) act.push(s); dist[s] += v / n; }  // щит полный
  // Типы стрелков бьют по очереди (как в бою: в порядке списка), каждый — Пуассон(λ) попаданий.
  for (const h of hits) {
    if (h.lambda < EPS || !h.dmg || (t.shield > 0 && h.dmg < cell)) continue;  // нет попаданий или отскок
    const cells = cell > 0 ? Math.floor(h.dmg / cell + 1e-9) : 0;
    let nact = [];
    const oact = [];
    let logP = -h.lambda, cum = 0;
    for (let hit = 0; ; hit++) {
      const p = Math.exp(logP);
      let mass = 0;
      for (const s of act) { if (!out[s]) oact.push(s); out[s] += p * dist[s]; mass += dist[s]; }
      cum += p;
      if (cum > 1 - TAIL || mass < TAIL) break;
      for (const s of act) {  // ещё одно попадание
        const w = dist[s];
        dist[s] = 0;
        if (w < TAIL * 1e-3) continue;
        const c = (s / W) | 0, k = s - c * W;
        if (h.dmg <= c * cell + 1e-9) {  // щит поглощает целыми ячейками
          const s2 = s - cells * W;
          if (!next[s2]) nact.push(s2);
          next[s2] += w;
          continue;
        }
        const hull = k * q - (h.dmg - c * cell);
        if (hull <= 0) continue;
        // Взрыв с вероятностью 1 − left; броню делим между соседними шагами, чтобы среднее не сдвигалось
        // (иначе мелкие попадания по крупной броне, как у ЗС, округлялись бы в ноль).
        const left = hull / t.hull, x = hull / q, k2 = Math.floor(x), f = x - k2, ws = left < 0.7 ? w * left : w;
        const lo = k2 > 1 ? k2 : 1;
        if (!next[lo]) nact.push(lo);
        next[lo] += ws * (1 - f);
        if (f > 0) { if (!next[k2 + 1]) nact.push(k2 + 1); next[k2 + 1] += ws * f; }
      }
      [dist, next, act, nact] = [next, dist, nact, []];
      logP += Math.log(h.lambda / (hit + 1));
    }
    for (const s of act) { if (!out[s]) oact.push(s); out[s] += (1 - cum) * dist[s]; dist[s] = 0; }  // хвост Пуассона (< TAIL)
    [dist, out] = [out, dist];
    act = oact;
  }
  const alive = new Map();
  let aliveMass = 0;
  for (const s of act) {
    if (!dist[s]) continue;
    const k = s % W;
    alive.set(k, (alive.get(k) || 0) + dist[s] * n);
    aliveMass += dist[s];
    dist[s] = 0;
  }
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
  return Object.fromEntries(Object.entries(after).map(([n, m]) => {
    const was = total(before[n]), now = total(m), f = now > 0 ? Math.min(w < 1 ? 1 / (1 - w) : Infinity, was / now) : 0;
    return [n, new Map([...m].map(([k, v]) => [k, v * f]))];
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

module.exports = { analyze };

if (require.main === module) compare();

/** Сравнение с Монте-Карло: цели attack-study × составы-лидеры и чистые × размер флота. */
function compare() {
  const fs = require("fs"), path = require("path");
  const AT = require("../docs/attack.js");
  const RUNS = Number(process.argv[2]) || 200;
  const samples = fs.readFileSync(path.join(__dirname, "attack-study/samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const mixes = ["ЗС 100", "ЛинКр 100", "Бомб 10 + ЛинКр 90", "ЗС 30 + ЛинКр 70", "Кр 100", "Лк 100", "ЛИ 100", "Бомб 100"]
    .map(AT.parseMix);
  const loss = (before, after) => Object.entries(before).reduce((s, [n, k]) => s + (k - (after[n] || 0)) * AT.costOf(n), 0);
  const rows = [];
  let tA = 0, tM = 0;
  for (const s of samples) {
    const T = { A: B.types(s.attacker.techs, s.attacker.premium), D: B.types(s.defender.techs, false) };
    const dc = AT.defenseCost(s.defense);
    for (const mix of mixes) for (const x of [0.5, 1, 2, 4]) {
      const fleet = {};
      for (const [n, sh] of Object.entries(mix)) { const k = Math.floor(dc * x * sh / AT.costOf(n)); if (k > 0) fleet[n] = k; }
      if (!Object.keys(fleet).length) continue;
      let t0 = process.hrtime.bigint();
      const a = analyze(fleet, s.defense, T.A, T.D);
      tA += Number(process.hrtime.bigint() - t0); t0 = process.hrtime.bigint();
      const mc = { win: 0, attLoss: 0, defLoss: 0, attL2: 0 };
      for (let i = 0; i < RUNS; i++) {
        const r = B.battle(fleet, s.defense, T.A, T.D), l = loss(fleet, r.att);
        mc.win += r.winner === "att"; mc.attLoss += l; mc.attL2 += l * l; mc.defLoss += loss(s.defense, r.def);
      }
      tM += Number(process.hrtime.bigint() - t0);
      for (const k of ["win", "attLoss", "defLoss", "attL2"]) mc[k] /= RUNS;
      const sd = Math.sqrt(Math.max(0, mc.attL2 - mc.attLoss ** 2) / RUNS);  // ошибка среднего МК
      rows.push({ target: s.label, fleet: AT.mixKey(mix) + " ×" + x, units: Math.min(Object.values(fleet).reduce((p, q) => p + q, 0), Object.values(s.defense).reduce((p, q) => p + q, 0)),
        winA: a.win.att, winM: mc.win, lossA: loss(fleet, a.att), lossM: mc.attLoss, sd, defA: loss(s.defense, a.def), defM: mc.defLoss,
        dc: AT.defenseCost(s.defense), fc: Object.entries(fleet).reduce((p, [n, k]) => p + k * AT.costOf(n), 0) });
    }
  }
  const pct = v => (v * 100).toFixed(0).padStart(4) + "%", pct1 = v => (v * 100).toFixed(1).padStart(6) + "%";
  const mln = v => (v / 1e6).toFixed(2).padStart(8);
  console.log("цель | флот | P(победа) анал/МК | потери атакующего, млн анал/МК (±σ МК) | уничтожено обороны, млн анал/МК");
  for (const r of rows) console.log(`${r.target.slice(0, 34).padEnd(34)} ${r.fleet.padEnd(24)} ${pct(r.winA)}${pct(r.winM)} |${mln(r.lossA)}${mln(r.lossM)} ±${(r.sd / 1e6).toFixed(2)} |${mln(r.defA)}${mln(r.defM)}`);
  // Сводка: ошибка в долях стоимости флота / обороны, чтобы большие и малые бои были сравнимы.
  const err = rows.map(r => ({ win: Math.abs(r.winA - r.winM), loss: Math.abs(r.lossA - r.lossM) / r.fc, def: Math.abs(r.defA - r.defM) / r.dc,
    big: r.units >= 30 }));
  const q = (list, k, p) => { const v = list.map(e => e[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
  for (const [name, list] of [["все", err], ["у обеих сторон ≥30 юнитов", err.filter(e => e.big)], ["у кого-то <30 юнитов", err.filter(e => !e.big)]]) {
    if (!list.length) continue;
    console.log(`\n${name} (${list.length} боёв): медиана / 90% / макс`);
    console.log(`  |ΔP(победа)|                     ${["win"].flatMap(k => [0.5, 0.9, 1].map(p => pct1(q(list, k, p)))).join(" ")}`);
    console.log(`  |Δпотерь| / стоимость флота       ${[0.5, 0.9, 1].map(p => pct1(q(list, "loss", p))).join(" ")}`);
    console.log(`  |Δуничтожено| / стоимость обороны ${[0.5, 0.9, 1].map(p => pct1(q(list, "def", p))).join(" ")}`);
  }
  console.log(`\nвремя: аналитика ${(tA / 1e6).toFixed(0)} мс на ${rows.length} боёв, МК ${(tM / 1e6).toFixed(0)} мс (${RUNS} прогонов на бой)`);
}
