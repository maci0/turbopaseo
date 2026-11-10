// A TypeScript sample
import { readFile } from "node:fs/promises";
export interface Point<T = number> { x: T; y: T }
enum Mode { Fast = 1, Slow = 0x2 }
export async function load(path: string): Promise<Point | null> {
  const text = await readFile(path, "utf8");
  if (/^\s*$/.test(text)) return null;
  return JSON.parse(`${text}`) as Point;
}
class Box<T> extends Array<T> { #size = 3n; get size(): bigint { return this.#size; } }
