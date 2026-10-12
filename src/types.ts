import type {
  Bootstrap,
  Method,
  Request,
  Response,
  OperationId,
} from "../shared/contracts";
export type Page =
  | "Dashboard"
  | "Optimizations"
  | "Presets"
  | "Game library"
  | "Game Mode"
  | "Restore & backups"
  | "System"
  | "Activity"
  | "Settings";
export interface ViewProps {
  data: Bootstrap;
  pending: boolean;
  run: <M extends Method>(
    method: M,
    input: Request<M>,
    message?: string,
  ) => Promise<Response<M> | undefined>;
  navigate: (page: Page) => void;
  preview: (ids: OperationId[]) => void;
}
