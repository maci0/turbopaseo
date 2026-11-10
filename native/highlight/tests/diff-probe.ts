// Runs the server's diff highlighter over a unified diff and prints the parsed files as JSON.
// argv: <diff file> <worktree the diff applies to>.
import { readFileSync } from "node:fs";
import { parseAndHighlightDiff } from "../src/server/utils/diff-highlighter.js";

const [diffPath, cwd] = process.argv.slice(2);
const files = await parseAndHighlightDiff(readFileSync(diffPath, "utf8"), cwd);
console.log(JSON.stringify(files, null, 1));
