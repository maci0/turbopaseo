/**
 * Copyright (c) 2021 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IBuffer as IBufferApi, IBufferNamespace as IBufferNamespaceApi } from '../../../typings/xterm';
import { BufferApiView } from './BufferApiView';
import { ICoreTerminal } from '../CoreTerminal';
import { Disposable } from '../Lifecycle';
import { Emitter } from '../Event';

// native: no `implements` of the typings; the native build types the public API by these classes.
export class BufferNamespaceApi extends Disposable {
  private _normal: BufferApiView;
  private _alternate: BufferApiView;

  private readonly _onBufferChange = this._register(new Emitter<BufferApiView>());
  public readonly onBufferChange = this._onBufferChange.event;

  constructor(private _core: ICoreTerminal) {
    super();
    this._normal = new BufferApiView(this._core.buffers.normal, 'normal');
    this._alternate = new BufferApiView(this._core.buffers.alt, 'alternate');
    this._register(this._core.buffers.onBufferActivate(() => this._onBufferChange.fire(this.active)));
  }
  public get active(): BufferApiView {
    if (this._core.buffers.active === this._core.buffers.normal) { return this.normal; }
    if (this._core.buffers.active === this._core.buffers.alt) { return this.alternate; }
    throw new Error('Active buffer is neither normal nor alternate');
  }
  public get normal(): BufferApiView {
    return this._normal.init(this._core.buffers.normal);
  }
  public get alternate(): BufferApiView {
    return this._alternate.init(this._core.buffers.alt);
  }
}
