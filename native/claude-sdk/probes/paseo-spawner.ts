// Paseo's spawner shape (packages/server/src/server/agent/providers/claude/query.ts): a raw
// ChildProcess returned where the SDK declares SpawnedProcess. It builds natively but fails at
// run time ("child.on is not a function"). Adding `signal: options.signal` to the spawn() call
// fails the build (SC2020). Usage: <binary> <fake-cli-log-path>
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../index.ts";

const tests = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests");
const log = process.argv[2] ?? "";

function isChildProcessWithStreams(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

async function run(scenario: string, abort: boolean): Promise<void> {
  const controller = new AbortController();
  const q = query({
    prompt: "hi",
    options: {
      pathToClaudeCodeExecutable: path.join(tests, "fake-claude"),
      abortController: controller,
      env: { PATH: process.env["PATH"], FAKE_CLI_LOG: log, FAKE_CLI_SCENARIO: scenario },
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd ?? process.cwd(),
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        if (!isChildProcessWithStreams(child)) throw new Error("no stdio");
        return child;
      },
    },
  });
  try {
    for await (const message of q) {
      console.log(`${scenario} message ${message.type}`);
      if (abort) controller.abort();
    }
    console.log(`${scenario} done`);
  } catch (error) {
    console.log(`${scenario} error ${error instanceof Error ? error.message : String(error)}`);
  }
}

await run("string-prompt", false);
await run("abort-sigterm", true);
