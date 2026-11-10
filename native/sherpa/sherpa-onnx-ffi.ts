// sherpa-onnx-node's Vad, CircularBuffer, OfflineRecognizer and OfflineTts for
// scriptc binaries, over sherpa_shim.cc through the FFI manifest ffi.json.
//
// Class, method and config field names are the addon's (sherpa-onnx-node
// 1.12.28). Differences from the addon:
// - Config objects are checked: a key the shim does not know, a value that is
//   not a string, a number or a nested object, and an empty nested object all
//   throw. The addon ignores them. `undefined` values are skipped, as the addon
//   skips them.
// - Every class has `free()`, which releases the native object at once; the
//   addon frees on garbage collection. A freed object throws on use.
// - getResult returns `{ text }` only.
// - generateAsync always returns copied samples (enableExternalBuffer is
//   ignored) and has no onProgress or generationConfig.

declare function sxLastError(out: Uint8Array): number;
declare function sxConfigNew(kind: number): bigint;
declare function sxConfigFree(cfg: bigint): void;
declare function sxConfigSetString(cfg: bigint, key: string, value: string): number;
declare function sxConfigSetNumber(cfg: bigint, key: string, value: number): number;

declare function sxVadCreate(cfg: bigint, bufferSizeInSeconds: number): bigint;
declare function sxVadDestroy(vad: bigint): void;
declare function sxVadAcceptWaveform(vad: bigint, samples: Uint8Array): number;
declare function sxVadIsDetected(vad: bigint): number;
declare function sxVadIsEmpty(vad: bigint): number;
declare function sxVadFlush(vad: bigint): number;
declare function sxVadReset(vad: bigint): number;

declare function sxCbCreate(capacity: number): bigint;
declare function sxCbDestroy(cb: bigint): void;
declare function sxCbPush(cb: bigint, samples: Uint8Array): number;
declare function sxCbGet(cb: bigint, startIndex: number, n: number, out: Uint8Array): number;
declare function sxCbPop(cb: bigint, n: number): number;
declare function sxCbSize(cb: bigint): number;
declare function sxCbHead(cb: bigint): number;
declare function sxCbReset(cb: bigint): number;

declare function sxAsrCreate(cfg: bigint): bigint;
declare function sxAsrDestroy(rec: bigint): void;
declare function sxAsrStreamCreate(rec: bigint): bigint;
declare function sxAsrStreamDestroy(stream: bigint): void;
declare function sxAsrAcceptWaveform(
  stream: bigint,
  sampleRate: number,
  samples: Uint8Array,
): number;
declare function sxAsrDecode(rec: bigint, stream: bigint): number;
declare function sxAsrResultJson(stream: bigint, out: Uint8Array): number;

declare function sxTtsCreate(cfg: bigint): bigint;
declare function sxTtsDestroy(tts: bigint): void;
declare function sxTtsSampleRate(tts: bigint): number;
declare function sxTtsNumSpeakers(tts: bigint): number;
declare function sxTtsGenerateStart(
  tts: bigint,
  text: string,
  sid: number,
  speed: number,
  done: (job: number, status: number) => void,
): number;
declare function sxTtsGenerateRelease(done: (job: number, status: number) => void): void;
declare function sxTtsJobLength(job: number): number;
declare function sxTtsJobSampleRate(job: number): number;
declare function sxTtsJobCopy(job: number, out: Uint8Array): number;
declare function sxTtsJobError(job: number, out: Uint8Array): number;
declare function sxTtsJobRelease(job: number): void;

// sx_config_new kinds, sx_config_set_* results and TTS job statuses (sherpa_shim.cc).
const CONFIG_KIND_VAD = 1;
const CONFIG_KIND_OFFLINE_RECOGNIZER = 2;
const CONFIG_KIND_OFFLINE_TTS = 3;
const SET_OK = 0;
const SET_UNKNOWN_KEY = 1;
const SET_WRONG_TYPE = 2;
const TTS_DONE = 0;
const TTS_NO_AUDIO = 1;

