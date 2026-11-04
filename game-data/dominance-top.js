// Справочник для подбора самого дешёвого флота (docs/cheapest.js): сжатые итоги перебора dominance.js — для каждой
// обороны сетки и каждой дистанции TOP_K лучших составов и их отставание от лучшего. Формат — в docs/cheapest.js.
//
// node game-data/dominance-top.js pack — из game-data/dominance/ (fleets/*.bin, defenses.json, meta.json)
//                                        в docs/dominance-top.bin.gz (его грузят и страница, и best-attack.js)
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const A = require("../docs/attack.js");
const C = require("../docs/cheapest.js");

const FILE = path.join(__dirname, "..", "docs", "dominance-top.bin.gz");
const TOP_K = 10;

function pack() {
  const DIR = path.join(__dirname, "dominance");
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8"));
  const { types, defenses } = JSON.parse(fs.readFileSync(path.join(DIR, "defenses.json"), "utf8"));
  const D = defenses.length, CL = meta.columns.length, ND = meta.distSystems.length, F = meta.mixes.length;
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
    for (let d = 0; d < ND; d++) for (let j = 0; j < D; j++) net[d][f * D + j] = row[j * CL + 3 * d] + row[j * CL + 3 * d + 1];
  }
  const top = Buffer.alloc(D * ND * TOP_K * 3);
  let o = 0;
  for (let j = 0; j < D; j++) for (let d = 0; d < ND; d++) {
    const list = [];
    for (let f = 0; f < F; f++) { const v = net[d][f * D + j]; if (!Number.isNaN(v)) list.push([f, v]); }
    list.sort((a, b) => a[1] - b[1]);
    for (let r = 0; r < TOP_K; r++, o += 3) {
      const e = list[r];
      top.writeUInt16LE(e ? e[0] : C.EMPTY, o);
      top.writeUInt8(e ? Math.min(255, Math.round((e[1] - list[0][1]) / meta.budget / C.GAP_STEP)) : 255, o + 2);
    }
  }
  const head = Buffer.from(JSON.stringify({ budget: meta.budget, types, mixes: meta.mixes, distSystems: meta.distSystems,
                                            dists: meta.dists, k: TOP_K, parts }));
  const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
  fs.writeFileSync(FILE, zlib.gzipSync(Buffer.concat([len, head, Buffer.from(refs.buffer), top]), { level: 9 }));
  console.log(`оборон ${D}, дистанций ${ND}, составов ${F}, top ${TOP_K} → ${FILE} (${(fs.statSync(FILE).size / 1e6).toFixed(1)} МБ)`);
}

/** Справочник (C.table) или null, если файла нет. */
const load = () => fs.existsSync(FILE) ? C.table(new Uint8Array(zlib.gunzipSync(fs.readFileSync(FILE)))) : null;

module.exports = { FILE, load };

if (require.main === module) {
  if (process.argv[2] === "pack") pack();
  else { console.error("node game-data/dominance-top.js pack"); process.exit(2); }
}
