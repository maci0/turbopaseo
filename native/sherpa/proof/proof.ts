// Drives Paseo's speech worker through LocalSpeechWorkerClient: TTS, then STT and VAD on the
// synthesized audio. Run under Node (real addon) and as a scriptc binary (FFI); compare output.
// Env: PROOF_MODELS_DIR, PROOF_TTS_MODEL, PROOF_STT_MODEL, PROOF_TEXT.
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pino from "pino";
// scriptc 0.4.10 compiles an npm package only when the parent program imports it, not when
// only an embedded fork target does; the speech worker needs these.
import { z } from "zod";
import { spawnProcess } from "@getpaseo/plugin/server";

import { Pcm16MonoResampler } from "../src/server/agent/pcm16-resampler.js";
import type { StreamingTranscriptionCommittedEvent, StreamingTranscriptionEvent } from "../src/server/speech/speech-provider.js";
import { LocalSpeechWorkerClient } from "../src/server/speech/providers/local/worker-client.js";

const VAD_RATE = 16000;
const CHUNK_MS = 100;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  process.stderr.write(`linked ${typeof z.string} ${typeof spawnProcess}\n`);
  const client = new LocalSpeechWorkerClient({
    config: {
      modelsDir: env("PROOF_MODELS_DIR"),
      voiceSttModel: env("PROOF_STT_MODEL"),
      dictationSttModel: env("PROOF_STT_MODEL"),
      voiceTtsModel: env("PROOF_TTS_MODEL"),
    },
    logger: pino({ level: "silent" }),
    requestTimeoutMs: 120000,
  });

  const text = env("PROOF_TEXT");
  const startedTts = Date.now();
  const tts = await client.synthesizeSpeech(text);
  const pcm = await readAll(tts.stream);
  const rate = Number(/rate=(\d+)/.exec(tts.format)?.[1] ?? "0");
  const samples = pcm.byteLength / 2;
  process.stdout.write(
    `tts format=${tts.format} samples=${samples} seconds=${(samples / rate).toFixed(3)} sha256=${sha256(pcm)}\n`,
  );
  process.stderr.write(`tts took ${Date.now() - startedTts} ms\n`);

  // PROOF_AUDIO_FILE: the STT and VAD input. Written from this run's TTS output when missing,
  // otherwise read, so two runs can share one input.
  const audioFile = env("PROOF_AUDIO_FILE");
  if (!existsSync(audioFile)) writeFileSync(audioFile, pcm);
  const input = readFileSync(audioFile);
  process.stdout.write(`input sha256=${sha256(input)} samples=${input.byteLength / 2}\n`);
  const stt = await client.transcribeVoice(input, `audio/pcm;rate=${rate}`);
  process.stdout.write(`stt text=${JSON.stringify(stt.text)} lowConfidence=${String(stt.isLowConfidence ?? false)}\n`);

  // VAD: 1 s silence, the speech at 16 kHz, 2 s silence, in 100 ms chunks.
  const speech16k = new Pcm16MonoResampler({ inputRate: rate, outputRate: VAD_RATE }).processChunk(input);
  const audio = Buffer.concat([Buffer.alloc(VAD_RATE * 2), speech16k, Buffer.alloc(VAD_RATE * 4)]);
  const chunkBytes = (VAD_RATE * CHUNK_MS * 2) / 1000;
  const vad = new EventEmitter();
  const events: string[] = [];
  let chunkIndex = 0;
  vad.on("speech_started", () => events.push(`started@chunk${chunkIndex}`));
  vad.on("speech_stopped", () => events.push(`stopped@chunk${chunkIndex}`));
  vad.on("error", (err: Error) => events.push(`error ${err.message}`));
  const session = await client.createSession("vad", vad);
  for (let offset = 0; offset < audio.byteLength; offset += chunkBytes) {
    client.appendSessionAudio(session.sessionId, audio.subarray(offset, offset + chunkBytes));
    chunkIndex += 1;
    // Let each append reach the worker and its events come back before the next chunk.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  client.flushSession(session.sessionId);
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  process.stdout.write(
    `vad speech16k=${speech16k.byteLength / 2} chunks=${chunkIndex} events=${events.join(",")}\n`,
  );
  client.closeSession(session.sessionId);

  // Dictation: the realtime session re-decodes its growing buffer; commit yields a final transcript.
  const dictation = new EventEmitter();
  const finals: string[] = [];
  let partials = 0;
  dictation.on("transcript", (event: StreamingTranscriptionEvent) => {
    if (event.isFinal) finals.push(event.transcript);
    else partials += 1;
  });
  dictation.on("error", (err: Error) => finals.push(`error ${err.message}`));
  dictation.on("committed", (event: StreamingTranscriptionCommittedEvent) => process.stderr.write(`committed ${event.segmentId}\n`));
  const dictationSession = await client.createSession("dictationStt", dictation);
  for (let offset = 0; offset < speech16k.byteLength; offset += chunkBytes) {
    client.appendSessionAudio(dictationSession.sessionId, speech16k.subarray(offset, offset + chunkBytes));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  client.commitSession(dictationSession.sessionId);
  for (let waited = 0; finals.length === 0 && waited < 100; waited += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write(`dictation final=${JSON.stringify(finals)}\n`);
  process.stderr.write(`dictation partials=${partials}\n`);
  client.closeSession(dictationSession.sessionId);
  client.shutdown();
}

main().catch((error: unknown) => {
  process.stdout.write(`proof failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
