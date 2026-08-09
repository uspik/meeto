import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

console.info("Meeto build:", __BUILD__);
(window as unknown as { __MEETO_BUILD__: string }).__MEETO_BUILD__ = __BUILD__;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
