# sherpa-onnx-node usage in Paseo

What Paseo calls in `sherpa-onnx-node` 1.12.28, the sherpa-onnx C API functions behind each call, and whether scriptc FFI can reach them directly.

Paths are relative to `work/paseo/packages/server/src/server/speech/providers/local/`. Line numbers are from upstream v0.15.3, before the native changes listed in [README.md](README.md#how-paseo-uses-it). C API references are to `sherpa-onnx/c-api/c-api.h` at tag `v1.12.28` (sha256 `47c30e8f60e8cd78ca34acac2623f33aec3a3dc93b1994d36ec789db06e1d9de`, byte-identical to the header in the official `sherpa-onnx-v1.12.28-linux-x64-static.tar.bz2`). Addon behavior comes from the addon sources at the same tag (`harmony-os/SherpaOnnxHar/sherpa_onnx/src/main/cpp/{vad,non-streaming-asr,non-streaming-tts}.cc`; `scripts/node-addon-api/src/*.cc` are symlinks to them).

## How Paseo loads the addon

- `sherpa/sherpa-onnx-node-loader.ts:108` `require("sherpa-onnx-node")`, falling back to `require(<platform pkg>/sherpa-onnx.node)` at `:125`, after a `patchelf --set-rpath $ORIGIN` repair at `:132`.
- `sherpa/sherpa-onnx-node-loader.ts:12-18` types the module as `{ OfflineRecognizer, OnlineRecognizer?, OfflineTts?, Vad?, CircularBuffer? }`. `OnlineRecognizer` is declared but never constructed.
- `sherpa/sherpa-runtime-env.ts` resolves the platform package `sherpa-onnx-linux-x64` and prepends it to `LD_LIBRARY_PATH`. `worker-client.ts:96` applies that env before `fork()`ing the speech worker (`worker-client.ts:97`). All sherpa calls run in that worker process (`worker-process.ts`), not in the daemon.
- No Paseo file imports `sherpa-onnx-node` directly; every consumer calls `loadSherpaOnnxNode()`. That loader is the single place to swap in an FFI module; native builds do it with `registerSherpaOnnxNode` from `speech-worker.ts`.

Native files in `work/paseo/node_modules/sherpa-onnx-linux-x64/`: `libsherpa-onnx-c-api.so` (5.6 MB, SONAME `libsherpa-onnx-c-api.so`, RPATH `$ORIGIN`, contains version string `1.12.28`), `libonnxruntime.so` (23.7 MB), `libsherpa-onnx-cxx-api.so`, and the addon `sherpa-onnx.node` (its RUNPATH is `$ORIGIN` plus a CI build path). `nm -D --undefined-only sherpa-onnx.node` lists 118 `SherpaOnnx*` imports; the ones on Paseo's paths are below.

## 1. Vad (Silero voice activity detection)

Used by `sherpa/silero-vad-session.ts`.

| Paseo call | Where | C API | FFI |
|---|---|---|---|
| `new Vad({ sileroVad: { model, threshold, minSilenceDuration, minSpeechDuration, windowSize }, sampleRate, numThreads, provider, debug }, bufferSizeInSeconds)` | `silero-vad-session.ts:108-123` | `SherpaOnnxCreateVoiceActivityDetector(const SherpaOnnxVadModelConfig *, float)` | wrapper: nested config struct by pointer, `const char *` paths |
| `vad.acceptWaveform(Float32Array)` | `:149` | `SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad, const float *, int32_t)` | wrapper: float data crosses as `bytes` |
| `vad.isDetected()` | `:199` | `SherpaOnnxVoiceActivityDetectorDetected` -> `int32_t` | direct with format 7 `pointer`; wrapped only for a `bool` return |
| `vad.flush()` | `:166` | `SherpaOnnxVoiceActivityDetectorFlush` | direct |
| `vad.reset()` | `:183` | `SherpaOnnxVoiceActivityDetectorReset` | direct |
| `isEmpty()` | declared `:25`, never called | `SherpaOnnxVoiceActivityDetectorEmpty` | direct |

Values Paseo passes (`silero-vad-session.ts:8-16, 109-122`): `threshold 0.5`, `minSilenceDuration 0.2`, `minSpeechDuration 0.1`, `windowSize 512`, `sampleRate 16000`, `numThreads 1`, `provider "cpu"`, `debug 0`, buffer 60 s. `maxSpeechDuration` is not passed; the C layer defaults zero fields (`c-api.cc` `GetVadModelConfig`: max speech 20 s).

Not used by Paseo: `front()`, `pop()`, `clear()` (segment queue). The proof wraps them anyway so it can print segments.

## 2. CircularBuffer

Used by `sherpa/silero-vad-session.ts` to cut incoming PCM into 512-sample windows.

| Paseo call | Where | C API | FFI |
|---|---|---|---|
| `new CircularBuffer(60 * 16000)` | `:124-126` | `SherpaOnnxCreateCircularBuffer(int32_t)` | direct (`pointer` return) |
| `push(Float32Array)` | `:144` | `SherpaOnnxCircularBufferPush(buf, const float *, int32_t)` | wrapper (`bytes`) |
| `size()` | `:146` | `SherpaOnnxCircularBufferSize` | direct |
| `head()` | `:147` | `SherpaOnnxCircularBufferHead` | direct |
| `get(head, 512, false)` | `:147` | `SherpaOnnxCircularBufferGet` returns a malloc'd `const float *`, freed by `SherpaOnnxCircularBufferFree` | wrapper: copies into a caller `mutable-bytes` buffer, frees, returns count |
| `pop(512)` | `:148` | `SherpaOnnxCircularBufferPop` | direct |
| `reset()` | `:184` | `SherpaOnnxCircularBufferReset` | direct |

The buffer is plain FIFO bookkeeping. A TypeScript ring buffer could replace it outright and save eight bindings plus one copy per window; the proof keeps the native one to match Paseo exactly.

## 3. OfflineRecognizer and OfflineStream (speech to text)

Built in `sherpa/sherpa-offline-recognizer.ts`, used by `sherpa/sherpa-parakeet-stt.ts` (one-shot) and `sherpa/sherpa-parakeet-realtime-session.ts` (re-decodes the growing buffer every 350 ms). Constructed from `worker-process.ts:87-95` with `numThreads: 2, debug: 0`.

| Paseo call | Where | C API | FFI |
|---|---|---|---|
| `new OfflineRecognizer(config)` | `sherpa-offline-recognizer.ts:108-112` | `SherpaOnnxCreateOfflineRecognizer(const SherpaOnnxOfflineRecognizerConfig *)` | wrapper: about 40 nested fields, only some set |
| `recognizer.config.featConfig.sampleRate` (read back) | `:113` upstream; the native change reads the value from the config Paseo built, which is the object the addon keeps | none | none |
| `recognizer.createStream()` | `:126` | `SherpaOnnxCreateOfflineStream(recognizer)` | direct |
| `stream.acceptWaveform({ samples, sampleRate })` | `:141` (the `(sampleRate, samples)` branch at `:143` upstream is the WASM signature, never taken with the Node addon; the native change removed it) | `SherpaOnnxAcceptWaveformOffline(stream, int32_t sample_rate, const float *, int32_t n)` | wrapper (`bytes`) |
| `recognizer.decode(stream)` | `sherpa-parakeet-stt.ts:152`, `sherpa-parakeet-realtime-session.ts:148` | `SherpaOnnxDecodeOfflineStream(recognizer, stream)` | direct; synchronous in Paseo too |
| `recognizer.getResult(stream)` -> `{ text }` | `sherpa-parakeet-stt.ts:153`, `sherpa-parakeet-realtime-session.ts:149` | `SherpaOnnxGetOfflineStreamResultAsJson(stream)` -> `const char *`, freed by `SherpaOnnxDestroyOfflineStreamResultJson`; JS does `JSON.parse` | wrapper: string returns are unsupported, so length query plus copy into `mutable-bytes` |
| `stream.free?.()` | `sherpa-parakeet-stt.ts:164`, `sherpa-parakeet-realtime-session.ts:157` | `SherpaOnnxDestroyOfflineStream` | direct. The addon's JS classes have no `free` method (no `free` in any `sherpa-onnx-node/*.js`), so today this is a no-op and the stream is freed by the N-API finalizer on GC |
| `recognizer.free?.()` | `sherpa-offline-recognizer.ts:149` | `SherpaOnnxDestroyOfflineRecognizer` | direct; also a no-op today |

Config Paseo builds (`sherpa-offline-recognizer.ts:15-46, 92-106`), mapped to C fields:

| JS field | C field |
|---|---|
| `featConfig.sampleRate` (16000), `featConfig.featureDim` (80) | `feat_config.sample_rate`, `feat_config.feature_dim` |
| `modelConfig.transducer.{encoder,decoder,joiner}` | `model_config.transducer.*` |
| `modelConfig.modelType` (`"nemo_transducer"` for transducers) | `model_config.model_type` |
| `modelConfig.whisper.{encoder,decoder,language "",task "transcribe"}` | `model_config.whisper.*` (`tail_paddings` left 0; C layer default) |
| `modelConfig.senseVoice.{model,language "",useInverseTextNormalization 1}` | `model_config.sense_voice.{model,language,use_itn}` |
| `modelConfig.dolphin.model` | `model_config.dolphin.model` |
| `modelConfig.nemoCtc.model` | `model_config.nemo_ctc.model` |
| `modelConfig.tokens`, `numThreads`, `provider "cpu"`, `debug 0` | `model_config.tokens`, `num_threads`, `provider`, `debug` |
| `decodingMethod "greedy_search"`, `maxActivePaths 4` | `decoding_method`, `max_active_paths` |

## 4. OfflineTts (text to speech)

`sherpa/sherpa-tts.ts`, constructed from `worker-process.ts:122`.

| Paseo call | Where | C API | FFI |
|---|---|---|---|
| `new OfflineTts({ model, maxNumSentences: 1, ruleFsts })` | `sherpa-tts.ts:121-129` | `SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig *)`; the JS constructor also calls `SherpaOnnxOfflineTtsNumSpeakers` and `SherpaOnnxOfflineTtsSampleRate` | wrapper (nested struct) |
| `tts.sampleRate` | `:181-182` | `SherpaOnnxOfflineTtsSampleRate` | direct |
| `tts.generateAsync({ text, sid, speed, enableExternalBuffer: false })` -> `{ samples: Float32Array, sampleRate }` | `:156-163` | addon runs `SherpaOnnxOfflineTtsGenerateWithProgressCallbackWithArg(tts, text, sid, speed, cb, arg)` on a libuv worker thread (`non-streaming-tts.cc:703-760`); Paseo passes no `onProgress`, so `SherpaOnnxOfflineTtsGenerate` gives the same audio. Result `const SherpaOnnxGeneratedAudio *` (`samples`, `n`, `sample_rate`), freed by `SherpaOnnxDestroyOfflineTtsGeneratedAudio` | wrapper: struct pointer return, `const char *` text, sample copy-out. Keeping it off the event loop needs a native thread plus a format 5 foreign callback (see README) |
| `tts.free?.()` | `:210` | `SherpaOnnxDestroyOfflineTts` | direct; no-op today (no `free` method in the JS class) |

Model config (`sherpa-tts.ts:28-72, 114-125`):

| JS field | C field |
|---|---|
| `model.numThreads` (2), `model.provider "cpu"` | `model.num_threads`, `model.provider` |
| `model.kokoro.{model,voices,tokens,dataDir,lexicon,lengthScale}` | `model.kokoro.{model,voices,tokens,data_dir,lexicon,length_scale}` |
| `model.kokoro.dictDir` | `model.kokoro.dict_dir`, marked unused in `c-api.h`; the addon does not read `dictDir` at all, so Paseo's value is dropped today |
| `model.kitten.{model,voices,tokens,dataDir,lengthScale}` | `model.kitten.*` |
| `model.vits.{model,tokens,dataDir,lengthScale}` | `model.vits.*` |
| `maxNumSentences` (1), `ruleFsts` | `max_num_sentences`, `rule_fsts` |

## Not used

`OnlineRecognizer`, keyword spotting, speaker ID and diarization, punctuation, audio tagging, denoising, wave I/O, `createAsync`, `decodeAsync`, `setConfig`, `generate` (sync), `generationConfig`, `onProgress`, `Vad.front/pop/clear`.

## Model files

| Model | Files Paseo checks before loading | Location |
|---|---|---|
| Silero VAD | `silero_vad.onnx` (643,854 bytes) | Bundled at `sherpa/assets/silero_vad.onnx`, found with `new URL("./assets/silero_vad.onnx", import.meta.url)` (`silero-vad-session.ts:44-46`). `ensureSileroVadModel` (`silero-vad-provider.ts:24-40`) copies it to `<modelsDir>/silero-vad/silero_vad.onnx` because native code cannot read inside Electron's `app.asar`; the worker uses that copy (`worker-process.ts:199-205`) and falls back to the bundled path. `build:lib` in `package.json:76` copies the asset into `dist/`. |
| STT, 10 catalog entries | `engineFiles(engine)` (`sherpa/model-catalog.ts:551`): transducer `encoder/decoder/joiner.int8.onnx` + `tokens.txt` (Parakeet, default for STT); whisper `<size>-encoder/decoder.int8.onnx` + `<size>-tokens.txt`; sense_voice, dolphin, nemo_ctc `model.int8.onnx` + `tokens.txt` | `<modelsDir>/<extractedDir>/`, from `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/<name>.tar.bz2` (`model-catalog.ts:48-53`) |
| TTS, 9 catalog entries | kokoro `model[.int8].onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/`, optional lexicons, `dict/`, rule FSTs (default for TTS: `kokoro-en-v0_19`); kitten `model.fp16.onnx`, `voices.bin`, `tokens.txt`, `espeak-ng-data/`; piper (vits) `<voice>.onnx`, `tokens.txt`, `espeak-ng-data/` | `<modelsDir>/<extractedDir>/`, from `.../releases/download/tts-models/<name>.tar.bz2` |

`modelsDir` defaults to `<paseoHome>/models/local-speech` (`speech/providers/local/config.ts:38`) and can be overridden by `PASEO_LOCAL_MODELS_DIR` or `providers.local.modelsDir`. The downloader (`sherpa/model-downloader.ts`) uses `fetch` and extracts by spawning `tar xf` (`:87-110`); it never touches sherpa itself.