const NULL_HANDLE = 0n;
const BYTES_PER_SAMPLE = 4;
// First-try buffer for error messages and recognizer result JSON; longer ones
// are fetched again with a buffer of the reported length.
const TEXT_BUFFER_BYTES = 4096;

function copiedText(fetch: (out: Uint8Array) => number): string {
  let out = new Uint8Array(TEXT_BUFFER_BYTES);
  let length = fetch(out);
  if (length > out.byteLength) {
    out = new Uint8Array(length);
    length = fetch(out);
  }
  return Buffer.from(
    out.buffer,
    out.byteOffset,
    Math.max(0, Math.min(length, out.byteLength)),
  ).toString("utf8");
}

function lastError(): string {
  return copiedText((out) => sxLastError(out));
}

function failure(what: string): Error {
  return new Error(`sherpa-onnx ${what}: ${lastError()}`);
}

function checkStatus(status: number, what: string): void {
  if (status < 0) throw failure(what);
}

function sampleBytes(samples: Float32Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function setConfigValue(cfg: bigint, className: string, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  let status: number;
  if (typeof value === "string") {
    status = sxConfigSetString(cfg, key, value);
  } else if (typeof value === "number") {
    status = sxConfigSetNumber(cfg, key, value);
  } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      throw new TypeError(`${className} config: empty object at '${key}'`);
    }
    for (const [name, inner] of entries) {
      setConfigValue(cfg, className, key === "" ? name : `${key}.${name}`, inner);
    }
    return;
  } else {
    throw new TypeError(
      `${className} config: unsupported ${value === null ? "null" : typeof value} value at '${key}'`,
    );
  }
  if (status === SET_UNKNOWN_KEY) {
    throw new TypeError(`${className} config: unknown key '${key}'`);
  }
  if (status === SET_WRONG_TYPE) {
    throw new TypeError(`${className} config: wrong value type ${typeof value} at '${key}'`);
  }
  if (status !== SET_OK) {
    throw failure(`${className} config '${key}'`);
  }
}

// Builds the native config, passes it to create, and frees it: sherpa copies
// what it needs during the create call.
function createFromConfig(
  kind: number,
  className: string,
  config: unknown,
  create: (cfg: bigint) => bigint,
): bigint {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError(`${className}: config must be an object`);
  }
  const cfg = sxConfigNew(kind);
  if (cfg === NULL_HANDLE) {
    throw failure(`${className} config`);
  }
  let handle = NULL_HANDLE;
  try {
    setConfigValue(cfg, className, "", config);
    handle = create(cfg);
  } finally {
    sxConfigFree(cfg);
  }
  if (handle === NULL_HANDLE) {
    throw failure(`${className}: please check your config`);
  }
  return handle;
}

function usedAfterFree(className: string): Error {
  return new Error(`sherpa-onnx ${className} used after free()`);
}

export class CircularBuffer {
  private handle: bigint;

  constructor(capacity: number) {
    this.handle = sxCbCreate(capacity);
    if (this.handle === NULL_HANDLE) {
      throw failure("CircularBuffer");
    }
  }

  push(samples: Float32Array): void {
    checkStatus(sxCbPush(this.live(), sampleBytes(samples)), "CircularBuffer.push");
  }

  // Always a copy; the addon's external-buffer view has no FFI equivalent.
  get(startIndex: number, n: number, _enableExternalBuffer?: boolean): Float32Array {
    const out = new Float32Array(n);
    checkStatus(sxCbGet(this.live(), startIndex, n, sampleBytes(out)), "CircularBuffer.get");
    return out;
  }

  pop(n: number): void {
    checkStatus(sxCbPop(this.live(), n), "CircularBuffer.pop");
  }

  size(): number {
    const size = sxCbSize(this.live());
    checkStatus(size, "CircularBuffer.size");
    return size;
  }

  head(): number {
    const head = sxCbHead(this.live());
    checkStatus(head, "CircularBuffer.head");
    return head;
  }

