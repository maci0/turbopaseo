// Runs the scenario suite against the package by name and writes <out>/queries.txt and
// <out>/forks.txt: the real SDK under Node, ../index.ts in a scriptc build (tsconfig `paths`).
// Usage: run-sdk.ts <out-dir> [scenario]
import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { runForkScenarios, runQueryScenarios, writeLines } from "./scenarios.ts";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: run-sdk.ts <out-dir> [scenario]");
const only = process.argv[3];
writeLines(path.join(outDir, "queries.txt"), await runQueryScenarios(query, outDir, only));
if (!only) writeLines(path.join(outDir, "forks.txt"), (await runForkScenarios(forkSession, outDir)).slice());
process.exit(0);
