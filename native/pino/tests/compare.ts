// Compares two log captures (pino JSON lines or pino-pretty output) line by line. Ignored:
// the values of time, pid and hostname, pino-pretty's leading [HH:MM:ss.l] time, and stack
// frames ("    at ..."), which Node and the native binary print differently.
// Usage: compare.ts <reference> <candidate>
import { readFileSync } from "node:fs";

const STACK_FIELD = /"stack":"((?:[^"\\]|\\.)*)"/g;
const STACK_FRAME = /^ {4}at /;
const PRETTY_STACK_FRAME = /^\s+at /;
const PRETTY_TIME = /^\[\d\d:\d\d:\d\d\.\d{3}\]/;

function normalize(line: string): string {
  return line
    .replace(PRETTY_TIME, "[T]")
    .replace(/"time":\d+/g, '"time":0')
    .replace(/"pid":\d+/g, '"pid":0')
    .replace(/"hostname":"[^"]*"/g, '"hostname":"h"')
    .replace(STACK_FIELD, (_match: string, body: string) => {
      const kept = body.split("\\n").filter((part) => !STACK_FRAME.test(part));
      return `"stack":"${kept.join("\\n")}"`;
    });
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "" && !PRETTY_STACK_FRAME.test(line))
    .map(normalize);
}

const [referencePath, candidatePath] = process.argv.slice(2);
const reference = readLines(referencePath);
const candidate = readLines(candidatePath);
let differences = 0;
const count = Math.max(reference.length, candidate.length);
for (let index = 0; index < count; index += 1) {
  if (reference[index] !== candidate[index]) {
    differences += 1;
    process.stdout.write(
      `line ${index + 1}\n  ref: ${reference[index]}\n  got: ${candidate[index]}\n`,
    );
  }
}
process.stdout.write(
  `${candidatePath}: ${candidate.length} lines, ${reference.length} expected, ${differences} differing\n`,
);
process.exitCode = differences === 0 ? 0 : 1;
