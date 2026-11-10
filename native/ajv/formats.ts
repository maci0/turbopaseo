// `ajv-formats` in the native daemon; see index.ts. Only called on an ajv instance, which a
// native build never creates.
export default function addFormats(): never {
  throw new Error("ajv-formats is not available in the native build");
}
