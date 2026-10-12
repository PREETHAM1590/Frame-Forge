import { contextBridge, ipcRenderer } from "electron";
import {
  requests,
  responses,
  Envelope,
  EventSchema,
  type Api,
  type AppEvent,
  type Method,
} from "../shared/contracts.js";
const api = {} as Api;
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
// One-way main -> renderer events, validated before they reach the page.
Object.defineProperty(api, "onEvent", {
  enumerable: true,
  value: (callback: (event: AppEvent) => void) => {
    const listener = (_: unknown, data: unknown) => {
      const parsed = EventSchema.safeParse(data);
      if (parsed.success) callback(parsed.data);
    };
    ipcRenderer.on("frameforge:event", listener);
    return () => {
      ipcRenderer.removeListener("frameforge:event", listener);
    };
  },
});
contextBridge.exposeInMainWorld("frameforge", Object.freeze(api));
