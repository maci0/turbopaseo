// Fixed-signature wrappers over sherpa-onnx's C API (v1.12.28) for scriptc FFI.
//
// scriptc passes strings and byte spans as (pointer, length) pairs that are
// borrowed for the call and not NUL-terminated, cannot pass structs, and cannot
// return strings or byte spans. So configs are built field by field through a
// keyed builder, objects cross as opaque `pointer` handles, and results are
// copied into caller-owned `mutable-bytes` buffers.
//
// Every exported function catches all C++ exceptions: scriptc forbids unwinding
// across the FFI boundary. A caught exception becomes the function's error
// result, and its message is kept for sx_last_error.
//
// Float32 sample spans arrive as raw bytes (a Uint8Array view over a
// Float32Array). A trailing partial float is ignored.

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <deque>
#include <exception>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "sherpa-onnx/c-api/c-api.h"

namespace {

thread_local std::string last_error;

void set_error(const char *what) { last_error = what ? what : "unknown error"; }

void set_error_from_current_exception() {
  try {
    throw;
  } catch (const std::exception &e) {
    set_error(e.what());
  } catch (...) {
    set_error("non-standard C++ exception");
  }
}

// Copies at most out_bytes of s into out and returns the full length, so a
// caller with a short buffer can retry with the returned size.
int32_t copy_out(const std::string &s, uint8_t *out, size_t out_bytes) {
  size_t n = s.size() < out_bytes ? s.size() : out_bytes;
  if (n) std::memcpy(out, s.data(), n);
  return static_cast<int32_t>(s.size());
}

// The sherpa API takes const float *. A byte view need not be 4-byte aligned,
// so copy into scratch storage unless it already is.
const float *as_floats(const uint8_t *p, size_t n_bytes, std::vector<float> &scratch) {
  if (reinterpret_cast<uintptr_t>(p) % alignof(float) == 0) {
    return reinterpret_cast<const float *>(p);
  }
  scratch.resize(n_bytes / sizeof(float));
  if (!scratch.empty()) std::memcpy(scratch.data(), p, scratch.size() * sizeof(float));
  return scratch.data();
}

int32_t float_count(size_t n_bytes) { return static_cast<int32_t>(n_bytes / sizeof(float)); }

// ------------------------------------------------------------ config builder

enum class ConfigKind : int32_t { kVad = 1, kOfflineRecognizer = 2, kOfflineTts = 3 };

// kIgnored accepts a key the addon also accepts and drops (kokoro dictDir:
// non-streaming-tts.cc never reads it, and c-api.h marks dict_dir unused).
enum class FieldType { kString, kInt32, kFloat, kIgnored };

struct Field {
  const char *key;
  FieldType type;
  size_t offset;
};

// Keys are the addon's JavaScript paths. The tables hold the fields Paseo sets
// (native/sherpa/INVENTORY.md); any other key is an error.
#define SX_FIELD(Struct, key, type, member) {key, FieldType::type, offsetof(Struct, member)}

const Field kVadFields[] = {
    SX_FIELD(SherpaOnnxVadModelConfig, "sileroVad.model", kString, silero_vad.model),
    SX_FIELD(SherpaOnnxVadModelConfig, "sileroVad.threshold", kFloat, silero_vad.threshold),
    SX_FIELD(SherpaOnnxVadModelConfig, "sileroVad.minSilenceDuration", kFloat,
             silero_vad.min_silence_duration),
    SX_FIELD(SherpaOnnxVadModelConfig, "sileroVad.minSpeechDuration", kFloat,
             silero_vad.min_speech_duration),
    SX_FIELD(SherpaOnnxVadModelConfig, "sileroVad.windowSize", kInt32, silero_vad.window_size),
    SX_FIELD(SherpaOnnxVadModelConfig, "sampleRate", kInt32, sample_rate),
    SX_FIELD(SherpaOnnxVadModelConfig, "numThreads", kInt32, num_threads),
    SX_FIELD(SherpaOnnxVadModelConfig, "provider", kString, provider),
    SX_FIELD(SherpaOnnxVadModelConfig, "debug", kInt32, debug),
};

#define SX_ASR(key, type, member) SX_FIELD(SherpaOnnxOfflineRecognizerConfig, key, type, member)

const Field kOfflineRecognizerFields[] = {
    SX_ASR("featConfig.sampleRate", kInt32, feat_config.sample_rate),
    SX_ASR("featConfig.featureDim", kInt32, feat_config.feature_dim),
    SX_ASR("modelConfig.transducer.encoder", kString, model_config.transducer.encoder),
    SX_ASR("modelConfig.transducer.decoder", kString, model_config.transducer.decoder),
    SX_ASR("modelConfig.transducer.joiner", kString, model_config.transducer.joiner),
    SX_ASR("modelConfig.whisper.encoder", kString, model_config.whisper.encoder),
    SX_ASR("modelConfig.whisper.decoder", kString, model_config.whisper.decoder),
    SX_ASR("modelConfig.whisper.language", kString, model_config.whisper.language),
    SX_ASR("modelConfig.whisper.task", kString, model_config.whisper.task),
    SX_ASR("modelConfig.senseVoice.model", kString, model_config.sense_voice.model),
    SX_ASR("modelConfig.senseVoice.language", kString, model_config.sense_voice.language),
    SX_ASR("modelConfig.senseVoice.useInverseTextNormalization", kInt32,
           model_config.sense_voice.use_itn),
    SX_ASR("modelConfig.dolphin.model", kString, model_config.dolphin.model),
    SX_ASR("modelConfig.nemoCtc.model", kString, model_config.nemo_ctc.model),
    SX_ASR("modelConfig.tokens", kString, model_config.tokens),
    SX_ASR("modelConfig.numThreads", kInt32, model_config.num_threads),
    SX_ASR("modelConfig.provider", kString, model_config.provider),
    SX_ASR("modelConfig.debug", kInt32, model_config.debug),
    SX_ASR("modelConfig.modelType", kString, model_config.model_type),
    SX_ASR("decodingMethod", kString, decoding_method),
    SX_ASR("maxActivePaths", kInt32, max_active_paths),
};

#define SX_TTS(key, type, member) SX_FIELD(SherpaOnnxOfflineTtsConfig, key, type, member)

const Field kOfflineTtsFields[] = {
    SX_TTS("model.numThreads", kInt32, model.num_threads),
    SX_TTS("model.provider", kString, model.provider),
    SX_TTS("model.debug", kInt32, model.debug),
    SX_TTS("model.kokoro.model", kString, model.kokoro.model),
    SX_TTS("model.kokoro.voices", kString, model.kokoro.voices),
    SX_TTS("model.kokoro.tokens", kString, model.kokoro.tokens),
    SX_TTS("model.kokoro.dataDir", kString, model.kokoro.data_dir),
    SX_TTS("model.kokoro.lexicon", kString, model.kokoro.lexicon),
    SX_TTS("model.kokoro.lengthScale", kFloat, model.kokoro.length_scale),
    SX_TTS("model.kokoro.dictDir", kIgnored, model.kokoro.dict_dir),
    SX_TTS("model.kitten.model", kString, model.kitten.model),
    SX_TTS("model.kitten.voices", kString, model.kitten.voices),
    SX_TTS("model.kitten.tokens", kString, model.kitten.tokens),
    SX_TTS("model.kitten.dataDir", kString, model.kitten.data_dir),
    SX_TTS("model.kitten.lengthScale", kFloat, model.kitten.length_scale),
    SX_TTS("model.vits.model", kString, model.vits.model),
    SX_TTS("model.vits.tokens", kString, model.vits.tokens),
    SX_TTS("model.vits.dataDir", kString, model.vits.data_dir),
    SX_TTS("model.vits.lengthScale", kFloat, model.vits.length_scale),
    SX_TTS("maxNumSentences", kInt32, max_num_sentences),
    SX_TTS("ruleFsts", kString, rule_fsts),
};

#undef SX_TTS
#undef SX_ASR
#undef SX_FIELD

struct Config {
  ConfigKind kind;
  // Zero-filled: unset fields take the C layer's defaults (c-api.cc
  // SHERPA_ONNX_OR), as they do when the addon leaves a key out.
  SherpaOnnxVadModelConfig vad;
  SherpaOnnxOfflineRecognizerConfig asr;
  SherpaOnnxOfflineTtsConfig tts;
  // Owns the strings the structs point into; deque growth keeps them in place.
  std::deque<std::string> strings;

