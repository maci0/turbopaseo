// Public xterm type names for the native build, bound to the classes that implement them.
// scriptc lays out an interface-typed value as a record and cannot convert these classes to it,
// so Paseo and the vendored addons see the implementation classes instead of upstream's
// interfaces (typings/*.d.ts), which still supply every other public type.
import type { Terminal } from "./upstream/src/headless/public/Terminal";

export type * from "./upstream/typings/xterm-headless";
export type { Terminal };
export type { BufferApiView as IBuffer } from "./upstream/src/common/public/BufferApiView";
export type { BufferNamespaceApi as IBufferNamespace } from "./upstream/src/common/public/BufferNamespaceApi";
export type { BufferLine as IBufferLine } from "./upstream/src/common/buffer/BufferLine";
export type { CellData as IBufferCell } from "./upstream/src/common/buffer/CellData";
export type { ParserApi as IParser } from "./upstream/src/common/public/ParserApi";
export type { UnicodeApi as IUnicodeHandling } from "./upstream/src/common/public/UnicodeApi";

export interface ITerminalAddon {
  activate(terminal: Terminal): void;
  dispose(): void;
}
