// Rebuilds native/xterm/src from a pinned xterm.js checkout, or checks that the committed tree
// matches what the pinned sources, the mechanical rewrites below and local.patch produce.
//
// usage: bun native/xterm/scripts/vendor.ts <xterm.js clone> [--check]
//
// The clone must contain both pinned commits (a full or blob-filtered clone of
// https://github.com/xtermjs/xterm.js). git and patch are run as subprocesses: there is no
// in-process API for reading objects out of a git repository or applying a unified diff.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** @xterm/headless 6.1.0-beta.334 and @xterm/addon-unicode-graphemes 0.5.0-beta.330. */
const HEADLESS_COMMIT = "08829c7eb6279dda2a9e86df901353a1a89858ca";
/** @xterm/addon-serialize 0.14.0. */
const SERIALIZE_COMMIT = "f447274f430fd22513f6adbf9862d19524471c04";

/** Upstream path, pinned commit. Every runtime and type-only module the native program reaches. */
const FILES: ReadonlyArray<readonly [string, string]> = [
  ...[
    "src/browser/Types.ts",
    "src/common/Async.ts",
    "src/common/CircularList.ts",
    "src/common/Color.ts",
    "src/common/CoreTerminal.ts",
    "src/common/Event.ts",
    "src/common/InputHandler.ts",
    "src/common/Lifecycle.ts",
    "src/common/Platform.ts",
    "src/common/StringBuilder.ts",
    "src/common/TaskQueue.ts",
    "src/common/Types.ts",
    "src/common/Version.ts",
    "src/common/WindowsMode.ts",
    "src/common/buffer/AttributeData.ts",
    "src/common/buffer/Buffer.ts",
    "src/common/buffer/BufferLine.ts",
    "src/common/buffer/BufferReflow.ts",
    "src/common/buffer/BufferSet.ts",
    "src/common/buffer/CellData.ts",
    "src/common/buffer/Constants.ts",
    "src/common/buffer/Marker.ts",
    "src/common/buffer/Types.ts",
    "src/common/data/Charsets.ts",
    "src/common/data/EscapeSequences.ts",
    "src/common/input/TextDecoder.ts",
    "src/common/input/UnicodeV6.ts",
    "src/common/input/WriteBuffer.ts",
    "src/common/input/XParseColor.ts",
    "src/common/parser/ApcParser.ts",
    "src/common/parser/Constants.ts",
    "src/common/parser/DcsParser.ts",
    "src/common/parser/EscapeSequenceParser.ts",
    "src/common/parser/OscParser.ts",
    "src/common/parser/Params.ts",
    "src/common/parser/Types.ts",
    "src/common/public/AddonManager.ts",
    "src/common/public/BufferApiView.ts",
    "src/common/public/BufferNamespaceApi.ts",
    "src/common/public/ParserApi.ts",
    "src/common/public/UnicodeApi.ts",
    "src/common/services/BufferService.ts",
    "src/common/services/CharsetService.ts",
    "src/common/services/CoreService.ts",
    "src/common/services/LogService.ts",
    "src/common/services/MouseStateService.ts",
    "src/common/services/OptionsService.ts",
    "src/common/services/OscLinkService.ts",
    "src/common/services/ServiceRegistry.ts",
    "src/common/services/Services.ts",
    "src/common/services/UnicodeService.ts",
    "src/headless/Terminal.ts",
    "src/headless/public/Terminal.ts",
    "typings/xterm.d.ts",
    "typings/xterm-headless.d.ts",
    "addons/addon-unicode-graphemes/src/UnicodeGraphemeProvider.ts",
    "addons/addon-unicode-graphemes/src/UnicodeGraphemesAddon.ts",
    "addons/addon-unicode-graphemes/src/third-party/UnicodeProperties.ts",
    "addons/addon-unicode-graphemes/src/third-party/tiny-inflate.ts",
    "addons/addon-unicode-graphemes/src/third-party/unicode-trie.ts",
    "addons/addon-unicode-graphemes/typings/addon-unicode-graphemes.d.ts",
  ].map((path) => [path, HEADLESS_COMMIT] as const),
  ...[
    "addons/addon-serialize/src/SerializeAddon.ts",
    "addons/addon-serialize/typings/addon-serialize.d.ts",
  ].map((path) => [path, SERIALIZE_COMMIT] as const),
];

