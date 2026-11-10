/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IDisposable } from '../../../typings/xterm';
import type { ITerminalAddon, Terminal } from '../../../../types';

// native: addons are held as closures made in a generic loadAddon (scriptc compiles a copy per
// addon class, and cannot hold different addon classes in one interface-typed slot). Upstream
// also replaces each addon's dispose method so that disposing an addon directly unloads it;
// scriptc cannot assign to methods, so here an addon disposed directly is disposed again when
// the terminal is disposed.
export interface ILoadedAddon {
  dispose: () => void;
  isDisposed: boolean;
}

export class AddonManager implements IDisposable {
  protected _addons: ILoadedAddon[] = [];

  public dispose(): void {
    for (let i = this._addons.length - 1; i >= 0; i--) {
      this._wrappedAddonDispose(this._addons[i]);
    }
  }

  public loadAddon<T extends ITerminalAddon>(terminal: Terminal, instance: T): void {
    const loadedAddon: ILoadedAddon = {
      dispose: () => instance.dispose(),
      isDisposed: false
    };
    this._addons.push(loadedAddon);
    instance.activate(terminal);
  }

  private _wrappedAddonDispose(loadedAddon: ILoadedAddon): void {
    if (loadedAddon.isDisposed) {
      // Do nothing if already disposed
      return;
    }
    let index = -1;
    for (let i = 0; i < this._addons.length; i++) {
      if (this._addons[i] === loadedAddon) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      throw new Error('Could not dispose an addon that has not been loaded');
    }
    loadedAddon.isDisposed = true;
    loadedAddon.dispose();
    this._addons.splice(index, 1);
  }
}
