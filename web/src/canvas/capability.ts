/**
 * What this browser can do, asked once.
 *
 * Module scope for the reason `chrome/fullscreen.ts` gives about its own
 * constant: the answer cannot change during a session, and a control that
 * appears halfway through one is worse than a control that was never there.
 *
 * It lives here rather than in `Graph.tsx`, where it was, because the switch it
 * gates has moved into the sidebar and the canvas still needs the same answer.
 * Two modules asking `BiolumRenderer.supported()` separately would be two
 * answers that can differ — which is the exact failure `FULLSCREEN_AVAILABLE`
 * exists as one constant to prevent: gate the button on one expression and the
 * palette row on another, and a browser without the capability gets a command
 * for a thing that cannot happen.
 */

import { BiolumRenderer } from "./gl/renderer";

export const BIOLUM_AVAILABLE = BiolumRenderer.supported();