  reset(): void {
    checkStatus(sxCbReset(this.live()), "CircularBuffer.reset");
  }

  free(): void {
    if (this.handle !== NULL_HANDLE) {
      sxCbDestroy(this.handle);
      this.handle = NULL_HANDLE;
    }
  }

  private live(): bigint {
    if (this.handle === NULL_HANDLE) throw usedAfterFree("CircularBuffer");
    return this.handle;
  }
}

export class Vad {
  readonly config: unknown;
  private handle: bigint;

  constructor(config: unknown, bufferSizeInSeconds: number) {
    this.config = config;
    this.handle = createFromConfig(CONFIG_KIND_VAD, "Vad", config, (cfg) =>
      sxVadCreate(cfg, bufferSizeInSeconds),
    );
  }

  acceptWaveform(samples: Float32Array): void {
    checkStatus(sxVadAcceptWaveform(this.live(), sampleBytes(samples)), "Vad.acceptWaveform");
  }

  isDetected(): boolean {
    const detected = sxVadIsDetected(this.live());
    checkStatus(detected, "Vad.isDetected");
    return detected === 1;
  }

  isEmpty(): boolean {
    const empty = sxVadIsEmpty(this.live());
    checkStatus(empty, "Vad.isEmpty");
    return empty === 1;
  }

  flush(): void {
    checkStatus(sxVadFlush(this.live()), "Vad.flush");
  }

  reset(): void {
    checkStatus(sxVadReset(this.live()), "Vad.reset");
  }

  free(): void {
    if (this.handle !== NULL_HANDLE) {
      sxVadDestroy(this.handle);
      this.handle = NULL_HANDLE;
    }
  }

  private live(): bigint {
    if (this.handle === NULL_HANDLE) throw usedAfterFree("Vad");
    return this.handle;
  }
}

export interface Waveform {
  samples: Float32Array;
  sampleRate: number;
}

export interface OfflineRecognizerResult {
  text: string;
}

export class OfflineStream {
  private handle: bigint;

  constructor(handle: bigint) {
    this.handle = handle;
  }

  acceptWaveform(obj: Waveform): void {
    checkStatus(
      sxAsrAcceptWaveform(this.nativeHandle(), obj.sampleRate, sampleBytes(obj.samples)),
      "OfflineStream.acceptWaveform",
    );
  }

  free(): void {
    if (this.handle !== NULL_HANDLE) {
      sxAsrStreamDestroy(this.handle);
      this.handle = NULL_HANDLE;
    }
  }

  nativeHandle(): bigint {
    if (this.handle === NULL_HANDLE) throw usedAfterFree("OfflineStream");
    return this.handle;
  }
}

export class OfflineRecognizer {
  readonly config: unknown;
  private handle: bigint;

  constructor(config: unknown) {
    this.config = config;
    this.handle = createFromConfig(
      CONFIG_KIND_OFFLINE_RECOGNIZER,
      "OfflineRecognizer",
      config,
      (cfg) => sxAsrCreate(cfg),
    );
  }

  createStream(): OfflineStream {
    const stream = sxAsrStreamCreate(this.live());
    if (stream === NULL_HANDLE) {
      throw failure("OfflineRecognizer.createStream");
    }
    return new OfflineStream(stream);
  }

  decode(stream: OfflineStream): void {
    checkStatus(sxAsrDecode(this.live(), stream.nativeHandle()), "OfflineRecognizer.decode");
  }

  getResult(stream: OfflineStream): OfflineRecognizerResult {
    const handle = stream.nativeHandle();
    let failed = false;
    const json = copiedText((out) => {
      const length = sxAsrResultJson(handle, out);
      failed = length < 0;
      return length;
    });
    if (failed) {
      throw failure("OfflineRecognizer.getResult");
    }
    const parsed: unknown = JSON.parse(json);
    const text =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { text?: unknown }).text
        : undefined;
    if (typeof text !== "string") {
      throw new Error(`sherpa-onnx OfflineRecognizer.getResult: result has no text: ${json}`);
    }
    return { text };
  }

  free(): void {
    if (this.handle !== NULL_HANDLE) {
      sxAsrDestroy(this.handle);
      this.handle = NULL_HANDLE;
    }
  }

  private live(): bigint {
    if (this.handle === NULL_HANDLE) throw usedAfterFree("OfflineRecognizer");
    return this.handle;
  }
}

