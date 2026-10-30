// Подбор атаки в фоне (attack.js): {cfg} → {log: текст хода} … {top} или {error}. Остановить — terminate().
importScripts("core.js", "battle.js", "attack.js");
onmessage = async ({ data: { cfg } }) => {
  try {
    // Только составы-лидеры и до 10× стоимости обороны: полный перебор телефону не по силам.
    const top = await ATTACK.best(cfg, { run: ATTACK.local(cfg), mixes: ATTACK.leaders(cfg.available), finalRuns: 20, giveUp: 10,
      log: text => postMessage({ log: text }) });
    postMessage({ top });
  } catch (e) {
    postMessage({ error: String(e?.message || e) });
  }
};
