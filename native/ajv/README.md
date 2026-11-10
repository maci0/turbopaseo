# ajv

`ajv` and `ajv-formats` in the native daemon. The MCP SDK imports both at module load
(`validation/ajv-provider.js`) and constructs ajv only when no `jsonSchemaValidator` is
passed. Native builds pass `interpretingMcpJsonSchemaValidator` from
`packages/server/src/server/agent/json-schema-validator.ts` to every MCP server and client
Paseo creates, so constructing either stand-in throws. Its results equal the SDK's ajv
validator's for the cases in `json-schema-validator.test.ts`.
