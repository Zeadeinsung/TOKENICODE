import React from "react";
import ReactDOM from "react-dom/client";
import { FloatingStrip } from "./FloatingStrip";
import "./floating.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FloatingStrip />
  </React.StrictMode>,
);
