/**
 * The Cloudflare entry point: static assets, plus a reverse proxy for /v1.
 *
 * Only the frontend can live here. The read API mmaps ~2 GB of `.npy` arrays
 * and opens a 2,004 MB SQLite database `immutable=1` at startup — that is a
 * container on a machine with page cache, not a Worker, and no amount of D1
 * or R2 makes it one without discarding the design in `docs/architecture.md`
 * §4. `docs/ci.md` §3 has the reasoning and what the alternatives would cost.
 *
 * So this proxies rather than serves. `web/src/api.ts` fetches `/v1/...`
 * same-origin, which is true in every environment the project has today: the
 * Go binary serves both, `scripts/dev.sh` proxies to it, and here the Worker
 * does. Keeping that true is the whole point — the alternative is a base-URL
 * setting in the client plus CORS on the server, which is two more things to
 * configure and two more ways for a deploy to be subtly wrong.
 *
 * Typed against the DOM's Request/Response rather than @cloudflare/workers-types.
 * The handler touches only `url`, method, headers and body pass-through, all
 * of which are the same shape in both, and one tsconfig already covers this
 * file and src/.
 */

interface Env {
  /**
   * Origin of the Go read API — scheme and host, no trailing path. Set at
   * deploy time from the CONCESTOR_API_ORIGIN repository variable, so the
   * frontend can be pointed at a different backend without a code change.
   */
  API_ORIGIN?: string;
}

/**
 * Headers that describe a hop rather than the request, and must not be
 * forwarded to the origin. `host` is the loud one: sending Cloudflare's
 * hostname to the API makes every request look like it was meant for the
 * edge, which breaks any origin doing virtual hosting or TLS SNI matching.
 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Assets are matched before this handler runs, except for the globs in
    // wrangler.jsonc's `run_worker_first`. Anything else reaching here is a
    // routing mistake rather than a request to serve.
    if (!url.pathname.startsWith("/v1/")) {
      return new Response("Not found", { status: 404 });
    }

    const origin = env.API_ORIGIN;
    if (!origin) {
      // 503 rather than 500: the deployment is incomplete, not broken, and
      // the message names the variable that fixes it. A blank canvas because
      // the API is unset looks identical to a blank canvas because the app is
      // broken, and the difference costs whoever hits it an hour — the same
      // reasoning as scripts/serve.sh refusing to start without build/.
      return new Response(
        "API_ORIGIN is not configured on this Worker. Set the " +
          "CONCESTOR_API_ORIGIN repository variable and redeploy.",
        { status: 503, headers: { "content-type": "text/plain" } },
      );
    }

    const target = new URL(url.pathname + url.search, origin);

    const headers = new Headers();
    request.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
    });

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    // Returned as-is. The API's own cache headers are load-bearing and must
    // not be second-guessed here: /v1 responses are `Cache-Control: immutable`
    // keyed by build id because the data cannot change within a build, and
    // /v1/random is the one deliberate exception, served `no-store` with no
    // ETag. Caching it at the edge would give every visitor the same
    // "random" species forever — an endpoint that appears to work and never
    // picks twice.
    return upstream;
  },
};
