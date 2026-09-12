import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('screenProf', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  capture: (sourceId: string) => ipcRenderer.invoke('screen:capture', sourceId),
  askTutor: (payload: unknown) => ipcRenderer.invoke('tutor:ask', payload),
  explainStep: (payload: unknown) => ipcRenderer.invoke('tutor:explain', payload),
  updateSettings: (update: unknown) => ipcRenderer.invoke('settings:update', update),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  showOverlay: (step: unknown) => ipcRenderer.invoke('overlay:show', step),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  collapse: () => ipcRenderer.invoke('window:collapse'),
  expand: () => ipcRenderer.invoke('window:expand'),
  hide: () => ipcRenderer.invoke('window:hide'),
  onWindowState: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  onOverlay: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('overlay:render', listener);
    return () => ipcRenderer.removeListener('overlay:render', listener);
  },
  onSettingsChanged: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
