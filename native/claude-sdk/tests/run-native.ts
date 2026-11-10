// Runs the scenario suite against this module and writes
// <out>/queries.txt and <out>/forks.txt. Usage: run-native.ts <out-dir> [scenario]
import { forkSession, query } from "../index.ts";
import path from "node:path";
import { runForkScenarios, runQueryScenarios, writeLines } from "./scenarios.ts";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: run-native.ts <out-dir> [scenario]");
const only = process.argv[3];
writeLines(path.join(outDir, "queries.txt"), await runQueryScenarios(query, outDir, only));
if (!only) writeLines(path.join(outDir, "forks.txt"), (await runForkScenarios(forkSession, outDir)).slice());
process.exit(0);
