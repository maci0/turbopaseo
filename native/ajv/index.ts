// `ajv` in the native daemon. ajv builds validators with `new Function`, which a native
// binary cannot run. The MCP SDK imports it at module load (validation/ajv-provider.js) and
// constructs it only when no jsonSchemaValidator is passed; native builds always pass
// Paseo's interpreting validator (json-schema-validator.ts), so constructing this throws.
export default class Ajv {
  constructor() {
    throw new Error("ajv is not available in the native build; pass a jsonSchemaValidator");
  }
}

export { Ajv };
