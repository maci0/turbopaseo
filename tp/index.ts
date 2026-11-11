// tp: installs, updates and removes turbopaseo's native Paseo from GitHub releases.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const REPO = "maci0/turbopaseo";
// Overridable so a fork, a mirror or a test server can stand in for api.github.com.
const API = process.env.TP_API ?? "https://api.github.com";
const PREFIX = process.env.TP_PREFIX ?? join(homedir(), ".local");
const OPT = join(PREFIX, "opt", "turbopaseo");
const BIN = join(PREFIX, "bin");
const HOST = `${process.platform}-${process.arch}`;

type Asset = { name: string; browser_download_url: string };
type Release = { tag_name: string; assets: Asset[] };

function fail(message: string): never {
  console.error(`tp: ${message}`);
  process.exit(1);
}

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, { headers: { accept, "user-agent": "tp" } });
  if (!response.ok) fail(`${url}: HTTP ${response.status}`);
  return response;
}

async function latestRelease(): Promise<Release> {
  const response = await get(`${API}/repos/${REPO}/releases/latest`, "application/vnd.github+json");
  return (await response.json()) as Release;
}

function asset(release: Release, match: (name: string) => boolean, what: string): Asset {
  const found = release.assets.find((a) => match(a.name));
  if (!found) fail(`release ${release.tag_name} has no ${what}`);
  return found;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Downloads an asset and checks it against the `<name>.sha256` asset beside it. */
async function download(release: Release, file: Asset): Promise<Uint8Array> {
  const sum = asset(release, (n) => n === `${file.name}.sha256`, `${file.name}.sha256`);
  const expected = (await (await get(sum.browser_download_url, "application/octet-stream")).text()).split(/\s/)[0];
  const bytes = new Uint8Array(await (await get(file.browser_download_url, "application/octet-stream")).arrayBuffer());
  if (sha256(bytes) !== expected) fail(`checksum mismatch for ${file.name}`);
  return bytes;
}

function readLink(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : "";
  } catch {
    return undefined; // missing
  }
}

function installedTag(): string | undefined {
  const file = join(OPT, "release");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

const PASEO_LINK = join(BIN, "paseo");

/** Fails unless bin/paseo is missing or a symlink into OPT, which tp may replace. */
function checkPaseoLink(): void {
  const current = readLink(PASEO_LINK);
  if (current !== undefined && !current.startsWith(OPT + "/")) {
    fail(`${PASEO_LINK} exists and is not a turbopaseo link; move it away first`);
  }
}

/** Unpacks a Paseo tarball into OPT and makes it current. */
function unpack(tarball: string, tag: string): void {
  checkPaseoLink();
  const name = basename(tarball).replace(/\.tar\.gz$/, "");
  const stage = join(OPT, ".stage");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // tar(1): the runtime has no tar or gzip reader.
  const tar = spawnSync("tar", ["-xzf", tarball, "-C", stage], { stdio: "inherit" });
  if (tar.status !== 0) fail(`tar failed on ${tarball}`);
  if (!existsSync(join(stage, name, "paseo"))) fail(`${tarball} holds no ${name}/paseo`);
  rmSync(join(OPT, name), { recursive: true, force: true });
  renameSync(join(stage, name), join(OPT, name));
  rmSync(stage, { recursive: true, force: true });
  rmSync(join(OPT, "current"), { force: true });
  symlinkSync(name, join(OPT, "current"));
  writeFileSync(join(OPT, "release"), `${tag}\n`);
  mkdirSync(BIN, { recursive: true });
  rmSync(PASEO_LINK, { force: true });
  symlinkSync(join(OPT, "current", "paseo"), PASEO_LINK);
  for (const old of readdirSync(OPT)) {
    if (old.startsWith("paseo-") && old !== name) rmSync(join(OPT, old), { recursive: true, force: true });
  }
  console.log(`installed ${name} (${tag}) in ${OPT}`);
  console.log("a running daemon keeps the old binary until: paseo daemon restart");
}

async function install(force: boolean): Promise<void> {
  checkPaseoLink();
  const release = await latestRelease();
  if (!force && installedTag() === release.tag_name) {
    console.log(`up to date: ${release.tag_name}`);
    return;
  }
  const tarball = asset(release, (n) => n.startsWith("paseo-") && n.endsWith(`-${HOST}.tar.gz`), "Paseo tarball");
  console.log(`downloading ${tarball.name} from ${release.tag_name}`);
  const bytes = await download(release, tarball);
  mkdirSync(OPT, { recursive: true });
  const path = join(OPT, tarball.name);
  writeFileSync(path, bytes);
  unpack(path, release.tag_name);
  rmSync(path, { force: true });
}

async function selfUpdate(): Promise<void> {
  const release = await latestRelease();
  const self = process.execPath;
  const file = asset(release, (n) => n === `tp-${HOST}`, "tp binary");
  const bytes = await download(release, file);
  if (sha256(bytes) === sha256(readFileSync(self))) {
    console.log(`tp is up to date (${release.tag_name})`);
    return;
  }
  writeFileSync(`${self}.new`, bytes);
  chmodSync(`${self}.new`, 0o755);
  renameSync(`${self}.new`, self);
  console.log(`tp updated to ${release.tag_name}`);
}

function remove(): void {
  const target = readLink(PASEO_LINK);
  if (target !== undefined && target.startsWith(OPT + "/")) rmSync(PASEO_LINK);
  else if (target !== undefined) console.error(`tp: left ${PASEO_LINK}, not a turbopaseo link`);
  rmSync(OPT, { recursive: true, force: true });
  console.log(`removed ${OPT}; ~/.paseo and tp stay`);
}

function status(): void {
  const tag = installedTag();
  if (tag === undefined) {
    console.log(`not installed in ${PREFIX}`);
    return;
  }
  console.log(`installed: ${readLink(join(OPT, "current"))} (${tag}) in ${OPT}`);
  console.log(`paseo: ${PASEO_LINK} -> ${readLink(PASEO_LINK) ?? "missing"}`);
}

const USAGE = `usage: tp <command>
  install [tarball]  install the latest release, or a local dist tarball
  update             install the latest release if it is newer
  self-update        replace tp with the latest release's tp-${HOST}
  remove             delete the install and the paseo link (~/.paseo and tp stay)
  status             show what is installed
Installs into $TP_PREFIX (now ${PREFIX}): opt/turbopaseo/, bin/paseo.`;

async function main(args: string[]): Promise<void> {
  const [command, arg] = args;
  if (command === "install" && arg !== undefined) {
    const sum = readFileSync(`${arg}.sha256`, "utf8").split(/\s/)[0];
    if (sha256(readFileSync(arg)) !== sum) fail(`checksum mismatch for ${arg}`);
    unpack(arg, `local:${basename(arg)}`);
  } else if (command === "install") await install(true);
  else if (command === "update") await install(false);
  else if (command === "self-update") await selfUpdate();
  else if (command === "remove") remove();
  else if (command === "status") status();
  else if (command === "help" || command === "--help" || command === "-h") console.log(USAGE);
  else {
    console.error(USAGE);
    process.exit(2);
  }
}

await main(process.argv.slice(2));