  explicit Config(ConfigKind k) : kind(k) {
    std::memset(&vad, 0, sizeof(vad));
    std::memset(&asr, 0, sizeof(asr));
    std::memset(&tts, 0, sizeof(tts));
  }

  char *base() {
    switch (kind) {
      case ConfigKind::kVad:
        return reinterpret_cast<char *>(&vad);
      case ConfigKind::kOfflineRecognizer:
        return reinterpret_cast<char *>(&asr);
      case ConfigKind::kOfflineTts:
        return reinterpret_cast<char *>(&tts);
    }
    return nullptr;
  }

  const Field *find(const std::string &key) const {
    const Field *begin = nullptr;
    size_t n = 0;
    switch (kind) {
      case ConfigKind::kVad:
        begin = kVadFields;
        n = sizeof(kVadFields) / sizeof(kVadFields[0]);
        break;
      case ConfigKind::kOfflineRecognizer:
        begin = kOfflineRecognizerFields;
        n = sizeof(kOfflineRecognizerFields) / sizeof(kOfflineRecognizerFields[0]);
        break;
      case ConfigKind::kOfflineTts:
        begin = kOfflineTtsFields;
        n = sizeof(kOfflineTtsFields) / sizeof(kOfflineTtsFields[0]);
        break;
    }
    for (size_t i = 0; i < n; ++i) {
      if (key == begin[i].key) return &begin[i];
    }
    return nullptr;
  }
};

// Results of sx_config_set_*.
constexpr int32_t kSetOk = 0;
constexpr int32_t kSetUnknownKey = 1;
constexpr int32_t kSetWrongType = 2;
constexpr int32_t kSetFailed = -1;

Config *as_config(void *cfg, ConfigKind kind) {
  Config *c = static_cast<Config *>(cfg);
  if (!c || c->kind != kind) {
    set_error("config handle has the wrong kind");
    return nullptr;
  }
  return c;
}

// ------------------------------------------------------------- TTS jobs

// A generation runs on its own thread. Its completion callback is the scriptc
// foreign-thread trampoline, which only copies the two integers and posts them
// to the script's event loop.
typedef void (*TtsDoneCallback)(int32_t job, int32_t status, void *context);

constexpr int32_t kTtsDone = 0;
constexpr int32_t kTtsNoAudio = 1;
constexpr int32_t kTtsException = 2;

struct Tts {
  const SherpaOnnxOfflineTts *tts;
  // Held for the whole of a generation; sx_tts_destroy takes it too, so the
  // handle never goes away under a running generation and generations on one
  // handle never overlap (the native object is not reentrant).
  std::mutex busy;
};

struct TtsJob {
  const SherpaOnnxGeneratedAudio *audio = nullptr;
  std::string error;
};

std::mutex jobs_mutex;
std::unordered_map<int32_t, TtsJob> jobs;
int32_t next_job_id = 1;

// The addon generates through the progress-callback entry point with a
// callback that keeps going (non-streaming-tts.cc TtsGenerateWorker::Execute);
// the same entry point is used here so the audio is produced the same way.
int32_t keep_generating(const float *, int32_t, float, void *) { return 1; }

void run_tts_job(Tts *handle, int32_t job, std::string text, int32_t sid, float speed,
                 TtsDoneCallback done, void *context) {
  int32_t status = kTtsDone;
  std::string error;
  const SherpaOnnxGeneratedAudio *audio = nullptr;
  try {
    std::lock_guard<std::mutex> lock(handle->busy);
    audio = SherpaOnnxOfflineTtsGenerateWithProgressCallbackWithArg(
        handle->tts, text.c_str(), sid, speed, keep_generating, nullptr);
    if (!audio) status = kTtsNoAudio;
  } catch (const std::exception &e) {
    status = kTtsException;
    error = e.what();
  } catch (...) {
    status = kTtsException;
    error = "non-standard C++ exception";
  }
  {
    std::lock_guard<std::mutex> lock(jobs_mutex);
    TtsJob &entry = jobs[job];
    entry.audio = audio;
    entry.error = std::move(error);
  }
  done(job, status, context);
}

const SherpaOnnxGeneratedAudio *job_audio(int32_t job) {
  std::lock_guard<std::mutex> lock(jobs_mutex);
  auto it = jobs.find(job);
  return it == jobs.end() ? nullptr : it->second.audio;
}

}  // namespace

