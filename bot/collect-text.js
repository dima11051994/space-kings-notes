// Разовый сбор текста страницы «Инфо → FAQ»: node bot/collect-text.js "<название раздела>" <файл>
const fs = require("fs");
const path = require("path");
const { screen, tap, swipe, menu, sleep, withLock, joinOverlap, screencap } = require("./sk.js");

const [title, file] = process.argv.slice(2);

/** Текстовые узлы без вложенного текста (абзацы, а не их контейнеры), целиком на экране, сверху вниз. */
function visibleLeaves(nodes) {
  const text = nodes.filter(n => n.text && n.y1 >= 390 && n.y2 <= 2190);
  const leaves = text.filter(n => !text.some(c => c !== n && c.x1 >= n.x1 && c.x2 <= n.x2 && c.y1 >= n.y1 && c.y2 <= n.y2 &&
    (c.x1 !== n.x1 || c.x2 !== n.x2 || c.y1 !== n.y1 || c.y2 !== n.y2)));
  const seen = new Set();
  const lines = [];
  for (const n of leaves.sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (seen.has(n.text + "@" + n.y)) continue;
    seen.add(n.text + "@" + n.y);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - n.y) < 15) last.parts.push(n.text);
    else lines.push({ y: n.y, parts: [n.text] });
  }
  return lines.map(l => l.parts.join(" "));
}

withLock(() => {
  // Заново открытое «Инфо» — все разделы свёрнуты; раздел раскрывается на месте, повторное нажатие его сворачивает.
  // Дерево элементов может показывать прежнее состояние, поэтому нажимаем ровно один раз и ждём текст.
  menu("Инфо");
  sleep(3000);
  const link = screen().find(n => n.click && n.text === title);
  if (!link) throw new Error(`нет раздела «${title}»`);
  tap(link.x, link.y);
  const visible = () => screen().some(n => n.text.length > 100 && n.y1 >= 390 && n.y2 <= 2190);
  let ok = false;
  for (let t = 0; t < 6 && !ok; t++) { sleep(2000); ok = visible(); }
  if (!ok) throw new Error(`раздел «${title}» не раскрылся`);
  // Прокрутка жестом по правому краю: жест по заголовку раздела засчитывается как нажатие и сворачивает его.
  // К началу не прокручиваем: жест вниз у верха страницы перезагружает её (pull-to-refresh) и сворачивает раздел.
  // Таблицы в тексте — картинки: сохраняем скриншот экрана с каждой из них.
  const shots = path.join(path.dirname(file), path.basename(file, path.extname(file)) + "-images");
  const saved = new Set();
  let lines = [], prev = "";
  for (let page = 0; page < 80; page++) {
    const nodes = screen();
    for (const img of nodes.filter(n => n.cls === "android.widget.Image" && n.y1 >= 390 && n.y2 <= 2190 && n.y2 - n.y1 > 150)) {
      const name = img.text || `image-${img.y1}`;
      if (saved.has(name)) continue;
      saved.add(name);
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, `${String(saved.size).padStart(2, "0")}-${name.replace(/[^w.-]+/g, "_")}.png`),
        screencap());
    }
    const next = visibleLeaves(nodes);
    const key = next.join("\n");
    if (key === prev) break;
    prev = key;
    lines = joinOverlap(lines, next);
    swipe(1000, 1900, 1000, 1100, 700);
    sleep(900);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log(`${lines.length} строк → ${file}`);
});
