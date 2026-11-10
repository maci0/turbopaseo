// Logs 5000 lines to stdout, then ticks on stderr every 100 ms for 1.5 s: with a reader that
// does not drain stdout, ticks keep coming only if log writes do not block the event loop.
// Run: `./pipe-blocking | (sleep 2; wc -l)` natively, and the same under Node with npm pino.
import pino from "pino";

const LINES = 5000;
const TICK_MS = 100;
const RUN_MS = 1500;
const started = Date.now();
const logger = pino({ level: "info" });
const padding = "x".repeat(150);
for (let index = 0; index < LINES; index += 1) {
  logger.info({ index, padding }, "pipe line");
}
process.stderr.write(`logged ${LINES} at ${Date.now() - started}ms\n`);
const timer = setInterval(() => {
  process.stderr.write(`tick ${Date.now() - started}ms\n`);
}, TICK_MS);
setTimeout(() => {
  clearInterval(timer);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const before = Date.now();
  Atomics.wait(cell, 0, 0, 50);
  process.stderr.write(
    `atomics waited ${Date.now() - before}ms; done at ${Date.now() - started}ms\n`,
  );
}, RUN_MS);