export interface TtsRequest {
  text: string;
  sid: number;
  speed: number;
  enableExternalBuffer?: boolean;
}

export interface GeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

function takeJobAudio(job: number, status: number): GeneratedAudio {
  if (status === TTS_NO_AUDIO) {
    throw new Error("sherpa-onnx OfflineTts.generateAsync: no audio generated");
  }
  if (status !== TTS_DONE) {
    throw new Error(
      `sherpa-onnx OfflineTts.generateAsync: ${copiedText((out) => sxTtsJobError(job, out))}`,
    );
  }
  const length = sxTtsJobLength(job);
  const sampleRate = sxTtsJobSampleRate(job);
  if (length < 0 || sampleRate <= 0) {
    throw new Error(`sherpa-onnx OfflineTts.generateAsync: job ${job} has no audio`);
  }
  const samples = new Float32Array(length);
  if (
    length > 0 &&
    sxTtsJobCopy(job, new Uint8Array(samples.buffer, 0, length * BYTES_PER_SAMPLE)) !== length
  ) {
    throw new Error(`sherpa-onnx OfflineTts.generateAsync: short copy for job ${job}`);
  }
  return { samples, sampleRate };
}

export class OfflineTts {
  readonly config: unknown;
  readonly numSpeakers: number;
  readonly sampleRate: number;
  private handle: bigint;
  private running = 0;
  private freeRequested = false;

  constructor(config: unknown) {
    this.config = config;
    this.handle = createFromConfig(CONFIG_KIND_OFFLINE_TTS, "OfflineTts", config, (cfg) =>
      sxTtsCreate(cfg),
    );
    this.numSpeakers = sxTtsNumSpeakers(this.handle);
    this.sampleRate = sxTtsSampleRate(this.handle);
  }

  // Synthesizes on a native thread; the event loop keeps running meanwhile.
  // Generations on one object run one after another, in call order.
  generateAsync(request: TtsRequest): Promise<GeneratedAudio> {
    if (typeof request.text !== "string") {
      return Promise.reject(new TypeError("The object['text'] should be a string"));
    }
    if (typeof request.sid !== "number") {
      return Promise.reject(new TypeError("The object['sid'] should be a number"));
    }
    if (typeof request.speed !== "number") {
      return Promise.reject(new TypeError("The object['speed'] should be a number"));
    }
    if (this.handle === NULL_HANDLE || this.freeRequested) {
      return Promise.reject(usedAfterFree("OfflineTts"));
    }
    const handle = this.handle;
    return new Promise<GeneratedAudio>((resolve, reject) => {
      const done = (job: number, status: number): void => {
        sxTtsGenerateRelease(done);
        this.running -= 1;
        try {
          resolve(takeJobAudio(job, status));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          sxTtsJobRelease(job);
          this.destroyIfIdle();
        }
      };
      this.running += 1;
      const job = sxTtsGenerateStart(handle, request.text, request.sid, request.speed, done);
      if (job < 0) {
        sxTtsGenerateRelease(done);
        this.running -= 1;
        reject(failure("OfflineTts.generateAsync"));
        this.destroyIfIdle();
      }
    });
  }

  // Waits for running generations before releasing the native object.
  free(): void {
    this.freeRequested = true;
    this.destroyIfIdle();
  }

  private destroyIfIdle(): void {
    if (this.freeRequested && this.running === 0 && this.handle !== NULL_HANDLE) {
      sxTtsDestroy(this.handle);
      this.handle = NULL_HANDLE;
    }
  }
}
