// Разбор сообщений экспедиций из bot/expeditions-raw.json (собирает node bot/expeditions.js).
// Ценность — сумма металл+кристалл+дейтерий; найденные корабли и потери флота — по стоимости постройки (game-data/units.json).
// Запуск: node bot/expedition-report.js [флот экспедиции, по умолчанию «81 Мега-транспорт, 3 Уничтожитель»]
const path = require("path");
const { messages } = require("./expeditions-raw.json");
const { ships } = require("../game-data/units.json");

const cost = Object.fromEntries(ships.map(s => [s.name, Object.values(s.cost).reduce((a, b) => a + b, 0)]));
const FLEET = (process.argv[2] || "81 Мега-транспорт, 3 Уничтожитель").split(/,\s*/).map(x => x.match(/^(\d+) (.+)$/)).map(([, n, name]) => [name, +n]);
const fleetValue = FLEET.reduce((s, [name, n]) => s + n * cost[name], 0);

const num = s => +s.replace(/\./g, "");
const fmt = n => Math.round(n).toLocaleString("ru");
const at = d => { const [dd, mm, yy, h, mi, ss] = d.split(/[.: ]/).map(Number); return new Date(2000 + yy, mm - 1, dd, h, mi, ss).getTime(); };

function classify(text) {
  let m;
  if ((m = text.match(/добыли ([\d.]+) металла, ([\d.]+) кристалла и ([\d.]+) дейтерия/)))
    return { kind: "ресурсы", res: [num(m[1]), num(m[2]), num(m[3])] };
  if (/обнаружили:/.test(text)) {
    const found = [...text.matchAll(/([А-ЯЁа-яё -]+?): (\d+) шт\./g)].map(([, n, c]) => [n.trim(), +c]);
    const unknown = found.filter(([n]) => !(n in cost)).map(([n]) => n);
    if (unknown.length) throw new Error(`нет цены корабля: ${unknown.join(", ")}`);
    return { kind: "корабли", found, value: found.reduce((s, [n, c]) => s + c * cost[n], 0) };
  }
  if ((m = text.match(/обнаружила (\d+) квид/))) return { kind: "квиды", quids: +m[1] };
  if ((m = text.match(/Ваши потери: (\d+)\s+Потери (пиратов|пришельцев): (\d+)/)))
    return { kind: m[2] === "пиратов" ? "бой с пиратами" : "бой с пришельцами", lost: +m[1], enemy: +m[3] };
  if (/От экспедиции осталось только/.test(text)) return { kind: "флот потерян", lost: fleetValue };
  if (/(Двигатель|Расходник|Модуль|Броня|Оружие) .* Характеристики:/.test(text))
    return { kind: "предмет флагмана", item: text.match(/(?:Двигатель|Расходник|Модуль|Броня|Оружие) [^:]*?(?= Характеристики)/)[0] };
  if (/затянется|задержк|позже|опоздани/i.test(text)) return { kind: "задержка возврата" };
  if (/раньше|сократить обратный|ускорил/i.test(text)) return { kind: "ускоренный возврат" };
  return { kind: "пусто" };
}

const outcomes = messages.filter(m => m.text !== "Флот вернулся из экспедиции.").map(m => ({ ...m, ...classify(m.text) }));
const returns = messages.length - outcomes.length;
const times = outcomes.map(o => at(o.date));
const days = (Math.max(...times) - Math.min(...times)) / 864e5;

const groups = {};
for (const o of outcomes) (groups[o.kind] ??= []).push(o);
const sum = (list, f) => list.reduce((s, o) => s + (f(o) || 0), 0);

const res = [0, 1, 2].map(i => sum(outcomes, o => o.res?.[i]));
const resTotal = res[0] + res[1] + res[2];
const shipValue = sum(outcomes, o => o.value);
const lost = sum(outcomes, o => o.lost);
const quids = sum(outcomes, o => o.quids);
const net = resTotal + shipValue - lost;
const n = outcomes.length;

console.log(`Период: ${outcomes.at(-1).date} — ${outcomes[0].date} (${days.toFixed(2)} сут.), экспедиций: ${n}, возвратов флота: ${returns}`);
console.log(`В сутки: ${(n / days).toFixed(1)} экспедиций\n`);
console.log("Исходы:");
for (const [kind, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length))
  console.log(`  ${kind.padEnd(20)} ${String(list.length).padStart(4)}  ${(100 * list.length / n).toFixed(1).padStart(5)}%`);
console.log(`\nРесурсы: ${fmt(res[0])} мет., ${fmt(res[1])} крист., ${fmt(res[2])} дейт. = ${fmt(resTotal)}`);
const r = groups["ресурсы"] || [];
console.log(`  находка ресурсов: в среднем ${fmt(resTotal / r.length)}, от ${fmt(Math.min(...r.map(o => o.res[0] + o.res[1] + o.res[2])))} до ${fmt(Math.max(...r.map(o => o.res[0] + o.res[1] + o.res[2])))}`);
const found = {};
for (const o of groups["корабли"] || []) for (const [name, c] of o.found) found[name] = (found[name] || 0) + c;
console.log(`Корабли (стоимость постройки ${fmt(shipValue)}): ${Object.entries(found).sort((a, b) => b[1] * cost[b[0]] - a[1] * cost[a[0]]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`Квиды: ${quids}`);
console.log(`Предметы флагмана: ${(groups["предмет флагмана"] || []).map(o => o.item).join("; ") || "—"}`);
console.log(`Потери: в боях ${fmt(sum(outcomes.filter(o => o.kind.startsWith("бой")), o => o.lost))}, `
  + `потерянный флот ${(groups["флот потерян"] || []).length} × ${fmt(fleetValue)} (${FLEET.map(([k, v]) => `${v} ${k}`).join(", ")})`);
console.log(`\nИтого чистыми (ресурсы + корабли − потери): ${fmt(net)}`);
console.log(`  на экспедицию: ${fmt(net / n)}`);
console.log(`  в сутки: ${fmt(net / days)}; на один слот в сутки (${(n / days / 6).toFixed(1)} экспедиций при 6 слотах): ${fmt(net / days / 6)}`);
