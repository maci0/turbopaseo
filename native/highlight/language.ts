// Native stand-in for `@codemirror/language` 6.12.4: the part `@getpaseo/highlight` reaches.
// The real package imports `@codemirror/view` and `@codemirror/state` at load, and scriptc
// 0.4.10 fails on both with SC9001 internal errors. A server needs no editor: `Language`
// only carries a Lezer parser here, and `StreamLanguage` ports the real stream parser with
// the editor-context branches removed (no `ParseContext` exists outside an editor view).
import {
  NodeProp,
  NodeSet,
  NodeType,
  Parser,
  Tree,
  type Input,
  type PartialParse,
  type SyntaxNode,
  type TreeFragment,
} from "@lezer/common";
import type { LRParser } from "@lezer/lr";
import { styleTags, tags, type Tag } from "@lezer/highlight";

export type LanguageDataValue = Record<string, unknown>;

/** Stands in for the language-data `Facet`; only editors read it. */
export class LanguageFacet {
  constructor(readonly baseData: LanguageDataValue | undefined) {}
}

export function defineLanguageFacet(baseData?: LanguageDataValue): LanguageFacet {
  return new LanguageFacet(baseData);
}

export const languageDataProp = new NodeProp<LanguageFacet>();
export const indentNodeProp = new NodeProp<IndentStrategy>();
export const foldNodeProp = new NodeProp<FoldStrategy>();

/** The editor's indentation context. No native code builds one. */
export interface TreeIndentContext {
  readonly textAfter: string;
  readonly baseIndent: number;
  readonly unit: number;
}
export type IndentContext = TreeIndentContext;
export type IndentStrategy = (context: TreeIndentContext) => number | null;
export type FoldStrategy = (node: SyntaxNode) => { from: number; to: number } | null;

const NO_INDENTATION = "indentation needs a CodeMirror editor, which the native build does not have";

export function continuedIndent(_options: { except?: RegExp; units?: number } = {}): IndentStrategy {
  return () => {
    throw new Error(NO_INDENTATION);
  };
}

export function delimitedIndent(_options: {
  closing: string;
  align?: boolean;
  units?: number;
}): IndentStrategy {
  return () => {
    throw new Error(NO_INDENTATION);
  };
}

// Reading `SyntaxNode` children here makes scriptc 0.4.10 fail with SC9001 (duplicate
// `TreeNode` functions); folding is an editor feature, so the native build only declares it.
export function foldInside(_node: SyntaxNode): { from: number; to: number } | null {
  throw new Error("folding needs a CodeMirror editor, which the native build does not have");
}

export class Language {
  readonly extension: readonly unknown[] = [];

  constructor(
    readonly data: LanguageFacet,
    public parser: Parser,
    _extraExtensions: readonly unknown[] = [],
    readonly name: string = "",
  ) {}
}

export interface LRLanguageSpec {
  name?: string;
  parser: LRParser;
  languageData?: LanguageDataValue;
}

export class LRLanguage extends Language {
  static define(spec: LRLanguageSpec): LRLanguage {
    const data = defineLanguageFacet(spec.languageData);
    const parser = spec.parser.configure({
      props: [languageDataProp.add((type) => (type.isTop ? data : undefined))],
    });
    return new LRLanguage(data, parser, [], spec.name ?? "");
  }
}

/** `createCodeMirrorHighlightStyle` serves the app's editor; the daemon never calls it. */
export class HighlightStyle {
  static define(_specs: readonly unknown[]): HighlightStyle {
    throw new Error("HighlightStyle needs a CodeMirror editor, which the native build does not have");
  }
}

// ---- Stream languages (port of @codemirror/language 6.12.4 src/stream-parser.ts) ----

const STREAM_TAB_SIZE = 4;
const STREAM_INDENT_UNIT = 2;
const START_STATE_INDENT_UNIT = 4;
const CHUNK_SIZE = 512;
const MAX_LINE_LENGTH = 10000;
const MAX_ADVANCE_ATTEMPTS = 10;

function countCol(
  string: string,
  end: number | null,
  tabSize: number,
  startIndex = 0,
  startValue = 0,
): number {
  let stop = end;
  if (stop === null) {
    stop = string.search(/[^\s ]/);
    if (stop === -1) stop = string.length;
  }
  let n = startValue;
  for (let i = startIndex; i < stop; i++) {
    if (string.charCodeAt(i) === 9) n += tabSize - (n % tabSize);
    else n++;
  }
  return n;
}

