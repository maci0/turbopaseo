// Native stand-in for the `openai` package: the two audio endpoints Paseo's speech providers
// call (packages/server/src/server/speech/providers/openai/{stt,tts}.ts), over global fetch.
// Native builds select it with a tsconfig `paths` entry for "openai"; Node keeps the SDK.
//
// Kept from SDK 6.44.0: the base URL (option, then OPENAI_BASE_URL, then api.openai.com),
// OPENAI_ORG_ID and OPENAI_PROJECT_ID headers, 2 retries on connection errors, 408, 409,
// 429 and 5xx (x-should-retry, retry-after-ms and retry-after honoured, else 0.5 s doubling
// to 8 s with up to 25% jitter), the 10 minute timeout, and APIError's message format.
// The upload is named audio.<ext> after its leading bytes instead of the stream path.
// Not kept: the SDK's error subclasses, its logging, idempotency and X-Stainless headers,
// OPENAI_CUSTOM_HEADERS, and every other endpoint.
import type { ReadStream } from "node:fs";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;
const MAX_RETRY_JITTER = 0.25;
const MAX_SERVER_RETRY_DELAY_MS = 60 * 1000;

export interface ClientOptions {
  apiKey: string;
  baseURL?: string;
}

export interface TranscriptionCreateParams {
  file: ReadStream;
  model: string;
  language?: string;
  prompt?: string;
  include?: string[];
  response_format?: "json";
}

/** The JSON body of a `json` transcription; Paseo checks the optional fields itself. */
export interface Transcription {
  text: string;
  logprobs?: unknown;
  language?: unknown;
}

export interface SpeechCreateParams {
  model: string;
  voice: string;
  input: string;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export class OpenAIError extends Error {}

export class APIError extends OpenAIError {
  readonly status: number | undefined;

