/**
 * The preview Worker's entry point: `index.ts` without the Durable Object.
 *
 * A preview URL is the one way to look at a branch running against the real
 * dataset, and the production Worker cannot have one. Cloudflare does not
 * generate preview URLs for a Worker that implements a Durable Object, and
 * `index.ts` exports `ReadApi` — a container class is a Durable Object class.
 * That was measured rather than read: with preview URLs turned on for
 * `concestor-web` at the account, a fresh `versions upload --preview-alias`
 * still reported `has_preview: false` and both hostnames answered error 1042.
 *
 * So this file exists to export **less**. It re-uses `index.ts`'s `fetch`
 * verbatim — the beacon, the `/v1/` routing, the header stripping, the refusal
 * of anything else — and does not re-export `ReadApi`, which is what makes the
 * script preview-eligible. Nothing here may grow a second copy of a behaviour
 * that file already has; a preview that answers differently from production is
 * a preview of something else. `docs/deployment.md` §5 is the design.
 *
 * The container branch it does not take is the reason this is safe: with
 * `API_ORIGIN` set, `index.ts` proxies and returns before it reads `READ_API`,
 * so the binding this Worker does not have is a binding it never reaches. The
 * guard below is what holds that true rather than assuming it.
 */
import worker, { type Env } from "./index";

/**
 * The preview Worker's bindings: production's, minus the container.
 *
 * `API_ORIGIN` is required here where it is optional there, and that inversion
 * is the whole difference between the two Workers. In production it is a
 * development override that is empty, because the container binding is the
 * answer; here it is the *only* route to `/v1`, so an empty one is a
 * misconfiguration rather than a mode.
 */
interface PreviewEnv extends Omit<Env, "READ_API"> {
  API_ORIGIN?: string;
}

/**
 * What a preview says when it has no API to talk to.
 *
 * A deploy that forgot `--var API_ORIGIN` would otherwise reach `getRandom`
 * on an undefined binding and fail as a stack trace in a log nobody is
 * watching, on a URL whose whole purpose is to be looked at. `503` because it
 * is exactly that — the app is fine and its API is unreachable from here — and
 * `no-store` for the reason every other refusal in `index.ts` carries it: this
 * is a fact about a deploy, and one pinned at the edge outlives its cause.
 */
function unconfigured(): Response {
  return new Response(
    "This preview has no API origin configured, so /v1 goes nowhere. It is " +
      "deployed with --var API_ORIGIN pointing at production; see " +
      ".github/workflows/deploy-web.yml.",
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export default {
  fetch(request: Request, env: PreviewEnv): Response | Promise<Response> {
    if (!env.API_ORIGIN) return unconfigured();

    // Sound because of the line above, and for no weaker reason: `index.ts`
    // takes the `API_ORIGIN` branch before it touches `READ_API`, so the
    // property this cast claims exists is one that execution cannot reach.
    return worker.fetch(request, env as Env);
  },
};