export type StreamMatch = string | RegExp | ((ch: string) => boolean);

export class StringStream {
  pos = 0;
  start = 0;
  private lastColumnPos = 0;
  private lastColumnValue = 0;

  constructor(
    readonly string: string,
    private readonly tabSize: number,
    readonly indentUnit: number,
    private readonly overrideIndent?: number,
  ) {}

  eol(): boolean {
    return this.pos >= this.string.length;
  }

  sol(): boolean {
    return this.pos === 0;
  }

  peek(): string | undefined {
    return this.string.charAt(this.pos) || undefined;
  }

  next(): string | undefined {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
    return undefined;
  }

  eat(match: StreamMatch): string | undefined {
    const ch = this.string.charAt(this.pos);
    let ok: boolean;
    if (typeof match === "string") ok = ch === match;
    else ok = ch !== "" && (match instanceof RegExp ? match.test(ch) : match(ch));
    if (ok) {
      ++this.pos;
      return ch;
    }
    return undefined;
  }

  eatWhile(match: StreamMatch): boolean {
    const start = this.pos;
    while (this.eat(match) !== undefined) {
      // eat advances pos
    }
    return this.pos > start;
  }

  eatSpace(): boolean {
    const start = this.pos;
    while (/[\s ]/.test(this.string.charAt(this.pos))) ++this.pos;
    return this.pos > start;
  }

  skipToEnd(): void {
    this.pos = this.string.length;
  }

  skipTo(ch: string): boolean | undefined {
    const found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
    return undefined;
  }

  backUp(n: number): void {
    this.pos -= n;
  }

  column(): number {
    if (this.lastColumnPos < this.start) {
      this.lastColumnValue = countCol(
        this.string,
        this.start,
        this.tabSize,
        this.lastColumnPos,
        this.lastColumnValue,
      );
      this.lastColumnPos = this.start;
    }
    return this.lastColumnValue;
  }

  indentation(): number {
    return this.overrideIndent ?? countCol(this.string, null, this.tabSize);
  }

  match(
    pattern: string | RegExp,
    consume?: boolean,
    caseInsensitive?: boolean,
  ): boolean | RegExpMatchArray | null {
    if (typeof pattern === "string") {
      const substr = this.string.substr(this.pos, pattern.length);
      const same = caseInsensitive
        ? substr.toLowerCase() === pattern.toLowerCase()
        : substr === pattern;
      if (same) {
        if (consume !== false) this.pos += pattern.length;
        return true;
      }
      return null;
    }
    const match = this.string.slice(this.pos).match(pattern);
    if (match && (match.index ?? 0) > 0) return null;
    if (match && consume !== false) this.pos += match[0].length;
    return match;
  }

  current(): string {
    return this.string.slice(this.start, this.pos);
  }
}

export interface StreamParser<State> {
  name?: string;
  startState?(indentUnit: number): State;
  token(stream: StringStream, state: State): string | null;
  blankLine?(state: State, indentUnit: number): void;
  copyState?(state: State): State;
  indent?(state: State, textAfter: string, context: IndentContext): number | null;
  languageData?: LanguageDataValue;
  tokenTable?: Record<string, Tag | readonly Tag[]>;
  mergeTokens?: boolean;
}

interface FullStreamParser {
  token(stream: StringStream, state: unknown): string | null;
  blankLine(state: unknown, indentUnit: number): void;
  startState(indentUnit: number): unknown;
  copyState(state: unknown): unknown;
  mergeTokens: boolean;
}

/** The default `copyState`: a shallow copy that also copies top-level arrays. */
function defaultCopyState(state: unknown): unknown {
  if (typeof state !== "object") return state;
  const copy: Record<string, unknown> = {};
  if (state === null) return copy;
  const source = state as Record<string, unknown>;
  for (const prop in source) {
    const value = source[prop];
    copy[prop] = Array.isArray(value) ? value.slice() : value;
  }
  return copy;
}

// The real `fullParser` copies the spec's functions into a new object, so they never run
// with the spec as `this`; calling them unbound here matches that.
function fullParser(spec: StreamParser<unknown>): FullStreamParser {
  const token = spec.token;
  const blankLine = spec.blankLine;
  const startState = spec.startState;
  const copyState = spec.copyState;
  return {
    token: (stream, state) => token(stream, state),
    blankLine: (state, indentUnit) => {
      if (blankLine) blankLine(state, indentUnit);
    },
    startState: (indentUnit) => (startState ? startState(indentUnit) : true),
    copyState: (state) => (copyState ? copyState(state) : defaultCopyState(state)),
    mergeTokens: spec.mergeTokens !== false,
  };
}

