// Поток подбора самого дешёвого флота (cheapest.js): страница держит несколько таких потоков и раздаёт им флоты.
// {cfg} — цель (как у ATTACK.context); {id, fleet, runs} → {id, r} — оценка evaluateLoss (runs = 0 — аналитикой)
// или {id, error}.
importScripts("core.js", "battle.js", "attack.js", "analytic.js", "cheapest.js");
let ctx = null;
onmessage = ({ data }) => {
  if (data.cfg) { ctx = ATTACK.context(data.cfg); return; }
  try {
    postMessage({ id: data.id, r: CHEAPEST.evaluateLoss(ctx, data.fleet, data.runs) });
  } catch (e) {
    postMessage({ id: data.id, error: String(e?.message || e) });
  }
};
