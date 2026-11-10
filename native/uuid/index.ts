// Native stand-in for the `uuid` package, which throws at load in a scriptc
// binary. Paseo only uses `v4`. crypto.randomUUID() returns an RFC 4122
// version 4 UUID, the same kind of value.
import { randomUUID } from "node:crypto";

export function v4(): string {
  return randomUUID();
}