const PLAIN_TAGS: ReadonlyMap<string, Tag> = new Map<string, Tag>([
  ["comment", tags.comment],
  ["lineComment", tags.lineComment],
  ["blockComment", tags.blockComment],
  ["docComment", tags.docComment],
  ["name", tags.name],
  ["variableName", tags.variableName],
  ["typeName", tags.typeName],
  ["tagName", tags.tagName],
  ["propertyName", tags.propertyName],
  ["attributeName", tags.attributeName],
  ["className", tags.className],
  ["labelName", tags.labelName],
  ["namespace", tags.namespace],
  ["macroName", tags.macroName],
  ["literal", tags.literal],
  ["string", tags.string],
  ["docString", tags.docString],
  ["character", tags.character],
  ["attributeValue", tags.attributeValue],
  ["number", tags.number],
  ["integer", tags.integer],
  ["float", tags.float],
  ["bool", tags.bool],
  ["regexp", tags.regexp],
  ["escape", tags.escape],
  ["color", tags.color],
  ["url", tags.url],
  ["keyword", tags.keyword],
  ["self", tags.self],
  ["null", tags.null],
  ["atom", tags.atom],
  ["unit", tags.unit],
  ["modifier", tags.modifier],
  ["operatorKeyword", tags.operatorKeyword],
  ["controlKeyword", tags.controlKeyword],
  ["definitionKeyword", tags.definitionKeyword],
  ["moduleKeyword", tags.moduleKeyword],
  ["operator", tags.operator],
  ["derefOperator", tags.derefOperator],
  ["arithmeticOperator", tags.arithmeticOperator],
  ["logicOperator", tags.logicOperator],
  ["bitwiseOperator", tags.bitwiseOperator],
  ["compareOperator", tags.compareOperator],
  ["updateOperator", tags.updateOperator],
  ["definitionOperator", tags.definitionOperator],
  ["typeOperator", tags.typeOperator],
  ["controlOperator", tags.controlOperator],
  ["punctuation", tags.punctuation],
  ["separator", tags.separator],
  ["bracket", tags.bracket],
  ["angleBracket", tags.angleBracket],
  ["squareBracket", tags.squareBracket],
  ["paren", tags.paren],
  ["brace", tags.brace],
  ["content", tags.content],
  ["heading", tags.heading],
  ["heading1", tags.heading1],
  ["heading2", tags.heading2],
  ["heading3", tags.heading3],
  ["heading4", tags.heading4],
  ["heading5", tags.heading5],
  ["heading6", tags.heading6],
  ["contentSeparator", tags.contentSeparator],
  ["list", tags.list],
  ["quote", tags.quote],
  ["emphasis", tags.emphasis],
  ["strong", tags.strong],
  ["link", tags.link],
  ["monospace", tags.monospace],
  ["strikethrough", tags.strikethrough],
  ["inserted", tags.inserted],
  ["deleted", tags.deleted],
  ["changed", tags.changed],
  ["invalid", tags.invalid],
  ["meta", tags.meta],
  ["documentMeta", tags.documentMeta],
  ["annotation", tags.annotation],
  ["processingInstruction", tags.processingInstruction],
]);

function applyModifier(name: string, tag: Tag): Tag | null {
  switch (name) {
    case "definition":
      return tags.definition(tag);
    case "constant":
      return tags.constant(tag);
    case "function":
      return tags.function(tag);
    case "standard":
      return tags.standard(tag);
    case "local":
      return tags.local(tag);
    case "special":
      return tags.special(tag);
    default:
      return null;
  }
}

function isModifierName(name: string): boolean {
  return (
    name === "definition" ||
    name === "constant" ||
    name === "function" ||
    name === "standard" ||
    name === "local" ||
    name === "special"
  );
}

const typeArray: NodeType[] = [NodeType.none];
const nodeSet = new NodeSet(typeArray);
const warned: string[] = [];
const byTag = new Map<string, NodeType>();

function warnForPart(part: string, msg: string): void {
  if (warned.indexOf(part) > -1) return;
  warned.push(part);
  console.warn(msg);
}

type TokenTableSpec = Record<string, Tag | readonly Tag[]>;

