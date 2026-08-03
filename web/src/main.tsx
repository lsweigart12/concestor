/**
 * The root, and the one place the two documents are told apart.
 *
 * `App` and `AboutPage` are mounted instead of one another, never together.
 * `route.ts` has the reason that has to happen here: the store writes the URL
 * from the view on every change, so an about page sharing a tree with it would
 * be replaced onto `/` on its first render.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AboutPage } from "./chrome/AboutPage";
import { useRoute } from "./route";
import "./styles.css";

function Root() {
  return useRoute() === "about" ? <AboutPage /> : <App />;
}

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");
createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
