// Exercises pty.ts end to end. Prints one line per observation for test.sh to
// assert on; exits 2 if any case does not finish within CASE_TIMEOUT_MS.
import { spawn as spawnChild } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { type IExitEvent, type IPty, PtySpawnError, spawn } from "./pty.js";

const CASE_TIMEOUT_MS = 10000;
const BIG_OUTPUT_BYTES = 200000;
const INPUT_LINE_BYTES = 100;
const UTF8_CHARS = 30000;
const SLOT_REUSE_SPAWNS = 260; // pty.c PTY_MAX_SLOTS is 256

interface RunResult {
  output: string;
  exit: IExitEvent;
  elapsedMs: number;
}

function report(name: string, value: unknown): void {
  console.log(`${name}=${JSON.stringify(value)}`);
}

function collect(term: IPty, name: string, drive?: (term: IPty) => void): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    const timer = setTimeout(() => {
      console.log(`TIMEOUT ${name}`);
      term.kill("SIGKILL");
      process.exit(2);
    }, CASE_TIMEOUT_MS);
    term.onData((data) => {
      output += data;
    });
    term.onExit((exit) => {
      clearTimeout(timer);
      resolve({ output, exit, elapsedMs: Date.now() - started });
    });
    if (drive) drive(term);
  });
}

function run(
  name: string,
  file: string,
  args: string[],
  drive?: (term: IPty) => void,
): Promise<RunResult> {
  return collect(spawn(file, args, { name: "xterm-256color", cols: 80, rows: 24 }), name, drive);
}

async function main(): Promise<void> {
  const hello = await run("hello", "/bin/sh", ["-c", "printf hello; sleep 0.1; exit 3"]);
  report("hello.output", hello.output);
  report("hello.exit", hello.exit);

  const echo = await run("cat", "cat", [], (term) => {
    term.write("ping\n");
    // Let cat answer before EOF; ^D on an empty line ends cat's input.
    setTimeout(() => term.write("\x04"), 200);
  });
  report("cat.output", echo.output);
  report("cat.exit", echo.exit);

  // Far more input than the tty input queue holds: exercises the native
  // write queue and its POLLOUT flush.
  const bigInput = await run(
    "bigInput",
    "/bin/sh",
    ["-c", `stty -echo; head -c ${BIG_OUTPUT_BYTES} | wc -c`],
    (term) => {
      const line = `${"x".repeat(INPUT_LINE_BYTES - 1)}\n`;
      term.write(line.repeat(BIG_OUTPUT_BYTES / INPUT_LINE_BYTES));
    },
  );
  // Input echoed before `stty -echo` runs precedes wc's count.
  report("bigInput.count", /(\d+)\s*$/.exec(bigInput.output)?.[1] ?? "missing");
  report("bigInput.exit", bigInput.exit);

  const resized = await run("stty", "/bin/sh", ["-c", "read x; stty size"], (term) => {
    term.resize(132, 50);
    term.write("go\n");
  });
  report("stty.output", resized.output);
  report("stty.exit", resized.exit);

  let killedPid = 0;
  const killed = await run("kill", "sleep", ["30"], (term) => {
    killedPid = term.pid;
    setTimeout(() => term.kill("SIGTERM"), 100);
  });
  report("kill.exit", killed.exit);
  report("kill.fast", killed.elapsedMs < 2000);
  report("kill.reaped", process.platform !== "linux" || !existsSync(`/proc/${killedPid}`));

  const hup = await run("hup", "sleep", ["30"], (term) => {
    setTimeout(() => term.kill(), 100);
  });
  report("hup.exit", hup.exit);

  const big = await run("big", "/bin/sh", [
    "-c",
    `head -c ${BIG_OUTPUT_BYTES} /dev/zero | tr '\\0' a; exit 0`,
  ]);
  report("big.length", big.output.length);
  report("big.allA", /^a*$/.test(big.output));
  report("big.exit", big.exit);

  const utf8 = await run("utf8", "/bin/sh", [
    "-c",
    `yes é | head -n ${UTF8_CHARS} | tr -d '\\n'`,
  ]);
  report("utf8.length", utf8.output.length);
  report("utf8.clean", utf8.output === "é".repeat(UTF8_CHARS));

  const background = await run("background", "/bin/sh", ["-c", "sleep 5 & printf bg; exit 4"]);
  report("background.output", background.output);
  report("background.exit", background.exit);
  report("background.fast", background.elapsedMs < 2000);

  const sigs = await run("signals", "grep", ["-E", "^Sig(Blk|Ign)", "/proc/self/status"]);
  report("signals.output", sigs.output);

  // A second live pty's master must not leak into this child.
  const holder = spawn("sleep", ["30"]);
  const holderDone = collect(holder, "holder");
  const fds = await run("fds", "/bin/sh", ["-c", "ls /proc/self/fd | tr '\\n' ' '"]);
  report("fds.output", fds.output);
  holder.kill("SIGKILL");
  report("holder.exit", (await holderDone).exit);

  // child_process children reaped by the runtime must not steal the pty's
  // exit status, and the other way round.
  const mixed = run("mixed", "/bin/sh", ["-c", "sleep 0.3; exit 5"]);
  const sub = await new Promise<number | null>((resolve) => {
    spawnChild("/bin/sh", ["-c", "exit 6"]).on("exit", (code) => resolve(code));
  });
  report("mixed.childProcessCode", sub);
  report("mixed.exit", (await mixed).exit);

  const env = await run("env", "/bin/sh", ["-c", 'printf "%s|%s" "$TERM" "$PWD"']);
  report("env.output", env.output);

  const late = spawn("/bin/sh", ["-c", "exit 0"]);
  const lateResult = await collect(late, "late");
  let lateError = "none";
  try {
    late.write("after exit\n");
    late.resize(100, 30);
    late.kill("SIGTERM");
  } catch (error) {
    lateError = String(error);
  }
  report("late.exit", lateResult.exit);
  report("late.error", lateError);

  try {
    spawn("/nonexistent/binary", []);
    report("missing.error", "none");
  } catch (error) {
    report("missing.error", error instanceof PtySpawnError ? error.message : String(error));
  }

  try {
    spawn("/bin/sh", [], { cwd: "/nonexistent/dir" });
    report("badcwd.error", "none");
  } catch (error) {
    report("badcwd.error", error instanceof PtySpawnError ? error.message : String(error));
  }

  // Sequential spawns past the native slot table size prove slots and
  // descriptors are returned after exit.
  const fdsBefore = process.platform === "linux" ? readdirSync("/proc/self/fd").length : 0;
  let reuseOk = 0;
  for (let i = 0; i < SLOT_REUSE_SPAWNS; i++) {
    const result = await collect(spawn("/bin/sh", ["-c", "exit 0"]), "reuse");
    if (result.exit.exitCode === 0) reuseOk++;
  }
  const fdsAfter = process.platform === "linux" ? readdirSync("/proc/self/fd").length : 0;
  report("reuse.ok", reuseOk);
  report("reuse.fdDelta", fdsAfter - fdsBefore);

  console.log("DONE");
}

void main();
