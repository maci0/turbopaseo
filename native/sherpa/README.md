# sherpa-onnx through scriptc FFI

The `sherpa-onnx-node` stand-in for scriptc binaries: `sherpa-onnx-ffi.ts` exports `Vad`, `CircularBuffer`, `OfflineRecognizer` (with `OfflineStream`) and `OfflineTts` under the addon's class, method and config field names, over a C++ shim (`sherpa_shim.cc`) of sherpa-onnx's C API, bound through the manifest `ffi.json`. Paseo's speech worker uses it natively; Node keeps the addon.

What Paseo calls, with file:line references and the C API behind each call: [INVENTORY.md](INVENTORY.md).

## Files

- `sherpa_shim.cc`: 38 exported wrappers (config builder, VAD, circular buffer, offline recognizer, offline TTS with threaded generation, last-error text)
- `ffi.json`: scriptc manifest, format 7, one binding per wrapper
- `sherpa-onnx-ffi.ts`: the module with the addon's classes; holds every `declare function` the manifest needs
- `speech-worker.ts`: native entry of the speech worker; registers the module with Paseo's loader, then runs `worker-process.ts`
- `build.sh`: builds the shim archive, and given an entry, a binary with `lib/` and `assets/` beside it
- `proof/`: the proof programs and `run.sh`, which builds and runs them (below)

## How Paseo uses it

All changes are under `packages/server/src/server/speech/providers/local/` and behave as before under Node.