// `Tag.id` is internal to @lezer/highlight; this numbering only dedupes node types, as it does.
const tagIds = new Map<Tag, number>();
function tagKey(tag: Tag): number {
  let id = tagIds.get(tag);
  if (id === undefined) {
    id = tagIds.size;
    tagIds.set(tag, id);
  }
  return id;
}

function lookupTagPart(extra: TokenTableSpec, part: string): readonly Tag[] | null {
  if (Object.hasOwn(extra, part)) {
    const value = extra[part];
    return Array.isArray(value) ? (value as readonly Tag[]) : [value as Tag];
  }
  const tag = PLAIN_TAGS.get(part);
  return tag ? [tag] : null;
}

function createTokenType(extra: TokenTableSpec, tagStr: string): number {
  const found: Tag[] = [];
  for (const name of tagStr.split(" ")) {
    let current: Tag[] = [];
    for (const part of name.split(".")) {
      if (isModifierName(part) && !Object.hasOwn(extra, part)) {
        if (!current.length) warnForPart(part, `Modifier ${part} used at start of tag`);
        else {
          const next: Tag[] = [];
          for (const tag of current) {
            const modified = applyModifier(part, tag);
            if (modified) next.push(modified);
          }
          current = next;
        }
        continue;
      }
      const value = lookupTagPart(extra, part);
      if (!value) warnForPart(part, `Unknown highlighting tag ${part}`);
      else if (current.length) warnForPart(part, `Tag ${part} used as modifier`);
      else current = value.slice();
    }
    for (const tag of current) found.push(tag);
  }
  if (!found.length) return 0;

  const name = tagStr.replace(/ /g, "_");
  const key = name + " " + found.map(tagKey).join(",");
  const known = byTag.get(key);
  if (known) return known.id;
  const spec: Record<string, Tag[]> = {};
  spec[name] = found;
  const type = NodeType.define({ id: typeArray.length, name, props: [styleTags(spec)] });
  byTag.set(key, type);
  typeArray.push(type);
  return type.id;
}

const LEGACY_TOKEN_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["variable", "variableName"],
  ["variable-2", "variableName.special"],
  ["string-2", "string.special"],
  ["def", "variableName.definition"],
  ["tag", "tagName"],
  ["attribute", "attributeName"],
  ["type", "typeName"],
  ["builtin", "variableName.standard"],
  ["qualifier", "modifier"],
  ["error", "invalid"],
  ["header", "heading"],
  ["property", "propertyName"],
];

const noTokens: TokenTableSpec = {};
const defaultTable = new Map<string, number>();
for (const [legacyName, name] of LEGACY_TOKEN_NAMES) {
  defaultTable.set(legacyName, createTokenType(noTokens, name));
}

class TokenTable {
  private readonly table = new Map<string, number>(defaultTable);

  constructor(private readonly extra: TokenTableSpec) {}

  // Not `resolve`: a typed method of that name collides with @lezer/common's
  // `TreeNode.resolve` in scriptc 0.4.10 (SC9001 duplicate `%prototype.data...TreeNode`).
  resolveTag(tag: string | null): number {
    if (!tag) return 0;
    const known = this.table.get(tag);
    if (known) return known;
    const id = createTokenType(this.extra, tag);
    this.table.set(tag, id);
    return id;
  }
}

const defaultTokenTable = new TokenTable(noTokens);

function readToken(parser: FullStreamParser, stream: StringStream, state: unknown): string | null {
  stream.start = stream.pos;
  for (let i = 0; i < MAX_ADVANCE_ATTEMPTS; i++) {
    const result = parser.token(stream, state);
    if (stream.pos > stream.start) return result;
  }
  throw new Error("Stream parser failed to advance stream.");
}

function docType(data: LanguageFacet): NodeType {
  const type = NodeType.define({
    id: typeArray.length,
    name: "Document",
    props: [languageDataProp.add(() => data)],
    top: true,
  });
  typeArray.push(type);
  return type;
}

// scriptc cannot instantiate `NodeProp<unknown>`; the parser state rides in this box.
class SavedState {
  constructor(readonly state: unknown) {}
}

interface StreamStart {
  state: unknown;
  pos: number;
}

