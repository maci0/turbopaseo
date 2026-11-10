// Records terminal output from real programs through node-pty, plus hand-written escape
// sequences, into the corpus that replay-compare.ts replays. Needs Node (node-pty is a native
// addon). Run from anywhere; arguments name the work tree's packages/server directory (where
// node-pty is installed), a directory for the programs' HOME and files, and the output file.
//
// usage: node record-corpus.mjs <packages/server dir> <scratch dir> <corpus.json>
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [serverDir, scratchDir, outFile] = process.argv.slice(2);
if (!serverDir || !scratchDir || !outFile) {
  throw new Error("usage: node record-corpus.mjs <packages/server dir> <scratch dir> <corpus.json>");
}
const pty = createRequire(join(resolve(serverDir), "package.json"))("node-pty");

/** A program that has not exited by then is killed and the case fails. */
const PROGRAM_TIMEOUT_MS = 8000;
/** Time for a full-screen program to draw before the next scripted action. */
const SETTLE_MS = 400;
const COLS = 80;
const ROWS = 24;

const home = join(resolve(scratchDir), "home");
mkdirSync(home, { recursive: true });
const sampleFile = join(home, "sample.txt");
writeFileSync(
  sampleFile,
  Array.from({ length: 60 }, (_, i) => `line ${i + 1}: ${"lorem ipsum ".repeat((i % 9) + 1)}`).join("\n"),
);

const env = {
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
};

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Runs `file args` in a pty. `script` gets a controller with `send` and `resize` (which also
 * records the resize step) and may await between actions; returning "kill" ends the case
 * there (the program is killed and its exit output dropped).
 */
async function record(name, file, args, script) {
  const steps = [];
  const child = pty.spawn(file, args, { name: env.TERM, cols: COLS, rows: ROWS, cwd: home, env });
  let exited = false;
  const exit = new Promise((done) => {
    child.onExit(({ exitCode }) => {
      exited = true;
      done(exitCode);
    });
  });
  child.onData((data) => steps.push({ write: data }));
  const timer = setTimeout(() => {
    if (!exited) child.kill();
  }, PROGRAM_TIMEOUT_MS);
  // Steps recorded before a scripted kill; the program's exit output is not part of the case.
  let keptSteps;
  if (script) {
    const action = await script({
      send: (data) => child.write(data),
      resize: (cols, rows) => {
        steps.push({ resize: [cols, rows] });
        child.resize(cols, rows);
      },
    });
    if (action === "kill") {
      keptSteps = steps.length;
      child.kill();
    }
  }
  const code = await exit;
  clearTimeout(timer);
  if (keptSteps === undefined && code !== 0) throw new Error(`${name}: exit ${code}`);
  return { name, cols: COLS, rows: ROWS, steps: steps.slice(0, keptSteps) };
}

function synthetic(name, chunks, cols = COLS, rows = ROWS) {
  return { name, cols, rows, steps: chunks.map((chunk) => (typeof chunk === "string" ? { write: chunk } : chunk)) };
}

const ESC = "\x1b";
const CSI = `${ESC}[`;
const longLine = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");

