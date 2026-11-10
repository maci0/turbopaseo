// Native checks of native/sherpa/sherpa-onnx-ffi.ts on its own: config strictness, create
// failures, use after free(), and that generateAsync leaves the event loop running.
import { OfflineRecognizer, OfflineTts, Vad } from "../../../../../native/sherpa/sherpa-onnx-ffi.js";

const models = process.env.PROOF_MODELS_DIR ?? "";
const kitten = `${models}/kitten-nano-en-v0_2-fp16`;

function attempt(label: string, run: () => void): void {
  try {
    run();
    process.stdout.write(`${label}: no error\n`);
  } catch (error) {
    process.stdout.write(`${label}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
  }
}

attempt("vad unknown key", () => new Vad({ sileroVad: { model: "x", thresholdd: 0.5 } }, 60));
attempt("vad wrong type", () => new Vad({ sampleRate: "16000" }, 60));
attempt("vad boolean", () => new Vad({ debug: false }, 60));
attempt("vad missing model", () => new Vad({ sileroVad: { model: "/nonexistent/vad.onnx" } }, 60));
attempt("vad corrupt model", () => new Vad({ sileroVad: { model: `${models}/kitten-nano-en-v0_2-fp16/tokens.txt` }, sampleRate: 16000 }, 60));
attempt("asr empty object", () => new OfflineRecognizer({ modelConfig: { paraformer: {} } }));
attempt("asr missing files", () =>
  new OfflineRecognizer({ modelConfig: { transducer: { encoder: "/nope/e.onnx", decoder: "/nope/d.onnx", joiner: "/nope/j.onnx" }, tokens: "/nope/t.txt" } }),
);
attempt("vad use after free", () => {
  const vad = new Vad({ sileroVad: { model: process.env.PROOF_VAD_MODEL ?? "" }, sampleRate: 16000 }, 60);
  vad.free();
  vad.isDetected();
});

const tts = new OfflineTts({
  model: {
    kitten: { model: `${kitten}/model.fp16.onnx`, voices: `${kitten}/voices.bin`, tokens: `${kitten}/tokens.txt`, dataDir: `${kitten}/espeak-ng-data` },
    numThreads: 2,
    provider: "cpu",
  },
  maxNumSentences: 1,
});
process.stdout.write(`tts sampleRate=${tts.sampleRate} numSpeakers=${tts.numSpeakers}\n`);
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
}, 10);
const started = Date.now();
const first = tts.generateAsync({ text: "One sentence to speak while the loop keeps going.", sid: 0, speed: 1 });
const second = tts.generateAsync({ text: "A second one, queued behind it.", sid: 0, speed: 1 });
tts.free();
Promise.all([first, second]).then(
  ([a, b]) => {
    clearInterval(timer);
    process.stdout.write(
      `generated ${a.samples.length} and ${b.samples.length} samples at ${a.sampleRate} Hz in ${Date.now() - started} ms; timer ticked ${ticks} times meanwhile\n`,
    );
    return tts.generateAsync({ text: "after free", sid: 0, speed: 1 }).then(
      () => process.stdout.write("generate after free: no error\n"),
      (error: unknown) => process.stdout.write(`generate after free: ${error instanceof Error ? error.message : String(error)}\n`),
    );
  },
  (error: unknown) => {
    clearInterval(timer);
    process.stdout.write(`generate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  },
);
