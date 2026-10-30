// Прогон боя во встроенном симуляторе игры («Флот → Симулятор»): node game-data/game-sim.js '<атака JSON>' '<оборона JSON>'
// Технологии обеих сторон — кнопкой «Технологии» (уровни владельца). Ничего не отправляет: только «Расчитать бой».
const { screen, tap, swipe, menu, sleep, setField, withLock, adb } = require("../bot/sk.js");

const COL = { att: 573, def: 828 };
const yo = s => s.replace(/ё/g, "е");

function hideKeyboard() {
  if (/mInputShown=true/.test(adb("shell", "dumpsys", "input_method"))) { tap(50, 1000); sleep(600); }
}

function openSimulator() {
  for (let i = 0; i < 3; i++) {
    sleep(800);
    menu("Флот");
    sleep(1500);
    if (screen().some(n => /^Флоты \d+ из \d+$/.test(n.text))) break;
  }
  const tab = screen().find(n => n.text === "Симулятор" && n.click);
  if (!tab) throw new Error("нет вкладки «Симулятор»");
  tap(tab.x, tab.y);
  sleep(3000);
  // «Очистить» и «Технологии» в обеих колонках.
  const nodes = screen();
  for (const label of ["Очистить", "Технологии"]) {
    for (const x of [COL.att, COL.def]) {
      const b = nodes.filter(n => n.text === label && n.click && Math.abs(n.x - x) < 60)[0];
      if (!b) throw new Error(`нет кнопки «${label}»`);
      tap(b.x, b.y);
      sleep(1200);
    }
  }
}

/** Заполнить поля, прокручивая форму только вниз (жест вниз у верха страницы её перезагружает). */
function fill(att, def) {
  const todo = [...Object.entries(att).map(([n, v]) => ({ n, v, x: COL.att })), ...Object.entries(def).map(([n, v]) => ({ n, v, x: COL.def }))];
  // После ввода страница сдвигается (клавиатура), поэтому экран перечитываем перед каждым полем.
  const locate = t => {
    const nodes = screen();
    const label = nodes.find(n => n.cls === "android.widget.TextView" && yo(n.text) === yo(t.n) && n.x < 450 && n.y1 >= 390 && n.y2 <= 2150);
    return label && nodes.find(n => n.cls === "android.widget.EditText" && Math.abs(n.y - label.y) < 45 && Math.abs(n.x - t.x) < 80);
  };
  for (let i = 0; i < 25 && todo.length; i++) {
    for (const t of [...todo]) {
      const field = locate(t);
      if (!field) continue;
      setField(field, t.v);
      hideKeyboard();
      const check = locate(t);
      if (!check || check.text !== String(t.v)) throw new Error(`поле «${t.n}» не заполнилось (${check?.text})`);
      todo.splice(todo.indexOf(t), 1);
    }
    if (todo.length) { swipe(1000, 1900, 1000, 1200, 700); sleep(900); }
  }
  if (todo.length) throw new Error("не нашёл поля: " + todo.map(t => t.n).join(", "));
}

function run(att, def) {
  openSimulator();
  fill(att, def);
  for (let i = 0; i < 25; i++) {
    const btn = screen().find(n => n.text === "Расчитать бой" && n.click && n.y1 >= 390 && n.y2 <= 2150);
    if (btn) { tap(btn.x, btn.y); sleep(6000); return readResult(); }
    swipe(1000, 1900, 1000, 1200, 700);
    sleep(900);
  }
  throw new Error("нет кнопки «Расчитать бой»");
}

/** Итог боя: листаем отчёт вниз до «Результат боя:». */
function readResult() {
  const num = s => Number(s.replace(/\./g, ""));
  for (let i = 0; i < 80; i++) {
    const texts = screen().map(n => n.text);
    const all = texts.join("\n");
    const a = all.match(/Атакующий потерял ([\d.]+) единиц/), d = all.match(/Обороняющийся потерял ([\d.]+) единиц/);
    if (a && d) {
      const winner = /Атакующий выиграл/.test(all) ? "att" : /Обороняющийся выиграл/.test(all) ? "def" : "draw";
      return { winner, attLoss: num(a[1]), defLoss: num(d[1]), rounds: Math.max(0, ...[...all.matchAll(/Раунд (\d+):/g)].map(m => +m[1])) };
    }
    swipe(1000, 1900, 1000, 500, 300);
    sleep(500);
  }
  throw new Error("не нашёл итог боя");
}

if (require.main === module) {
  const [att, def] = process.argv.slice(2).map(s => JSON.parse(s));
  withLock(() => run(att, def));
}
module.exports = { run };
