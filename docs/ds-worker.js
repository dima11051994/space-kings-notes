// Расчёт ЗС в фоне, чтобы список целей не подвисал: {key, side, att, def} → {key, n}.
importScripts("battle.js");
onmessage = ({ data: { key, side, att, def } }) => {
  let n;
  try { n = BATTLE.deathStars(side, BATTLE.types(att.techs, att.premium), BATTLE.types(def.techs, false)); }
  catch { n = null; }  // неизвестный юнит в отчёте
  postMessage({ key, n });
};