- `sherpa/sherpa-onnx-node-loader.ts`: `registerSherpaOnnxNode(module)` stores a module; `loadSherpaOnnxNode()` returns it when set, throws in a scriptc binary when not, and otherwise runs the unchanged `require` chain for the addon. Nothing in the Node program registers, so the addon stays out of the native program (the loader's `require` calls go through a loader passed as a value, which scriptc resolves only when it runs).
- `worker-client.ts`: in a scriptc binary (`process.argv[0] === "scriptc"`) forks `new URL("../../../../../native/speech-worker.ts", import.meta.url)`, that is `packages/server/native/speech-worker.ts`, which scriptc embeds; the build copies `speech-worker.ts` there beside the daemon entry. The native child is wrapped (`NativeLocalSpeechWorkerProcess`). Node's fork, with its run-time path, `.ts` loader flags and `serialization: "advanced"`, goes through `createRequire(...)("node:child_process")` held as a value.
- `worker-bytes.ts`: audio crosses IPC as an `ArrayBuffer` under Node and as base64 text natively (native IPC is JSON only).
- `sherpa/silero-vad-session.ts`: natively the bundled VAD model is `<dirname(process.execPath)>/assets/silero_vad.onnx`.

### Native constraints the Paseo changes work around

| scriptc 0.4.10 behaviour | Change |
|---|---|
| `fork()` with a module path computed at run time is refused (SC2020), also on a branch only Node takes and through a `typeof fork` alias | Node's fork comes from `require("node:child_process")` on a loader held as a value (`requireNodeChildProcess`); the native fork has a static `new URL` |
| A static fork path that does not exist at build time is refused (SC0001), so `./worker-process.js` cannot be named | Only the `.ts` entry is named natively |
| IPC message types must be JSON-shaped (SC1090); `serialization: "advanced"` is refused | `toWorkerIpcMessage` (worker-protocol.ts) hides the static type at each send; listeners take `unknown`; bytes are base64 natively |
| A JSON value cast to `LocalSpeechWorkerToParentMessage` takes the first arm that fits, the `ok: true` arm even for a failure, and narrowing then traps | `decodeNativeParentMessage` rebuilds failure responses |
| A forked child emits `exit` but never `close` | The native wrapper registers `close` listeners on `exit` |
| A `ChildProcess` cannot be viewed through `LocalSpeechWorkerProcess` (SC2002) | `NativeLocalSpeechWorkerProcess` wraps it |
| A record holding a class can be constructed through only when the receiving interface has no intersection-typed member; required members must be method signatures, not function-typed properties (a property reads `undefined` at run time) | `SherpaOfflineRecognizerNative`, `SherpaOfflineStreamNative`, `SherpaOfflineTtsNative` use method signatures; the WASM `acceptWaveform(sampleRate, samples)` branch (never taken with the Node addon, whose method takes one argument) is gone |
| `"x" in value` is false for methods a class defines | worker-process.ts records each session's kind and dispatches on it; `recognizerResultText` narrows with `typeof` |
| EventEmitter's inherited `on()` is not reachable through an interface (`session.on is not a function`) | `trackTranscriptionSession` and `trackTurnDetectionSession` are generic over the session class; `SherpaSileroTurnDetectionProvider.createSession` returns the class |
| One event name must carry one payload type in the whole program (SC2020 "conflicting argument types") | `transcript` payloads are typed `StreamingTranscriptionEvent` |
| Dynamic keyed reads, and `Object.entries`, over a record literal whose fields differ in type (SC1090, SC2003) | `SHERPA_ONNX_MODEL_CATALOG` is typed `Record<id, SherpaOnnxCatalogEntry>` with the id lists written out (checked against each entry's kind at load); `engineFiles` reads fields in declaration order |
| `require.resolve` with a computed request, also on a held loader (SC2020) | `sherpa-runtime-env.ts` reaches `createRequire` through `require("node:module")` on a held loader |
| `uuid` 9 throws natively at load (`the exports object of './v1.js' as a value`) | the two sherpa STT sessions use `crypto.randomUUID()` |
| The DOM lib's global `URL` makes a static fork look run-time valued (finding from the supervisor work) | worker-client.ts and silero-vad-session.ts import `URL` from `node:url` |

## Proof

`proof/run.sh <models-dir> <scratch-dir> <tts-model-id>` copies the proof sources into `packages/server/zzprobe-sherpa/` (and `speech-worker.ts` into `packages/server/native/`), builds two binaries, removes the copies again, and runs:

- `proof.ts` drives Paseo's real `LocalSpeechWorkerClient`, which forks the real worker: text to speech; then, on one shared input file (the Node run's TTS output), one-shot STT (`transcribeVoice`), VAD (`createSession("vad")`: 1 s silence, the speech resampled to 16 kHz, 2 s silence, in 100 ms chunks), and dictation (`createSession("dictationStt")`, append, commit). It runs under Node with the real addon and natively; stdout is diffed.
- `ffi-check.ts` exercises the FFI module alone, natively.

Models used: `parakeet-tdt-110m-en-int8` (transducer, Paseo's default family) for STT, and `kokoro-int8-en-v0_19`, `kitten-nano-en-v0_2-fp16` and `piper-en-us-libritts-r` for TTS (261 MB of archives in total, sizes matching `downloadSizeBytes` in model-catalog.ts).

```console
$ native/sherpa/proof/run.sh .scratch/sherpa-full/models .scratch/sherpa-full/final kokoro-int8-en-v0_19
node exit=0
native exit=0
--- node
tts format=pcm;rate=24000 samples=99583 seconds=4.149 sha256=63a7bfa7…
input sha256=63a7bfa7… samples=99583
stt text="The quick brown fox jumps over the lazy dog, native speech works." lowConfidence=false
vad speech16k=66388 chunks=72 events=started@chunk23,stopped@chunk64
dictation final=["The quick brown fox jumps over the lazy dog, native speech works."]
--- native
tts format=pcm;rate=24000 samples=99542 seconds=4.148 sha256=33077b51…
input sha256=63a7bfa7… samples=99583
stt text="The quick brown fox jumps over the lazy dog, native speech works." lowConfidence=false
vad speech16k=66388 chunks=72 events=started@chunk23,stopped@chunk64
dictation final=["The quick brown fox jumps over the lazy dog, native speech works."]
--- diff
1c1   (the tts line only)
--- ffi-check
vad unknown key: TypeError: Vad config: unknown key 'sileroVad.thresholdd'
vad wrong type: TypeError: Vad config: wrong value type string at 'sampleRate'
vad boolean: TypeError: Vad config: unsupported boolean value at 'debug'
vad missing model: Error: sherpa-onnx Vad: please check your config: SherpaOnnxCreateVoiceActivityDetector failed (see stderr)
vad corrupt model: Error: sherpa-onnx Vad: please check your config: Failed to load model because protobuf parsing failed.
asr empty object: TypeError: OfflineRecognizer config: empty object at 'modelConfig.paraformer'
asr missing files: Error: sherpa-onnx OfflineRecognizer: please check your config: SherpaOnnxCreateOfflineRecognizer failed (see stderr)
vad use after free: Error: sherpa-onnx Vad used after free()
tts sampleRate=24000 numSpeakers=8
generated 100200 and 70800 samples at 24000 Hz in 610 ms; timer ticked 59 times meanwhile
generate after free: sherpa-onnx OfflineTts used after free()
ffi-check exit=0
```

Results:

- STT, VAD and dictation outputs are identical between Node and native for the same input, with Kokoro, Kitten and Piper audio as input.
- TTS is not byte-comparable: none of the three engines is deterministic within one runtime. Two Node runs of Kokoro gave 99569 and 99495 samples with different hashes, Kitten 145491 and 145490, Piper 80384 and 75520. Native lengths fall in the same ranges (Kokoro 99509 to 99557, Kitten 145490 and 149400, Piper 75264 to 82176), at the same sample rates (24000, 24000, 22050), and the parakeet transcription of native TTS audio reads back the input sentence.
- The corrupt-model case is an onnxruntime C++ exception caught by the shim's catch-all and thrown as a JavaScript `Error`.
- `generateAsync` runs on a native thread: a 10 ms interval fired 59 times during 610 ms of synthesis. Two queued generations ran in order, `free()` called while they were pending waited for them, and the process exited on its own (each foreign callback registration is released after its delivery).
- A copy of the proof binary with `lib/` and `assets/` moved to another directory ran from `/` with `env -i`. With `assets/` renamed, VAD creation failed although the source tree's `silero_vad.onnx` still existed, so the binary reads the model beside itself.

Under Node: `worker-client.test.ts` (8), `worker-bytes.test.ts` (1), `models.test.ts` (2), `sherpa/sherpa-tts.test.ts` (8), `sherpa/sherpa-parakeet-stt.test.ts` (1) and `sherpa/model-downloader.test.ts` (4) pass, each run alone.

The proof maps `pino` to `proof/pino-stub.ts` in its tsconfig, because pino 9 does not load in a scriptc binary (`atomic-sleep` replaces `module.exports` conditionally); the daemon needs its own answer for pino. The proof's parent also imports `zod` and `@getpaseo/plugin/server`, because scriptc compiles an npm package only when the parent program imports it, not when only an embedded fork target does.

## Native daemon build

1. Shim and libraries: `native/sherpa/build.sh` (no arguments). It copies `libsherpa-onnx-c-api.so` and `libonnxruntime.so` from `work/paseo/node_modules/sherpa-onnx-linux-x64/` into `native/sherpa/build/lib/` and compiles `sherpa_shim.cc` with `c++ -std=c++17 -O2 -Wall -Wextra -Werror -fPIC -I.scratch/sherpa/upstream/include` into `native/sherpa/build/libsherpa_shim.a`.
2. Copy `native/sherpa/speech-worker.ts` into `packages/server/native/` beside the daemon entry. Its imports are written for that location.
3. Build the daemon with `--ffi <repo>/native/sherpa/ffi.json`. The manifest links the archive, `build/lib/libsherpa-onnx-c-api.so` (as `NEEDED`, by SONAME) and `stdc++`. No tsconfig `paths` entry is needed for sherpa.
4. `patchelf --set-rpath '$ORIGIN/lib' <binary>`: the manifest has no rpath field.
5. Ship beside the binary: `lib/libsherpa-onnx-c-api.so` (5.6 MB) and `lib/libonnxruntime.so` (23.7 MB; found through the first library's own RPATH `$ORIGIN`), and `assets/silero_vad.onnx` (643,854 bytes, from `packages/server/src/server/speech/providers/local/sherpa/assets/`). Downloaded STT and TTS models stay under the configured models directory.

The shim compiles against the v1.12.28 `c-api.h` (sha256 `47c30e8f60e8cd78ca34acac2623f33aec3a3dc93b1994d36ec789db06e1d9de`, fetched from `https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.12.28/sherpa-onnx/c-api/c-api.h` into `.scratch/sherpa/upstream/include/sherpa-onnx/c-api/`) and must link the 1.12.28 library; bumping `sherpa-onnx-node` means refreshing the header and rebuilding. Static linking is not available from upstream (the npm package and release ship shared objects only).

## Shim design

- Configs: `sx_config_new(kind)`, then `sx_config_set_string` / `sx_config_set_number` per leaf, keyed by the addon's JavaScript path (`modelConfig.transducer.encoder`). Each kind has a table of exactly the fields Paseo sets; any other key returns an error and the TypeScript side throws. `model.kokoro.dictDir` is accepted and dropped, as the addon drops it. Unset fields stay zero, so the C layer applies its defaults as it does for keys the addon leaves out. Integers are truncated toward zero like the addon's `Int32Value`.
- Every exported function catches all C++ exceptions and turns them into its error result; the message is available through `sx_last_error`.
- Sample spans cross as `bytes` / `mutable-bytes` views of `Float32Array`s and are copied into aligned storage when a view is not 4-byte aligned.
- `sx_tts_generate_start` runs `SherpaOnnxOfflineTtsGenerateWithProgressCallbackWithArg` (the addon's entry point, with a callback that keeps going) on a `std::thread` and reports `(job, status)` through a format 5 foreign callback, which carries only integers; TypeScript then copies the audio by job id and releases the job. A per-handle mutex keeps generations on one handle from overlapping and makes `sx_tts_destroy` wait for a running one.

## Differences from the addon

Listed at the top of `sherpa-onnx-ffi.ts`: checked configs (unknown keys, non-string non-number values and empty objects throw), a real `free()` on every class with errors on use after it, `getResult` returning `{ text }` only, and `generateAsync` always copying samples without `onProgress` or `generationConfig`. Error messages differ from the addon's.

## Not verified

- STT families other than the transducer: whisper, sense_voice, dolphin and nemo_ctc keys are in the table but no such model was run. Parakeet v2/v3 (482 MB and 487 MB), whisper and the other STT models were not downloaded.
- `kokoro-en-v0_19` (fp32, 320 MB) and `kokoro-int8-multi-lang-v1_1` (lexicons, `dict/`, rule FSTs) were not run; the int8 English Kokoro, Kitten and Piper were.
- The daemon itself: the proof builds the worker client and worker into a small program, not the daemon. The unaligned-copy branch in `as_floats`. Platforms other than linux-x64.
- The native worker's stderr tail on a crash: `close` listeners run on `exit`, possibly before all stderr has been read.
