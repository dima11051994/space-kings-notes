// Разовый сбор справки по кораблям и обороне: стоимость со страницы «Развитие → Верфь/Оборона»,
// характеристики — с карточки юнита (нажатие на название). Ничего не строит.
// Запуск: node bot/collect-units.js [Верфь|Оборона ...] → game-data/units.json
const fs = require("fs");
const path = require("path");
const { screen, tap, swipe, menu, sleep, scrollTop, adb, withLock, visibleLines, joinOverlap } = require("./sk.js");

const OUT = path.join(__dirname, "..", "game-data", "units.json");
const TABS = { "Верфь": 658, "Оборона": 852 };
const RES = { metall: "Металл", kristall: "Кристалл", deuterium: "Дейтерий" };
const FULL = n => n.y1 >= 390 && n.y2 <= 2190;
const num = s => Number(String(s).replace(/\./g, ""));

function openTab(tab) {
  // Нажатие в меню теряется, пока страница прокручивается: проверяем, что вкладка открылась.
  for (let i = 0; i < 3; i++) {
    sleep(800);
    menu("Развитие");
    scrollTop();
    tap(TABS[tab], 447);
    sleep(2500);
    scrollTop();
    if (blocks(screen()).length) return;
  }
  throw new Error(`не открылась вкладка ${tab}`);
}

/** Блоки юнитов на экране: «Название (Доступно: N) …» с названием-ссылкой. */
function blocks(nodes) {
  return nodes.filter(n => /^.+? \((Доступно|Количество)[^)]*\) /.test(n.text) && n.x1 < 200).map(b => {
    const inside = nodes.filter(n => n !== b && n.x1 >= b.x1 && n.x2 <= b.x2 && n.y1 >= b.y1 && n.y2 <= b.y2 && n.text)
      .sort((a, c) => a.y - c.y || a.x - c.x);
    const link = inside.find(n => n.click && b.text.startsWith(n.text + " ("));
    return { b, inside, link };
  }).filter(x => x.link);
}

/** Стоимость по иконкам ресурсов: иконка, затем число. */
function cost(inside) {
  const out = {};
  const from = inside.findIndex(n => n.text === "Стоимость:");
  if (from < 0) return out;
  for (let i = from + 1; i < inside.length && !/^Перераспределить|^Время строительства/.test(inside[i].text); i++) {
    const res = RES[inside[i].text];
    const value = inside.slice(i + 1).find(n => /^[\d.]+$/.test(n.text));
    if (res && value) out[res] = num(value.text);
  }
  return out;
}

/** Пройти список вкладки: стоимость, время, описание каждого юнита. */
function readList(tab) {
  openTab(tab);
  const units = new Map();
  let idle = 0;
  for (let i = 0; i < 60 && idle < 2; i++) {
    const before = units.size;
    for (const { b, inside, link } of blocks(screen())) {
      if (!FULL(b) || units.has(link.text)) continue;
      const price = cost(inside);
      if (!Object.keys(price).length || Object.values(price).some(v => !v)) continue;  // цифры ещё не прорисовались
      const m = b.text.match(/\((?:Доступно|Количество):? ?([\d.]+)\)/);
      units.set(link.text, {
        name: link.text,
        available: m ? num(m[1]) : null,
        cost: price,
        engine: b.text.match(/Тип двигателя: (\S+)/)?.[1] ?? null,
        buildTime: b.text.match(/Время строительства: (.+?)(?= -|$)/)?.[1]?.trim() ?? null,
        listText: b.text,
      });
    }
    idle = units.size === before ? idle + 1 : 0;
    swipe(540, 1900, 540, 1300, 700);
    sleep(900);
  }
  return [...units.values()];
}

/** Карточка юнита: прокручиваем и собираем видимые строки (текст длинной карточки за краем экрана обрезан). */
function readCard(tab, name) {
  openTab(tab);
  for (let i = 0; i < 40; i++) {
    const link = screen().find(n => n.click && n.text === name && FULL(n) && n.x < 600);
    if (link) {
      tap(link.x, link.y);
      sleep(2500);
      const first = screen();
      const yo = s => s.replace(/ё/g, "е");
      if (!first.some(n => /^Информация/.test(n.text) && yo(n.text).includes(yo(name)))) throw new Error(`не открылась карточка «${name}»`);
      // Описание — длинный абзац; построчный сбор такие строки пропускает.
      const description = first.filter(n => n.text.length >= 60 && !/^Информация|[Сс]корострел|Структура/.test(n.text))
        .sort((a, b) => b.text.length - a.text.length)[0]?.text ?? "";
      let lines = [], prev = "";
      for (let page = 0; page < 10; page++) {
        const next = visibleLines(screen());
        const key = next.join("\n");
        if (key === prev) break;
        prev = key;
        lines = joinOverlap(lines, next);
        swipe(540, 1900, 540, 1000, 700);
        sleep(900);
      }
      adb("shell", "input", "keyevent", "KEYCODE_BACK");
      sleep(2000);
      const card = parseCard(lines);
      return { cardLines: lines, ...card, description: description || card.description };
    }
    swipe(540, 1900, 540, 1100, 700);
    sleep(900);
  }
  throw new Error(`не нашёл «${name}» на вкладке ${tab}`);
}

const STATS = ["Структура", "Сила щитов", "Тип орудия", "Нападение", "Грузоподъемность", "Базовая скорость", "Потребление дейтерия"];

/** «4.000» — тысячи, «2.9» — дробь. */
const value = s => /^\d{1,3}(\.\d{3})+$/.test(s) ? num(s) : Number(s);

function parseCard(lines) {
  // Строка «X скорострел против данного юнита» бывает отдельно от числа: склеиваем.
  const ls = [];
  for (const l of lines) {
    const last = ls[ls.length - 1];
    if (/^[\d.]+$/.test(l) && last && /против( данного юнита)?/.test(last) && !/\s[\d.]+$/.test(last)) ls[ls.length - 1] += "   " + l;
    else ls.push(l);
  }
  const rapidfire = { against: {}, from: {} }, stats = {};
  let description = "";
  for (const l of ls) {
    let m;
    if ((m = l.match(/^Скорострел против (.+?)\s+([\d.]+)$/))) rapidfire.against[m[1]] = value(m[2]);
    else if ((m = l.match(/^(.+?) скорострел против данного юнита\s+([\d.]+)$/))) rapidfire.from[m[1]] = value(m[2]);
    else if ((m = l.match(new RegExp(`^(${STATS.join("|")})\\s{2,}(.+)$`)))) {
      const v = m[2].trim(), p = v.match(/^([\d.]+)(?: \(([\d.]+)\))?/);
      stats[m[1]] = p ? { base: value(p[1]), ...(p[2] ? { withTech: value(p[2]) } : {}), raw: v } : v;
    } else if (l.length > description.length && !/^Информация/.test(l)) description = l;
  }
  return { description, rapidfire, stats };
}

withLock(() => {
  const tabs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TABS);
  const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  for (const tab of tabs) {
    const key = tab === "Верфь" ? "ships" : "defense";
    const list = readList(tab);
    console.error(`${tab}: ${list.length} — ${list.map(u => u.name).join(", ")}`);
    const save = () => {
      out[key] = list;
      out.collectedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    };
    save();
    for (const u of list) {
      try {
        Object.assign(u, readCard(tab, u.name));
        delete u.error;
        console.error(`  ${u.name}: ${JSON.stringify(u.cost)} ${JSON.stringify(u.stats)}`);
      } catch (e) {
        u.error = e.message;
        console.error(`  ${u.name}: ОШИБКА ${e.message}`);
      }
      save();
    }
  }
});
