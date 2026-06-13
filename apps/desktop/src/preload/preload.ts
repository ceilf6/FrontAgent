/**
 * Electron preload. The thin glue the IPC seam (#333) was designed for: it
 * exposes the {@link FrontAgentBridge} on `window.frontagent` via `contextBridge`
 * by handing `createPreloadBridge` a minimal `ipcRenderer` slice. No logic lives
 * here — all behaviour is in `createPreloadBridge`, which is unit-tested.
 */
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import { createPreloadBridge, type PreloadIpc } from './bridge.js';

const ipc: PreloadIpc = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as (event: IpcRendererEvent, ...args: unknown[]) => void);
  },
  removeListener: (channel, listener) => {
    ipcRenderer.removeListener(
      channel,
      listener as (event: IpcRendererEvent, ...args: unknown[]) => void,
    );
  },
};

contextBridge.exposeInMainWorld('frontagent', createPreloadBridge(ipc));
