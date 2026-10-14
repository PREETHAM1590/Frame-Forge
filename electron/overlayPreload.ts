import { contextBridge, ipcRenderer } from "electron";
// The overlay page can only receive display models; it has no way to call back into the app.
contextBridge.exposeInMainWorld(
  "overlay",
  Object.freeze({
    onModel: (callback: (model: unknown) => void) => {
      ipcRenderer.on("overlay:model", (_event, model: unknown) =>
        callback(model),
      );
    },
  }),
);
