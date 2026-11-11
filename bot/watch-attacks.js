// Каждые 15 минут смотрит «Обзор». Завершается, как только виден чужой флот или проверка трижды подряд не удалась.
const { execFileSync } = require("child_process");
const path = require("path");

const PERIOD = 15 * 60e3;
let failures = 0;

for (;;) {
  try {
    const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "sk.js"), "attacks"], { encoding: "utf8" }));
    failures = 0;
    if (out.foreign.length) {
      console.log(`ЧУЖОЙ ФЛОТ (${out.checked}):\n` + out.foreign.join("\n"));
      process.exit(0);
    }
    console.error(`${out.checked}: чисто`);
  } catch (e) {
    console.error(`${new Date().toLocaleTimeString("ru")}: ошибка проверки: ${e.stderr || e.message}`);
    if (++failures >= 3) { console.log("ПРОВЕРКА АТАК НЕ РАБОТАЕТ: 3 ошибки подряд"); process.exit(1); }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PERIOD);
}
