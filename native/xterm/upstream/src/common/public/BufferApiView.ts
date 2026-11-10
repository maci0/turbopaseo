/**
 * Copyright (c) 2021 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IBuffer as IBufferApi, IBufferLine as IBufferLineApi, IBufferCell as IBufferCellApi } from '../../../typings/xterm';
import { IBuffer } from '../buffer/Types';
import { BufferLine } from '../buffer/BufferLine';
import { CellData } from '../buffer/CellData';

// native: no `implements` of the typings; the native build types the public API by these classes.
export class BufferApiView {
  constructor(
    private _buffer: IBuffer,
    public readonly type: 'normal' | 'alternate'
  ) { }

  public init(buffer: IBuffer): BufferApiView {
    this._buffer = buffer;
    return this;
  }

  public get cursorY(): number { return this._buffer.y; }
  public get cursorX(): number { return this._buffer.x; }
  public get viewportY(): number { return this._buffer.ydisp; }
  public get baseY(): number { return this._buffer.ybase; }
  public get length(): number { return this._buffer.lines.length; }
  public getLine(y: number): BufferLine | undefined {
    // native: every line in the buffer is a BufferLine.
    return this._buffer.lines.get(y) as BufferLine | undefined;
  }
  public getNullCell(): CellData { return new CellData(); }
}
