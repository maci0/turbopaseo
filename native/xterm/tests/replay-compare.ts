// Feeds recorded terminal output through Paseo's headless terminal, replay serializer and text
// capture, and prints one JSON line per case. Run it under Node (real @xterm packages) and as a
// native binary (vendored sources); the two outputs must be identical. test.sh copies this file
// into packages/server/zzprobe-xterm/ in the work tree, so the imports are relative to there.
//
// usage: replay-compare <corpus.json>
import { readFileSync } from "node:fs";
import { createHeadlessTerminal } from "../src/terminal/headless-terminal.js";
import { createTerminalSerializer } from "../src/terminal/terminal-serializer.js";
import { captureTerminalLines } from "../src/terminal/terminal-capture.js";

interface CorpusStep {
  /** Output text as node-pty delivers it (UTF-8 decoded). */
  write?: string;
  /** New size as [cols, rows]. */
  resize?: number[];
}

interface CorpusCase {
  name: string;
  cols: number;
  rows: number;
  steps: CorpusStep[];
}

type HeadlessTerminal = ReturnType<typeof createHeadlessTerminal>;

/** Rows of history a replay may carry; Paseo's worker retains 10000 lines. */
const SCROLLBACK_LINES = 10000;
/** A recent-history replay, as sent after pressure recovery. */
const RECENT_REPLAY_LINES = 5;

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function describeState(terminal: HeadlessTerminal): string {
  const buffer = terminal.buffer.active;
  return `${buffer.type} ${terminal.cols}x${terminal.rows} cursor=${buffer.cursorX},${buffer.cursorY} base=${buffer.baseY} length=${buffer.length}`;
}

async function runCase(entry: CorpusCase): Promise<string> {
  const terminal = createHeadlessTerminal({
    cols: entry.cols,
    rows: entry.rows,
    scrollback: SCROLLBACK_LINES,
  });
  const serialize = createTerminalSerializer(terminal);
  for (const step of entry.steps) {
    if (step.write !== undefined) await write(terminal, step.write);
    if (step.resize !== undefined) terminal.resize(step.resize[0], step.resize[1]);
  }
  const replay = Buffer.from(serialize()).toString("utf8");
  const recentReplay = Buffer.from(serialize({ scrollbackLines: RECENT_REPLAY_LINES })).toString(
    "utf8",
  );
  const capture = captureTerminalLines(terminal.buffer.active);
  const captureRaw = captureTerminalLines(terminal.buffer.active, { stripAnsi: false });
  const state = describeState(terminal);

  // A reconnecting client parses the replay into a fresh terminal of the same size.
  const client = createHeadlessTerminal({
    cols: terminal.cols,
    rows: terminal.rows,
    scrollback: SCROLLBACK_LINES,
  });
  await write(client, replay);
  const clientCapture = captureTerminalLines(client.buffer.active);
  const clientState = describeState(client);
  const clientReplay = Buffer.from(createTerminalSerializer(client)()).toString("utf8");
  terminal.dispose();
  client.dispose();

  return JSON.stringify({
    name: entry.name,
    state,
    replay,
    recentReplay,
    capture: capture.lines,
    totalLines: capture.totalLines,
    captureRaw: captureRaw.lines,
    clientState,
    clientCapture: clientCapture.lines,
    clientReplayMatches: clientReplay === replay,
  });
}

async function main(): Promise<void> {
  const corpusPath = process.argv[process.argv.length - 1];
  if (corpusPath === undefined || !corpusPath.endsWith(".json")) {
    throw new Error("usage: replay-compare <corpus.json>");
  }
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusCase[];
  for (const entry of corpus) {
    process.stdout.write(`${await runCase(entry)}\n`);
  }
}

await main();
