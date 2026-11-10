// Runs a fixed program in a real Paseo terminal session (pty, headless xterm, replay serializer,
// capture) and prints the captured lines and the replay as JSON. Run it under Node and as a
// native binary; the outputs must be identical. test.sh copies this file into
// packages/server/zzprobe-xterm/ in the work tree, so the imports are relative to there.
//
// usage: session-compare <working directory>
import { createTerminal } from "../src/terminal/terminal.js";

/** The output must have been parsed by then; a wedged pty fails the run. */
const TIMEOUT_MS = 10000;
/** Interval for checking whether the last output line has been parsed. */
const POLL_MS = 20;
const LAST_LINE = "end";
const SCRIPT = [
  "printf 'plain \\033[1;31mred bold\\033[0m \\033[38;5;33mblue\\033[0m\\n'",
  "printf '中文 e\\314\\201 A\\360\\237\\230\\200B\\n'",
  "printf '\\033[2;3Hmoved\\033[K\\n'",
  "i=0; while [ $i -lt 40 ]; do echo history $i; i=$((i+1)); done",
  "printf '\\033[?1049h\\033[Halt screen\\033[?1049l'",
  "printf '\\033[?2004h\\033[?25l\\033[4 qend'",
  // Keep the session alive: an exited session disposes its headless terminal.
  "exec cat",
].join("; ");

async function main(): Promise<void> {
  const cwd = process.argv[process.argv.length - 1];
  if (cwd === undefined || !cwd.startsWith("/")) throw new Error("usage: session-compare <dir>");
  const session = await createTerminal({
    cwd,
    workspaceId: "compare",
    command: "/bin/sh",
    args: ["-c", SCRIPT],
    rows: 12,
    cols: 60,
    baseEnv: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" },
    paseoCliPath: null,
  });
  // The pty may report exit before xterm has parsed the last chunk, so wait for its text.
  const deadline = Date.now() + TIMEOUT_MS;
  while (!session.captureLines().lines.some((line) => line.endsWith(LAST_LINE))) {
    if (Date.now() > deadline) throw new Error("output did not arrive");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const replay = session.serializeReplay();
  process.stdout.write(
    `${JSON.stringify({
      size: session.getSize(),
      hasOutput: session.hasOutput(),
      capture: session.captureLines(),
      retainedHistoryLines: replay.metadata.retainedHistoryLines,
      replay: Buffer.from(replay.data).toString("utf8"),
    })}\n`,
  );
  await session.killAndWait();
}

await main();
