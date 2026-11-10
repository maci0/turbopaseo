// Speech worker entry for scriptc builds. The build copies it to packages/server/native/, beside
// the daemon's native entry; worker-client.ts forks it from there. scriptc cannot load the
// sherpa-onnx-node addon, so this registers the FFI module with the addon's classes before
// worker-process.ts creates any. worker-process.ts only installs message handlers when it is
// evaluated (ahead of this module's body, as an import), and loads sherpa on the first request.
import * as sherpaOnnxFfi from "../../../../../native/sherpa/sherpa-onnx-ffi.js";
import { registerSherpaOnnxNode } from "../src/server/speech/providers/local/sherpa/sherpa-onnx-node-loader.js";
import "../src/server/speech/providers/local/worker-process.js";

registerSherpaOnnxNode(sherpaOnnxFfi);