function findState(
  lang: StreamLanguage,
  tree: Tree,
  off: number,
  startPos: number,
  before: number,
): StreamStart | null {
  if (off >= startPos && off + tree.length <= before) {
    const saved = tree.prop(lang.stateAfter);
    if (saved && saved.state)
      return { state: lang.streamParser.copyState(saved.state), pos: off + tree.length };
  }
  for (let i = tree.children.length - 1; i >= 0; i--) {
    const child = tree.children[i];
    const pos = off + tree.positions[i];
    if (child instanceof Tree && pos < before) {
      const found = findState(lang, child, pos, startPos, before);
      if (found) return found;
    }
  }
  return null;
}

function cutTree(
  lang: StreamLanguage,
  tree: Tree,
  from: number,
  to: number,
  inside: boolean,
): Tree | null {
  if (inside && from <= 0 && to >= tree.length) return tree;
  let within = inside;
  if (!within && from === 0 && tree.type === lang.topNode) within = true;
  for (let i = tree.children.length - 1; i >= 0; i--) {
    const pos = tree.positions[i];
    const child = tree.children[i];
    if (pos < to && child instanceof Tree) {
      const inner = cutTree(lang, child, from - pos, to - pos, within);
      if (!inner) break;
      return !within
        ? inner
        : new Tree(
            tree.type,
            tree.children.slice(0, i).concat(inner),
            tree.positions.slice(0, i + 1),
            pos + inner.length,
          );
    }
  }
  return null;
}

function findStartInFragments(
  lang: StreamLanguage,
  fragments: readonly TreeFragment[],
  startPos: number,
  endPos: number,
): { state: unknown; tree: Tree } {
  for (const f of fragments) {
    const from = f.from + (f.openStart ? 25 : 0);
    const to = f.to - (f.openEnd ? 25 : 0);
    const found =
      from <= startPos && to > startPos ? findState(lang, f.tree, 0 - f.offset, startPos, to) : null;
    if (found && found.pos <= endPos) {
      const tree = cutTree(lang, f.tree, startPos + f.offset, found.pos + f.offset, false);
      if (tree) return { state: found.state, tree };
    }
  }
  return { state: lang.streamParser.startState(START_STATE_INDENT_UNIT), tree: Tree.empty };
}

interface Range {
  from: number;
  to: number;
}

class StreamParse implements PartialParse {
  stoppedAt: number | null = null;
  private readonly chunks: Tree[] = [];
  private readonly chunkPos: number[] = [];
  private chunk: number[] = [];
  private rangeIndex = 0;
  private readonly to: number;
  private state: unknown;
  parsedPos: number;
  private chunkStart: number;

  constructor(
    private readonly lang: StreamLanguage,
    private readonly input: Input,
    fragments: readonly TreeFragment[],
    private readonly ranges: readonly Range[],
  ) {
    this.to = ranges[ranges.length - 1].to;
    const from = ranges[0].from;
    const start = findStartInFragments(lang, fragments, from, this.to);
    this.state = start.state;
    this.parsedPos = this.chunkStart = from + start.tree.length;
    for (let i = 0; i < start.tree.children.length; i++) {
      // A stream tree's top-level children are the chunk trees `finishChunk` made.
      const child = start.tree.children[i];
      if (child instanceof Tree) {
        this.chunks.push(child);
        this.chunkPos.push(start.tree.positions[i]);
      }
    }
    this.moveRangeIndex();
  }

  advance(): Tree | null {
    const parseEnd = this.stoppedAt === null ? this.to : Math.min(this.to, this.stoppedAt);
    const end = Math.min(parseEnd, this.chunkStart + CHUNK_SIZE);
    while (this.parsedPos < end) this.parseLine();
    if (this.chunkStart < this.parsedPos) this.finishChunk();
    if (this.parsedPos >= parseEnd) return this.finish();
    return null;
  }

  stopAt(pos: number): void {
    this.stoppedAt = pos;
  }

  private lineAfter(pos: number): string {
    let chunk = this.input.chunk(pos);
    if (!this.input.lineChunks) {
      const eol = chunk.indexOf("\n");
      if (eol > -1) chunk = chunk.slice(0, eol);
    } else if (chunk === "\n") {
      chunk = "";
    }
    return pos + chunk.length <= this.to ? chunk : chunk.slice(0, this.to - pos);
  }

  private nextLine(): { line: string; end: number } {
    const from = this.parsedPos;
    let line = this.lineAfter(from);
    let end = from + line.length;
    for (let index = this.rangeIndex; ; ) {
      const rangeEnd = this.ranges[index].to;
      if (rangeEnd >= end) break;
      line = line.slice(0, rangeEnd - (end - line.length));
      index++;
      if (index === this.ranges.length) break;
      const rangeStart = this.ranges[index].from;
      const after = this.lineAfter(rangeStart);
      line += after;
      end = rangeStart + after.length;
    }
    return { line, end };
  }