extern "C" {

// Copies the message of the last failure on this thread into out and returns
// its full length.
int32_t sx_last_error(uint8_t *out, size_t out_bytes) {
  try {
    return copy_out(last_error, out, out_bytes);
  } catch (...) {
    return 0;
  }
}

// ------------------------------------------------------------ config builder

void *sx_config_new(int32_t kind) {
  try {
    if (kind < static_cast<int32_t>(ConfigKind::kVad) ||
        kind > static_cast<int32_t>(ConfigKind::kOfflineTts)) {
      set_error("unknown config kind");
      return nullptr;
    }
    return new Config(static_cast<ConfigKind>(kind));
  } catch (...) {
    set_error_from_current_exception();
    return nullptr;
  }
}

void sx_config_free(void *cfg) { delete static_cast<Config *>(cfg); }

int32_t sx_config_set_string(void *cfg, const uint8_t *key, size_t key_len, const uint8_t *value,
                             size_t value_len) {
  try {
    Config *c = static_cast<Config *>(cfg);
    const Field *f = c->find(std::string(reinterpret_cast<const char *>(key), key_len));
    if (!f) return kSetUnknownKey;
    if (f->type == FieldType::kIgnored) return kSetOk;
    if (f->type != FieldType::kString) return kSetWrongType;
    c->strings.emplace_back(reinterpret_cast<const char *>(value), value_len);
    const char *s = c->strings.back().c_str();
    std::memcpy(c->base() + f->offset, &s, sizeof(s));
    return kSetOk;
  } catch (...) {
    set_error_from_current_exception();
    return kSetFailed;
  }
}

// Integer fields receive the value truncated toward zero, which is what the
// addon's Int32Value gives for every value in int32 range.
int32_t sx_config_set_number(void *cfg, const uint8_t *key, size_t key_len, double value) {
  try {
    Config *c = static_cast<Config *>(cfg);
    const Field *f = c->find(std::string(reinterpret_cast<const char *>(key), key_len));
    if (!f) return kSetUnknownKey;
    char *dst = c->base() + f->offset;
    switch (f->type) {
      case FieldType::kInt32: {
        int32_t v = static_cast<int32_t>(value);
        std::memcpy(dst, &v, sizeof(v));
        return kSetOk;
      }
      case FieldType::kFloat: {
        float v = static_cast<float>(value);
        std::memcpy(dst, &v, sizeof(v));
        return kSetOk;
      }
      case FieldType::kIgnored:
        return kSetOk;
      case FieldType::kString:
        return kSetWrongType;
    }
    return kSetWrongType;
  } catch (...) {
    set_error_from_current_exception();
    return kSetFailed;
  }
}

// ---------------------------------------------------------------- VAD

void *sx_vad_create(void *cfg, double buffer_size_in_seconds) {
  try {
    Config *c = as_config(cfg, ConfigKind::kVad);
    if (!c) return nullptr;
    const SherpaOnnxVoiceActivityDetector *vad =
        SherpaOnnxCreateVoiceActivityDetector(&c->vad, static_cast<float>(buffer_size_in_seconds));
    if (!vad) set_error("SherpaOnnxCreateVoiceActivityDetector failed (see stderr)");
    return const_cast<SherpaOnnxVoiceActivityDetector *>(vad);
  } catch (...) {
    set_error_from_current_exception();
    return nullptr;
  }
}

void sx_vad_destroy(void *vad) {
  try {
    SherpaOnnxDestroyVoiceActivityDetector(static_cast<SherpaOnnxVoiceActivityDetector *>(vad));
  } catch (...) {
    set_error_from_current_exception();
  }
}

// Returns 0 on success, -1 on failure.
int32_t sx_vad_accept_waveform(void *vad, const uint8_t *samples, size_t n_bytes) {
  try {
    std::vector<float> scratch;
    SherpaOnnxVoiceActivityDetectorAcceptWaveform(
        static_cast<SherpaOnnxVoiceActivityDetector *>(vad), as_floats(samples, n_bytes, scratch),
        float_count(n_bytes));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// 1 or 0, or -1 on failure.
int32_t sx_vad_is_detected(void *vad) {
  try {
    return SherpaOnnxVoiceActivityDetectorDetected(
               static_cast<SherpaOnnxVoiceActivityDetector *>(vad)) != 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_vad_is_empty(void *vad) {
  try {
    return SherpaOnnxVoiceActivityDetectorEmpty(
               static_cast<SherpaOnnxVoiceActivityDetector *>(vad)) != 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_vad_flush(void *vad) {
  try {
    SherpaOnnxVoiceActivityDetectorFlush(static_cast<SherpaOnnxVoiceActivityDetector *>(vad));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_vad_reset(void *vad) {
  try {
    SherpaOnnxVoiceActivityDetectorReset(static_cast<SherpaOnnxVoiceActivityDetector *>(vad));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// ------------------------------------------------------- CircularBuffer

void *sx_cb_create(int32_t capacity) {
  try {
    return const_cast<SherpaOnnxCircularBuffer *>(SherpaOnnxCreateCircularBuffer(capacity));
  } catch (...) {
    set_error_from_current_exception();
    return nullptr;
  }
}

void sx_cb_destroy(void *cb) {
  try {
    SherpaOnnxDestroyCircularBuffer(static_cast<SherpaOnnxCircularBuffer *>(cb));
  } catch (...) {
    set_error_from_current_exception();
  }
}

int32_t sx_cb_push(void *cb, const uint8_t *samples, size_t n_bytes) {
  try {
    std::vector<float> scratch;
    SherpaOnnxCircularBufferPush(static_cast<SherpaOnnxCircularBuffer *>(cb),
                                 as_floats(samples, n_bytes, scratch), float_count(n_bytes));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// Copies n samples starting at start_index into out. Returns n, or -1 when out
// is smaller than n samples or the call failed.
int32_t sx_cb_get(void *cb, int32_t start_index, int32_t n, uint8_t *out, size_t out_bytes) {
  try {
    if (n < 0 || static_cast<size_t>(n) * sizeof(float) > out_bytes) {
      set_error("output buffer smaller than the requested sample count");
      return -1;
    }
    const float *p =
        SherpaOnnxCircularBufferGet(static_cast<SherpaOnnxCircularBuffer *>(cb), start_index, n);
    if (!p) {
      set_error("SherpaOnnxCircularBufferGet returned no data");
      return -1;
    }
    std::memcpy(out, p, static_cast<size_t>(n) * sizeof(float));
    SherpaOnnxCircularBufferFree(p);
    return n;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_cb_pop(void *cb, int32_t n) {
  try {
    SherpaOnnxCircularBufferPop(static_cast<SherpaOnnxCircularBuffer *>(cb), n);
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_cb_size(void *cb) {
  try {
    return SherpaOnnxCircularBufferSize(static_cast<SherpaOnnxCircularBuffer *>(cb));
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_cb_head(void *cb) {
  try {
    return SherpaOnnxCircularBufferHead(static_cast<SherpaOnnxCircularBuffer *>(cb));
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_cb_reset(void *cb) {
  try {
    SherpaOnnxCircularBufferReset(static_cast<SherpaOnnxCircularBuffer *>(cb));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// ------------------------------------------------ OfflineRecognizer (STT)

void *sx_asr_create(void *cfg) {
  try {
    Config *c = as_config(cfg, ConfigKind::kOfflineRecognizer);
    if (!c) return nullptr;
    const SherpaOnnxOfflineRecognizer *rec = SherpaOnnxCreateOfflineRecognizer(&c->asr);
    if (!rec) set_error("SherpaOnnxCreateOfflineRecognizer failed (see stderr)");
    return const_cast<SherpaOnnxOfflineRecognizer *>(rec);
  } catch (...) {
    set_error_from_current_exception();
    return nullptr;
  }
}

void sx_asr_destroy(void *rec) {
  try {
    SherpaOnnxDestroyOfflineRecognizer(static_cast<SherpaOnnxOfflineRecognizer *>(rec));
  } catch (...) {
    set_error_from_current_exception();
  }
}

void *sx_asr_stream_create(void *rec) {
  try {
    const SherpaOnnxOfflineStream *s =
        SherpaOnnxCreateOfflineStream(static_cast<SherpaOnnxOfflineRecognizer *>(rec));
    if (!s) set_error("SherpaOnnxCreateOfflineStream failed");
    return const_cast<SherpaOnnxOfflineStream *>(s);
  } catch (...) {
    set_error_from_current_exception();
    return nullptr;
  }
}

void sx_asr_stream_destroy(void *stream) {
  try {
    SherpaOnnxDestroyOfflineStream(static_cast<SherpaOnnxOfflineStream *>(stream));
  } catch (...) {
    set_error_from_current_exception();
  }
}

int32_t sx_asr_accept_waveform(void *stream, int32_t sample_rate, const uint8_t *samples,
                               size_t n_bytes) {
  try {
    std::vector<float> scratch;
    SherpaOnnxAcceptWaveformOffline(static_cast<SherpaOnnxOfflineStream *>(stream), sample_rate,
                                    as_floats(samples, n_bytes, scratch), float_count(n_bytes));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_asr_decode(void *rec, void *stream) {
  try {
    SherpaOnnxDecodeOfflineStream(static_cast<SherpaOnnxOfflineRecognizer *>(rec),
                                  static_cast<SherpaOnnxOfflineStream *>(stream));
    return 0;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// Copies the result JSON (what the addon's getResult parses) into out and
// returns its full length, or -1 on failure.
int32_t sx_asr_result_json(void *stream, uint8_t *out, size_t out_bytes) {
  try {
    const char *json =
        SherpaOnnxGetOfflineStreamResultAsJson(static_cast<SherpaOnnxOfflineStream *>(stream));
    if (!json) {
      set_error("SherpaOnnxGetOfflineStreamResultAsJson returned null");
      return -1;
    }
    std::string s(json);
    SherpaOnnxDestroyOfflineStreamResultJson(json);
    return copy_out(s, out, out_bytes);
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// ------------------------------------------------------- OfflineTts (TTS)

void *sx_tts_create(void *cfg) {
  try {
    Config *c = as_config(cfg, ConfigKind::kOfflineTts);
    if (!c) return nullptr;
    const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&c->tts);
    if (!tts) {
      set_error("SherpaOnnxCreateOfflineTts failed (see stderr)");
      return nullptr;
    }
    Tts *handle = new Tts;
    handle->tts = tts;
    return handle;
  } catch (...) {
    set_error_from_current_exception();
    return nullptr;
  }
}

// Waits for a running generation on this handle to finish.
void sx_tts_destroy(void *tts) {
  try {
    Tts *handle = static_cast<Tts *>(tts);
    if (!handle) return;
    {
      std::lock_guard<std::mutex> lock(handle->busy);
      SherpaOnnxDestroyOfflineTts(handle->tts);
    }
    delete handle;
  } catch (...) {
    set_error_from_current_exception();
  }
}

int32_t sx_tts_sample_rate(void *tts) {
  try {
    return SherpaOnnxOfflineTtsSampleRate(static_cast<Tts *>(tts)->tts);
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_tts_num_speakers(void *tts) {
  try {
    return SherpaOnnxOfflineTtsNumSpeakers(static_cast<Tts *>(tts)->tts);
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// Starts a generation on a new thread and returns its job id (> 0), or -1 if
// the thread could not start; `done` then never fires. Otherwise `done(job,
// status, context)` fires exactly once from that thread, with status 0
// (audio ready), 1 (no audio) or 2 (exception, message in sx_tts_job_error).
int32_t sx_tts_generate_start(void *tts, const uint8_t *text, size_t text_len, int32_t sid,
                              double speed, TtsDoneCallback done, void *context) {
  int32_t job = -1;
  try {
    {
      std::lock_guard<std::mutex> lock(jobs_mutex);
      job = next_job_id++;
      jobs.emplace(job, TtsJob{});
    }
    std::thread(run_tts_job, static_cast<Tts *>(tts), job,
                std::string(reinterpret_cast<const char *>(text), text_len), sid,
                static_cast<float>(speed), done, context)
        .detach();
    return job;
  } catch (...) {
    set_error_from_current_exception();
    if (job > 0) {
      std::lock_guard<std::mutex> lock(jobs_mutex);
      jobs.erase(job);
    }
    return -1;
  }
}

// Paired release for the `done` registration; scriptc unpins the closure after
// this returns. The generation thread has already made its single call.
void sx_tts_generate_release(TtsDoneCallback, void *) {}

int32_t sx_tts_job_length(int32_t job) {
  try {
    const SherpaOnnxGeneratedAudio *audio = job_audio(job);
    return audio ? audio->n : -1;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_tts_job_sample_rate(int32_t job) {
  try {
    const SherpaOnnxGeneratedAudio *audio = job_audio(job);
    return audio ? audio->sample_rate : -1;
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

// Copies min(samples, capacity) samples into out and returns the number copied,
// or -1 when the job has no audio.
int32_t sx_tts_job_copy(int32_t job, uint8_t *out, size_t out_bytes) {
  try {
    const SherpaOnnxGeneratedAudio *audio = job_audio(job);
    if (!audio) return -1;
    size_t cap = out_bytes / sizeof(float);
    size_t n = static_cast<size_t>(audio->n) < cap ? static_cast<size_t>(audio->n) : cap;
    if (n) std::memcpy(out, audio->samples, n * sizeof(float));
    return static_cast<int32_t>(n);
  } catch (...) {
    set_error_from_current_exception();
    return -1;
  }
}

int32_t sx_tts_job_error(int32_t job, uint8_t *out, size_t out_bytes) {
  try {
    std::string error;
    {
      std::lock_guard<std::mutex> lock(jobs_mutex);
      auto it = jobs.find(job);
      if (it != jobs.end()) error = it->second.error;
    }
    return copy_out(error, out, out_bytes);
  } catch (...) {
    return 0;
  }
}

// Frees the job's audio. Call once, after its `done` has been delivered.
void sx_tts_job_release(int32_t job) {
  try {
    const SherpaOnnxGeneratedAudio *audio = nullptr;
    {
      std::lock_guard<std::mutex> lock(jobs_mutex);
      auto it = jobs.find(job);
      if (it == jobs.end()) return;
      audio = it->second.audio;
      jobs.erase(it);
    }
    if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  } catch (...) {
    set_error_from_current_exception();
  }
}

}  // extern "C"