/** Ambient `declare module` typings, rewritten as plain modules so imports can name the file. */
const AMBIENT_TYPINGS: Readonly<Record<string, string>> = {
  "@xterm/xterm": "typings/xterm.d.ts",
  "@xterm/headless": "typings/xterm-headless.d.ts",
  "@xterm/addon-serialize": "addons/addon-serialize/typings/addon-serialize.d.ts",
  "@xterm/addon-unicode-graphemes": "addons/addon-unicode-graphemes/typings/addon-unicode-graphemes.d.ts",
};

/** Bare specifiers that upstream resolves through `baseUrl: src`. */
const BASE_URL_PREFIXES = ["common/", "browser/"];

function run(command: string[], cwd?: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function relativeSpecifier(fromFile: string, toFile: string): string {
  const target = relative(dirname(fromFile), toFile).replace(/\.d\.ts$|\.ts$/, "");
  return target.startsWith(".") ? target : `./${target}`;
}

/** Unwraps `declare module 'x' { ... }` and points every typings import at a file. */
function rewrite(path: string, text: string): string {
  let out = text;
  if (path.endsWith(".d.ts")) {
    const open = /^declare module '[^']+' \{\n/m;
    if (!open.test(out) || !out.trimEnd().endsWith("}")) {
      throw new Error(`${path}: expected one ambient module block`);
    }
    out = `${out.replace(open, "").trimEnd().slice(0, -1).trimEnd()}\n`;
  }
  return out.replace(/from '([^']+)'/g, (match, specifier: string) => {
    const typings = AMBIENT_TYPINGS[specifier];
    if (typings !== undefined) return `from '${relativeSpecifier(path, typings)}'`;
    if (BASE_URL_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
      return `from '${relativeSpecifier(path, `src/${specifier}`)}'`;
    }
    return match;
  });
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full).map((f) => join(entry, f)));
    else out.push(entry);
  }
  return out.sort();
}

const [clone, flag] = process.argv.slice(2);
if (clone === undefined || (flag !== undefined && flag !== "--check")) {
  throw new Error("usage: bun native/xterm/scripts/vendor.ts <xterm.js clone> [--check]");
}
const vendorRoot = resolve(import.meta.dir, "..");
const target = flag === "--check" ? mkdtempSync(join(vendorRoot, ".check-")) : join(vendorRoot, "upstream");

try {
  rmSync(target, { recursive: true, force: true });
  for (const [path, commit] of FILES) {
    const text = run(["git", "show", `${commit}:${path}`], clone);
    const out = join(target, path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, rewrite(path, text));
  }
  const localPatch = join(vendorRoot, "local.patch");
  if (readFileSync(localPatch, "utf8").length > 0) {
    run(["patch", "-p1", "--quiet", "--batch", "--forward", "-i", localPatch], target);
  }
  if (flag === "--check") {
    const committed = join(vendorRoot, "upstream");
    const expected = listFiles(target);
    const actual = listFiles(committed);
    const mismatched = [...new Set([...expected, ...actual])].filter(
      (file) =>
        !expected.includes(file) ||
        !actual.includes(file) ||
        readFileSync(join(target, file), "utf8") !== readFileSync(join(committed, file), "utf8"),
    );
    if (mismatched.length > 0) throw new Error(`native/xterm/upstream differs: ${mismatched.join(", ")}`);
    console.log(`native/xterm/upstream matches (${expected.length} files)`);
  }
} finally {
  if (flag === "--check") rmSync(target, { recursive: true, force: true });
}
