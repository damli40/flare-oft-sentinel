import React from "react";
import ReactDOM from "react-dom/client";
import FlareRailStatus from "./components/FlareRailStatus.tsx";
import "./index.css";
// landing.css carries the design-system pieces this page reuses verbatim:
// the band chips (.spill / .s-crit / .s-warn / .s-safe) and the page shell
// (.page, .btn, footer.foot). dashboard.css carries the cards and detail rows.
import "./landing.css";
import "./dashboard.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FlareRailStatus />
  </React.StrictMode>
);