  private skipGapsTo(pos: number, offset: number, side: number): number {
    let result = offset;
    for (;;) {
      const end = this.ranges[this.rangeIndex].to;
      const offPos = pos + result;
      if (side > 0 ? end > offPos : end >= offPos) break;
      const start = this.ranges[++this.rangeIndex].from;
      result += start - end;
    }
    return result;
  }

  private moveRangeIndex(): void {
    while (this.ranges[this.rangeIndex].to < this.parsedPos) this.rangeIndex++;
  }

  private emitToken(id: number, from: number, to: number, offset: number): number {
    let size = 4;
    let tokenFrom = from;
    let tokenTo = to;
    let result = offset;
    if (this.ranges.length > 1) {
      result = this.skipGapsTo(from, result, 1);
      tokenFrom += result;
      const len0 = this.chunk.length;
      result = this.skipGapsTo(to, result, -1);
      tokenTo += result;
      size += this.chunk.length - len0;
    }
    const last = this.chunk.length - 4;
    if (
      this.lang.streamParser.mergeTokens &&
      size === 4 &&
      last >= 0 &&
      this.chunk[last] === id &&
      this.chunk[last + 2] === tokenFrom
    )
      this.chunk[last + 2] = tokenTo;
    else this.chunk.push(id, tokenFrom, tokenTo, size);
    return result;
  }

  private parseLine(): void {
    const { line, end } = this.nextLine();
    let offset = 0;
    const streamParser = this.lang.streamParser;
    const stream = new StringStream(line, STREAM_TAB_SIZE, STREAM_INDENT_UNIT);
    if (stream.eol()) {
      streamParser.blankLine(this.state, stream.indentUnit);
    } else {
      while (!stream.eol()) {
        const token = readToken(streamParser, stream, this.state);
        if (token)
          offset = this.emitToken(
            this.lang.tokenTable.resolveTag(token),
            this.parsedPos + stream.start,
            this.parsedPos + stream.pos,
            offset,
          );
        if (stream.start > MAX_LINE_LENGTH) break;
      }
    }
    this.parsedPos = end;
    this.moveRangeIndex();
    if (this.parsedPos < this.to) this.parsedPos++;
  }

  private finishChunk(): void {
    const built = Tree.build({
      buffer: this.chunk,
      start: this.chunkStart,
      length: this.parsedPos - this.chunkStart,
      nodeSet,
      topID: 0,
      maxBufferLength: CHUNK_SIZE,
    });
    const tree = new Tree(built.type, built.children, built.positions, built.length, [
      [this.lang.stateAfter, new SavedState(this.lang.streamParser.copyState(this.state))],
    ]);
    this.chunks.push(tree);
    this.chunkPos.push(this.chunkStart - this.ranges[0].from);
    this.chunk = [];
    this.chunkStart = this.parsedPos;
  }

  private finish(): Tree {
    return new Tree(
      this.lang.topNode,
      this.chunks,
      this.chunkPos,
      this.parsedPos - this.ranges[0].from,
    ).balance();
  }
}

class StreamLanguageParser extends Parser {
  /** Set by the `StreamLanguage` constructor right after it calls `super`. */
  lang: StreamLanguage | null = null;

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly Range[],
  ): PartialParse {
    if (!this.lang) throw new Error("stream parser used before its language was built");
    return new StreamParse(this.lang, input, fragments, ranges);
  }
}

export class StreamLanguage extends Language {
  readonly topNode: NodeType;
  readonly streamParser: FullStreamParser;
  readonly stateAfter: NodeProp<SavedState>;
  readonly tokenTable: TokenTable;

  private constructor(spec: StreamParser<unknown>) {
    const data = defineLanguageFacet(spec.languageData);
    const impl = new StreamLanguageParser();
    super(data, impl, [], spec.name ?? "");
    impl.lang = this;
    this.topNode = docType(data);
    this.streamParser = fullParser(spec);
    this.stateAfter = new NodeProp<SavedState>({ perNode: true });
    this.tokenTable = spec.tokenTable ? new TokenTable(spec.tokenTable) : defaultTokenTable;
  }

  static define(spec: StreamParser<unknown>): StreamLanguage {
    return new StreamLanguage(spec);
  }
}
