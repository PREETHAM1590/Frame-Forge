import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import App from "./App";
// Uncaught renderer errors go to the console; the main process copies console errors into main.log.
window.addEventListener("error", (e) =>
  console.error(e.message || "Uncaught error"),
);
window.addEventListener("unhandledrejection", (e) =>
  console.error(
    "Unhandled rejection: " +
      (e.reason instanceof Error ? e.reason.message : String(e.reason)),
  ),
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
