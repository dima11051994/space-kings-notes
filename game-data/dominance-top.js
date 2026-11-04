// Сжатые итоги перебора dominance.js: для каждой обороны сетки и каждой дистанции — TOP_K лучших составов
// и их отставание от лучшего. По ним best-attack.js берёт стартовые составы для заданной обороны вместо
// всей сетки (references / candidates).
//
// node game-data/dominance-top.js pack — из game-data/dominance/ (fleets/*.bin, defenses.json, meta.json)
//                                        в game-data/dominance-top.bin.gz
//
// Формат (gzip): uint32 длина заголовка, заголовок JSON { budget, types, mixes, distSystems, dists, k, parts },
// затем обороны: по `parts` байт — номера типов в `types` (каждый — 1/parts бюджета, повторы складываются),
// затем на каждую оборону × дистанцию k записей: uint16 номер состава в `mixes` (0xffff — пусто) и uint8
// отставание чистых потерь от лучшего, в 0.1% бюджета (255 — 25.5% и больше).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const A = require("../docs/attack.js");

const FILE = path.join(__dirname, "dominance-top.bin.gz");
const TOP_K = 10;
const EMPTY = 0xffff;
const GAP_STEP = 0.001;  // доля бюджета обороны на единицу отставания

function pack() {
  const DIR = path.join(__dirname, "dominance");
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8"));
  const { types, defenses } = JSON.parse(fs.readFileSync(path.join(DIR, "defenses.json"), "utf8"));
  const D = defenses.length, C = meta.columns.length, ND = meta.distSystems.length, F = meta.mixes.length;
  // Обороны сетки — доли типов шагом 1/parts: восстанавливаем доли по стоимости.
  const parts = 5;
  const refs = new Uint8Array(D * parts);
  defenses.forEach((def, j) => {
    let p = 0;
    types.forEach((n, t) => {
      const k = Math.round((def[n] || 0) * A.costOf(n) / (meta.budget / parts));
      for (let i = 0; i < k; i++) refs[j * parts + p++] = t;
    });
    if (p !== parts) throw new Error(`оборона ${j}: долей ${p}, нужно ${parts}`);
  });
  // Чистые потери (бой + полёт): net[d][f * D + j], NaN — не побеждает.
  const net = Array.from({ length: ND }, () => new Float32Array(F * D));
  for (let f = 0; f < F; f++) {
    const buf = fs.readFileSync(path.join(DIR, "fleets", `${f}.bin`)), row = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    for (let d = 0; d < ND; d++) for (let j = 0; j < D; j++) net[d][f * D + j] = row[j * C + 3 * d] + row[j * C + 3 * d + 1];
  }
  const top = Buffer.alloc(D * ND * TOP_K * 3);
  let o = 0;
  for (let j = 0; j < D; j++) for (let d = 0; d < ND; d++) {
    const list = [];
    for (let f = 0; f < F; f++) { const v = net[d][f * D + j]; if (!Number.isNaN(v)) list.push([f, v]); }
    list.sort((a, b) => a[1] - b[1]);
    for (let r = 0; r < TOP_K; r++, o += 3) {
      const e = list[r];
      top.writeUInt16LE(e ? e[0] : EMPTY, o);
      top.writeUInt8(e ? Math.min(255, Math.round((e[1] - list[0][1]) / meta.budget / GAP_STEP)) : 255, o + 2);
    }
  }
  const head = Buffer.from(JSON.stringify({ budget: meta.budget, types, mixes: meta.mixes, distSystems: meta.distSystems,
                                            dists: meta.dists, k: TOP_K, parts }));
  const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  fs.writeFileSync(FILE, zlib.gzipSync(Buffer.concat([len, head, Buffer.from(refs.buffer), top]), { level: 9 }));
  console.log(`оборон ${D}, дистанций ${ND}, составов ${F}, top ${TOP_K} → ${FILE} (${(fs.statSync(FILE).size / 1e6).toFixed(1)} МБ)`);
}

let cache;
function load() {
  if (cache !== undefined) return cache;
  if (!fs.existsSync(FILE)) return (cache = null);
  const buf = zlib.gunzipSync(fs.readFileSync(FILE)), len = buf.readUInt32LE(0);
  const head = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  const D = (buf.length - 4 - len) / (head.parts + head.distSystems.length * head.k * 3);
  const refs = buf.subarray(4 + len, 4 + len + D * head.parts);
  return (cache = { ...head, D, refs, top: buf.subarray(4 + len + D * head.parts) });
}

const REFS = 5;  // столько ближайших оборон сетки усредняем

/**
 * Ближайшие к `defense` обороны сетки (по долям стоимости типов, расстояние L1; купола и типы вне сетки
 * не учитываются) и ближайшая сохранённая дистанция к `dist`. null — нет файла или в обороне нет типов сетки.
 */
function references(defense, dist) {
  const T = load();
  if (!T) return null;
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
    if (near.length < REFS || l1 < near.at(-1).l1) {
      near.push({ j, l1 });
      near.sort((a, b) => a.l1 - b.l1);
      if (near.length > REFS) near.pop();
    }
  }
  const d = T.dists.reduce((b, x, i) => Math.abs(Math.log(x / dist)) < Math.abs(Math.log(T.dists[b] / dist)) ? i : b, 0);
  const describe = j => {
    const n = new Map();
    for (let p = 0; p < T.parts; p++) { const k = T.types[T.refs[j * T.parts + p]]; n.set(k, (n.get(k) || 0) + 100 / T.parts); }
    return [...n].map(([k, v]) => `${k} ${v}%`).join(" + ");
  };
  return { table: T, d, distSystems: T.distSystems[d], near: near.map(x => ({ ...x, key: describe(x.j) })) };
}

/**
 * Составы-кандидаты для `defense` на дистанции `dist`: средневзвешенное (вес 1/(L1 + 0.05)) отставание
 * от лучшего по ближайшим оборонам сетки; состав вне top-k обороны считается с отставанием 25.5%.
 * Возвращает до `count` лучших { mix, gap — среднее отставание, доля бюджета обороны } и refs — что взяли.
 */
function candidates(defense, dist, count, allow = () => true) {
  const refs = references(defense, dist);
  if (!refs) return null;
  const T = refs.table, ND = T.distSystems.length;
  // Отставания составов в top-k каждой ближайшей обороны: [{ w, gaps: Map(состав → отставание) }].
  const near = refs.near.map(({ j, l1 }) => {
    const gaps = new Map();
    for (let r = 0, o = (j * ND + refs.d) * T.k * 3; r < T.k; r++, o += 3) {
      const f = T.top.readUInt16LE(o);
      if (f !== EMPTY) gaps.set(f, T.top.readUInt8(o + 2));
    }
    return { w: 1 / (l1 + 0.05), gaps };
  });
  const wsum = near.reduce((s, x) => s + x.w, 0);
  const all = new Set(near.flatMap(x => [...x.gaps.keys()]));
  const list = [...all].map(f => {
    const s = near.reduce((s, x) => s + x.w * (x.gaps.has(f) ? x.gaps.get(f) : 255), 0);
    return { mix: A.parseMix(T.mixes[f]), key: T.mixes[f], gap: s / wsum * GAP_STEP };
  })
    .filter(c => allow(c.mix)).sort((a, b) => a.gap - b.gap).slice(0, count);
  return { list, refs };
}

module.exports = { FILE, references, candidates };

if (require.main === module) {
  if (process.argv[2] === "pack") pack();
  else { console.error("node game-data/dominance-top.js pack"); process.exit(2); }
}
