import { contextBridge, ipcRenderer } from "electron";
import {
  requests,
  responses,
  Envelope,
  EventSchema,
  type AppEvent,
  type FrameforgeApi,
  type Method,
} from "../shared/contracts.js";
const api = {} as FrameforgeApi;
for (const method of Object.keys(requests) as Method[]) {
  const invoke = async (input: unknown) => {
    const request = requests[method].parse(input);
    const envelope = Envelope.parse(
      await ipcRenderer.invoke("frameforge:request", method, request),
    );
    if (!envelope.ok) throw new Error(envelope.error.message);
    return responses[method].parse(envelope.data);
  };
  Object.defineProperty(api, method, { value: invoke, enumerable: true });
}
Object.defineProperty(api, "onEvent", {
  enumerable: true,
  value: (callback: (event: AppEvent) => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      const parsed = EventSchema.safeParse(payload);
      if (parsed.success) callback(parsed.data);
    };
    ipcRenderer.on("frameforge:event", listener);
    return () => {
      ipcRenderer.removeListener("frameforge:event", listener);
    };
  },
});
contextBridge.exposeInMainWorld("frameforge", Object.freeze(api));
