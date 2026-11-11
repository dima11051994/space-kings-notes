// Сообщения экспедиций (открыть в игре папку сообщений экспедиций заранее): проходит страницы 1-30, 31-60, …
// и после каждой сохраняет {at, messages: [{date, from, subject, text}]} (новые первыми) в bot/expeditions-raw.json.
// Прежний файл → expeditions-raw.json.bak. Запуск: node bot/expeditions.js [сколько страниц, по умолчанию все]
const fs = require("fs");
const path = require("path");
const { screen, chooseRange } = require("./sk.js");

const OUT = path.join(__dirname, "expeditions-raw.json");
const pages = Number(process.argv[2]) || Infinity;
if (fs.existsSync(OUT)) fs.copyFileSync(OUT, OUT + ".bak");

const DATE = /^\d\d\.\d\d\.\d\d \d\d:\d\d:\d\d$/;
const CONTROLS = /^(Только шпионский доклад|Удалить отмеченные сообщения)/;  // элементы под последним сообщением
/**
 * Сообщения страницы по порядку: дата (x1=285), от (450), тема (723), затем текст — первый непустой View x1=129
 * (в нём и боевой доклад пиратов/пришельцев, которого нет в TextView). Сообщение без текста сохраняется с text "".
 */
function messages(nodes) {
  const list = [];
  let head = null;
  for (const n of nodes) {
    if (n.x1 === 285 && DATE.test(n.text) && n.cls === "android.view.View") {
      if (head) list.push({ ...head, text: "" });
      const cell = x1 => nodes.find(m => m.x1 === x1 && m.y1 === n.y1 && m.cls === "android.view.View")?.text || "";
      head = { date: n.text, from: cell(450), subject: cell(723) };
    } else if (head && n.x1 === 129 && n.text && n.cls === "android.view.View" && !CONTROLS.test(n.text)) {
      list.push({ ...head, text: n.text });
      head = null;
    }
  }
  if (head) list.push({ ...head, text: "" });
  return list;
}

/** Пока листали, могли прийти новые сообщения и сдвинуть страницы: убрать повтор хвоста. */
function append(all, page) {
  const key = m => `${m.date}|${m.text}`;
  for (let k = Math.min(all.length, page.length); k > 0; k--) {
    if (all.slice(-k).every((m, i) => key(m) === key(page[i]))) return all.push(...page.slice(k)), k;
  }
  all.push(...page);
  return 0;
}

const all = [];
for (let lo = 1, n = 0; n < pages; lo += 30, n++) {
  const label = `${lo}-${lo + 29}`;
  if (!chooseRange(m => m.x1 === 741, label)) { console.log(`страницы ${label} нет — конец`); break; }
  const page = messages(screen());
  const dup = append(all, page);
  fs.writeFileSync(OUT, JSON.stringify({ at: Date.now(), messages: all }, null, 1));
  console.log(`${label}: ${page.length}${dup ? `, повтор ${dup}` : ""}, последнее ${page.at(-1)?.date ?? "—"}`);
  if (page.length < 30) break;
}
console.log(`Сообщений: ${all.length} → ${OUT}`);
