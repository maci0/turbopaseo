// usage: bun scripts/merge-ffi.ts <out.json> <manifest.json>...
// scriptc takes one --ffi manifest. This merges several into one, resolving
// each `libraries` entry against its own manifest so the output can live anywhere.
import { dirname, resolve } from "node:path";

interface Manifest {
  ffi_format: number;
  functions: { name: string }[];
  libraries?: string[];
  system_libraries?: string[];
}

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error("usage: bun scripts/merge-ffi.ts <out.json> <manifest.json>...");
  process.exit(2);
}

const merged: Required<Manifest> = { ffi_format: 0, functions: [], libraries: [], system_libraries: [] };
const seen = new Map<string, string>();
for (const input of inputs) {
  const manifest = (await Bun.file(input).json()) as Manifest;
  const known = new Set(["ffi_format", "functions", "libraries", "system_libraries"]);
  const extra = Object.keys(manifest).filter((key) => !known.has(key));
  if (extra.length > 0) throw new Error(`${input}: keys this script does not merge: ${extra.join(", ")}`);
  merged.ffi_format = Math.max(merged.ffi_format, manifest.ffi_format);
  for (const fn of manifest.functions) {
    const first = seen.get(fn.name);
    if (first) throw new Error(`function ${fn.name} is declared in both ${first} and ${input}`);
    seen.set(fn.name, input);
    merged.functions.push(fn);
  }
  for (const lib of manifest.libraries ?? []) merged.libraries.push(resolve(dirname(input), lib));
  for (const lib of manifest.system_libraries ?? []) {
    if (!merged.system_libraries.includes(lib)) merged.system_libraries.push(lib);
  }
}
await Bun.write(out, `${JSON.stringify(merged, null, 2)}\n`);
