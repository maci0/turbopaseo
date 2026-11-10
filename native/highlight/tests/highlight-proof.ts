// Prints every token `@getpaseo/highlight` produces for the given files, synchronously and
// through the budgeted path the daemon uses. Run it under Node and natively and diff.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  highlightCode,
  highlightCodeWithBudget,
  isLanguageSupported,
  type HighlightToken,
} from "@getpaseo/highlight";

function render(lines: HighlightToken[][] | null): string {
  if (lines === null) return "null";
  const out: string[] = [];
  for (const line of lines) {
    const parts: string[] = [];
    for (const token of line) parts.push(`${token.style ?? "-"}:${JSON.stringify(token.text)}`);
    out.push(parts.join(" "));
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  for (const path of process.argv.slice(2)) {
    const name = basename(path);
    const code = readFileSync(path, "utf8");
    console.log(`== ${name} supported=${isLanguageSupported(name)}`);
    const sync = render(highlightCode(code, name));
    const budgeted = render(
      await highlightCodeWithBudget(code, name, { yieldToEventLoop: () => setImmediate() }),
    );
    console.log(sync);
    console.log(budgeted === sync ? "-- budgeted: same" : `-- budgeted differs:\n${budgeted}`);
  }
}

await main();