  constructor(status: number | undefined, error: unknown, message: string | undefined) {
    super(makeErrorMessage(status, error, message));
    this.status = status;
  }
}

// APIError.makeMessage of the SDK.
function makeErrorMessage(
  status: number | undefined,
  error: unknown,
  message: string | undefined,
): string {
  let detail: string | undefined = message;
  if (typeof error === "object" && error !== null) {
    const inner: unknown = (error as { message?: unknown }).message;
    if (inner) detail = typeof inner === "string" ? inner : JSON.stringify(inner);
    else detail = JSON.stringify(error);
  } else if (error) {
    detail = JSON.stringify(error);
  }
  if (status && detail) return `${status} ${detail}`;
  if (status) return `${status} status code (no body)`;
  if (detail) return detail;
  return "(no status code or body)";
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(response: Response): boolean {
  const header = response.headers.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  return (
    response.status === 408 ||
    response.status === 409 ||
    response.status === 429 ||
    response.status >= 500
  );
}

function retryDelayMs(retryCount: number, headers: Headers | null): number {
  let delay: number | undefined;
  const afterMs = headers?.get("retry-after-ms");
  if (afterMs) {
    const parsed = Number.parseFloat(afterMs);
    if (!Number.isNaN(parsed)) delay = parsed;
  }
  const after = headers?.get("retry-after");
  if (after && delay === undefined) {
    const seconds = Number.parseFloat(after);
    delay = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
  }
  if (delay !== undefined && delay >= 0 && delay < MAX_SERVER_RETRY_DELAY_MS) return delay;
  const seconds = Math.min(INITIAL_RETRY_DELAY_S * 2 ** retryCount, MAX_RETRY_DELAY_S);
  return seconds * (1 - Math.random() * MAX_RETRY_JITTER) * 1000;
}

function readStreamBytes(stream: ReadStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("error", (error: Error) => reject(error));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// The SDK names the upload after the stream's path, and OpenAI reads the audio format from
// that extension. scriptc's ReadStream has no `path`, so the name comes from the bytes.
function audioFilename(bytes: Buffer): string {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio.wav";
  if (ascii(0, 4) === "OggS") return "audio.ogg";
  if (ascii(0, 4) === "fLaC") return "audio.flac";
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return "audio.webm";
  if (ascii(4, 8) === "ftyp") return "audio.mp4";
  if (
    ascii(0, 3) === "ID3" ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
    return "audio.mp3";
  return "audio";
}

interface MultipartField {
  name: string;
  value: string;
}

function encodeMultipart(
  boundary: string,
  fields: MultipartField[],
  file: { name: string; filename: string; bytes: Buffer },
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename.replace(/["\r\n]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

interface PostRequest {
  path: string;
  accept: string;
  contentType: string;
  body: Buffer;
}

class Client {
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL || readEnv("OPENAI_BASE_URL") || DEFAULT_BASE_URL;
  }

  async post(request: PostRequest): Promise<Response> {
    const url = `${this.baseURL.replace(/\/+$/, "")}${request.path}`;
    const headers: Record<string, string> = {
      Accept: request.accept,
      "Content-Type": request.contentType,
      Authorization: `Bearer ${this.apiKey}`,
    };
    const organization = readEnv("OPENAI_ORG_ID");
    if (organization) headers["OpenAI-Organization"] = organization;
    const project = readEnv("OPENAI_PROJECT_ID");
    if (project) headers["OpenAI-Project"] = project;

    for (let retryCount = 0; ; retryCount += 1) {
      const retriesRemaining = MAX_RETRIES - retryCount;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          // A copy typed Uint8Array<ArrayBuffer>: DOM BodyInit does not take Buffer<ArrayBufferLike>.
          body: new Uint8Array(request.body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (retriesRemaining > 0) {
          await sleep(retryDelayMs(retryCount, null));
          continue;
        }
        const message = controller.signal.aborted ? "Request timed out." : "Connection error.";
        throw new APIError(undefined, undefined, `${message} ${String(error)}`);
      }
      clearTimeout(timer);
      if (response.ok) return response;
      if (retriesRemaining > 0 && shouldRetry(response)) {
        await sleep(retryDelayMs(retryCount, response.headers));
        continue;
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const error =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { error?: unknown }).error
          : undefined;
      throw new APIError(response.status, error, parsed === undefined ? text : undefined);
    }
  }
}

class Transcriptions {
  constructor(private readonly client: Client) {}

  async create(params: TranscriptionCreateParams): Promise<Transcription> {
    const fields: MultipartField[] = [{ name: "model", value: params.model }];
    if (params.language !== undefined) fields.push({ name: "language", value: params.language });
    if (params.prompt !== undefined) fields.push({ name: "prompt", value: params.prompt });
    for (const entry of params.include ?? []) fields.push({ name: "include[]", value: entry });
    if (params.response_format !== undefined)
      fields.push({ name: "response_format", value: params.response_format });
    const bytes = await readStreamBytes(params.file);
    const boundary = `----paseo-${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const response = await this.client.post({
      path: "/audio/transcriptions",
      accept: "application/json",
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: encodeMultipart(boundary, fields, {
        name: "file",
        filename: audioFilename(bytes),
        bytes,
      }),
    });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      throw new OpenAIError("Unexpected transcription response");
    }
    const record = body as { text?: unknown; logprobs?: unknown; language?: unknown };
    if (typeof record.text !== "string") {
      throw new OpenAIError("Unexpected transcription response");
    }
    return { text: record.text, logprobs: record.logprobs, language: record.language };
  }
}

class Speech {
  constructor(private readonly client: Client) {}

  create(params: SpeechCreateParams): Promise<Response> {
    return this.client.post({
      path: "/audio/speech",
      accept: "application/octet-stream",
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(params)),
    });
  }
}

class Audio {
  readonly transcriptions: Transcriptions;
  readonly speech: Speech;

  constructor(client: Client) {
    this.transcriptions = new Transcriptions(client);
    this.speech = new Speech(client);
  }
}

export class OpenAI {
  readonly audio: Audio;

  constructor(options: ClientOptions) {
    this.audio = new Audio(new Client(options));
  }
}

export default OpenAI;
