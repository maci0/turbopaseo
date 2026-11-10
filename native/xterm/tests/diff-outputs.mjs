// Compares two replay-compare outputs case by case and field by field. Exit 1 on any difference.
// usage: node diff-outputs.mjs <node.jsonl> <native.jsonl>
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const [nodeFile, nativeFile] = process.argv.slice(2);
const expected = read(nodeFile);
const actual = read(nativeFile);
let failures = 0;
if (expected.length !== actual.length) {
  console.log(`case count: node ${expected.length}, native ${actual.length}`);
  failures++;
}
for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
  const differing = Object.keys(expected[i]).filter(
    (key) => JSON.stringify(expected[i][key]) !== JSON.stringify(actual[i][key]),
  );
  if (differing.length === 0) {
    console.log(`same  ${expected[i].name}`);
    continue;
  }
  failures++;
  console.log(`DIFF  ${expected[i].name}: ${differing.join(", ")}`);
  for (const key of differing) {
    const a = JSON.stringify(expected[i][key]);
    const b = JSON.stringify(actual[i][key]);
    let at = 0;
    while (at < a.length && a[at] === b[at]) at++;
    console.log(`  ${key} @${at}\n    node:   ${a.slice(Math.max(0, at - 60), at + 80)}\n    native: ${b.slice(Math.max(0, at - 60), at + 80)}`);
  }
}
const sameCount = Math.min(expected.length, actual.length) - failures + (expected.length !== actual.length ? 1 : 0);
console.log(`${sameCount} of ${expected.length} cases identical`);
process.exit(failures === 0 ? 0 : 1);