const corpus = [
  synthetic("plain-wrap", [`hello world\r\n${longLine}\r\n${"x".repeat(80)}y\r\nend`]),
  synthetic("pending-wrap-cursor", ["a".repeat(80)]),
  synthetic("sgr", [
    `${CSI}1mbold${CSI}0m ${CSI}3mitalic${CSI}23m ${CSI}4munder${CSI}24m ${CSI}4:3mcurly${CSI}4:0m`,
    ` ${CSI}7minverse${CSI}27m ${CSI}9mstrike${CSI}29m ${CSI}2mdim${CSI}22m ${CSI}8mhidden${CSI}28m\r\n`,
    ...Array.from({ length: 16 }, (_, i) => `${CSI}${i < 8 ? 30 + i : 82 + i}mf${i}${CSI}${i < 8 ? 40 + i : 92 + i}mb${CSI}0m`),
    "\r\n",
    ...Array.from({ length: 24 }, (_, i) => `${CSI}38;5;${i * 10}m${CSI}48;5;${255 - i * 10}m#${CSI}0m`),
    "\r\n",
    `${CSI}38;2;255;100;0m${CSI}48;2;0;50;200mtruecolor${CSI}58;2;0;255;0m${CSI}4munderline-color${CSI}0m\r\n`,
    `${CSI}53moverline${CSI}55m${CSI}0m`,
  ]),
  synthetic("cursor-movement", [
    `${CSI}2J${CSI}H`,
    `${CSI}5;10Hat 5,10${CSI}2Aup2${CSI}3Bdown3${CSI}4Cright${CSI}6Dleft`,
    `${ESC}7${CSI}20;1Hsaved${ESC}8restored${CSI}s${CSI}1;70Htop-right${CSI}u!`,
    `${CSI}10Gcol10${CSI}12dline12\ttab\ttab2${CSI}3Ztabback`,
  ]),
  synthetic("erase", [
    Array.from({ length: 20 }, (_, i) => `row ${i} ${"=".repeat(60)}`).join("\r\n"),
    `${CSI}5;20H${CSI}K${CSI}7;20H${CSI}1K${CSI}9;1H${CSI}2K${CSI}12;30H${CSI}J`,
    `${CSI}3;5H${CSI}1J${CSI}2;10H${CSI}5X${CSI}4;10H${CSI}3P${CSI}6;10H${CSI}4@ins`,
  ]),
  synthetic("scroll-region", [
    Array.from({ length: 24 }, (_, i) => `fixed ${i}`).join("\r\n"),
    `${CSI}5;15r${CSI}15;1H`,
    ...Array.from({ length: 12 }, (_, i) => `\r\nscrolled ${i}`),
    `${CSI}5;1H${ESC}M${ESC}Mreverse`,
    `${CSI}8;1H${CSI}2L${CSI}10;1H${CSI}3M${CSI}2S${CSI}1T`,
    `${CSI}r${CSI}24;1H\r\nafter reset`,
  ]),
  synthetic("scrollback", [Array.from({ length: 200 }, (_, i) => `history line ${i}`).join("\r\n")]),
  synthetic("alt-screen", [
    "main screen text\r\nsecond line",
    `${CSI}?1049h${CSI}H${CSI}2Jalternate content${CSI}10;10Hmiddle`,
  ]),
  synthetic("alt-screen-leave", [
    "main screen text\r\nsecond line",
    `${CSI}?1049h${CSI}H${CSI}2Jalternate content`,
    `${CSI}?1049lback on main`,
  ]),
  synthetic("modes-and-title", [
    `${ESC}]0;my title${ESC}\\${ESC}]2;other title\x07`,
    `${CSI}?2004h${CSI}?1h${ESC}=${CSI}?1000h${CSI}?1006h${CSI}?25l${CSI}5 q${CSI}4h`,
    "insert mode text",
  ]),
  synthetic("modes-reset", [`${CSI}?2004h${CSI}?1000h${CSI}?25l${CSI}3 q`, `${CSI}?2004l${CSI}?1000l${CSI}?25h${CSI}0 q`, "x"]),
  synthetic("wide-and-combining", [
    "中文字符 ascii 日本語テキスト\r\n",
    "é ä ñ combining\r\n",
    "A😀👍❤️👋🏽🇰🇷👨‍👩‍👧B\r\n",
    "क्ष स्ते हिन्दी\r\n",
    `${"中".repeat(39)}x中wrap`,
  ]),
  synthetic("resize-shrink-reflow", [
    Array.from({ length: 10 }, (_, i) => `${i}: ${longLine}`).join("\r\n"),
    { resize: [40, 12] },
    "\r\nafter shrink",
  ]),
  synthetic("resize-grow-reflow", [
    `${longLine}\r\n${longLine}`,
    { resize: [40, 10] },
    { resize: [120, 30] },
    "\r\nafter grow",
  ]),
  synthetic("osc-hyperlink-and-charset", [
    `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}(0lqqk${ESC}(B ${CSI}?7lnowrap${"y".repeat(90)}${CSI}?7h`,
  ]),
  await record("ls-color", "/bin/ls", ["--color=always", "-la", "/usr/bin"]),
  await record("printf-mix", "/bin/sh", [
    "-c",
    "printf '\\033[31mred\\033[0m \\033[1;32mgreen\\033[0m\\n'; printf 'tab\\there\\n'; printf '\\033[2;5Hmoved\\n'",
  ]),
  await record("top", "/usr/bin/top", ["-n", "1"]),
  await record("vim", "/usr/bin/vim", ["-u", "NONE", "-N", sampleFile], async ({ send, resize }) => {
    await sleep(SETTLE_MS);
    send("10Gdd");
    await sleep(SETTLE_MS);
    resize(100, 30);
    await sleep(SETTLE_MS);
    send(":q!\r");
  }),
  await record("vim-alt-only", "/usr/bin/vim", ["-u", "NONE", "-N", sampleFile], async ({ send }) => {
    await sleep(SETTLE_MS);
    send(":10\r");
    await sleep(SETTLE_MS);
    return "kill";
  }),
];

writeFileSync(outFile, `${JSON.stringify(corpus, null, 1)}\n`);
console.log(`${corpus.length} cases, ${corpus.reduce((n, c) => n + c.steps.length, 0)} steps -> ${outFile}`);
