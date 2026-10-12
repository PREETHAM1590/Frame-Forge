import { contextBridge, ipcRenderer } from "electron";
import {
  requests,
  responses,
  Envelope,
  type Api,
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
contextBridge.exposeInMainWorld("frameforge", Object.freeze(api));
