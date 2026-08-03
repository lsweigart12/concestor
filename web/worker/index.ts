/**
 * The Cloudflare entry point: static assets, plus `/v1` on a Container.
 *
 * The whole app runs on Cloudflare. This Worker serves `web/dist` and routes
 * `/v1/*` to a Container running the Go read API unchanged — the same static
 * binary, the same mmap'd `.npy` arrays, the same `immutable=1` SQLite
 * database, on a machine with a page cache. `docs/deployment.md` is the
 * decision and the measurements; the short version is that the working set is
 * 463 MB against a 2.2 GB artifact set, which a `standard-1` instance holds
 * comfortably and a 128 MB Worker isolate cannot hold at all.
 *
 * The container has no public hostname — it is reachable only through the
 * binding below. That is what keeps `web/src/api.ts`'s same-origin `/v1`
 * fetch true here by construction rather than by configuration, as it already
 * is under the Go binary and under `scripts/dev.sh`'s vite proxy.
 *
 * Typed against @cloudflare/workers-types via web/tsconfig.worker.json, which
 * is a separate project from the app's: this file now declares a Durable
 * Object class and no longer "uses only Request/Response".
 */
import { Container, getRandom } from "@cloudflare/containers";

interface Env {
  /** The read API, one Container class over the Go binary. */
  READ_API: DurableObjectNamespace<ReadApi>;
  /**
   * Development override. When set, `/v1` is proxied to this origin and the
   * container is not started — which is what makes `wrangler dev` usable
   * against a locally running `scripts/serve.sh` instead of requiring Docker
   * and a 2.2 GB image on a laptop.
   *
   * Empty in production, where the binding is the answer. It stays here for a
   * second reason: it is also the fallback if the API ever moves back off
   * Cloudflare, and that should be a variable rather than a rewrite.
   */
  API_ORIGIN?: string;
}

/**
 * The read API container.
 *
 * `docs/architecture.md` §4's binary, in its own image with the artifact set
 * baked in. The image is referenced by registry tag in wrangler.jsonc rather
 * than built from a Dockerfile, because the 2.2 GB of pipeline output it
 * contains must never exist in CI — and because a Dockerfile makes
 * `wrangler deploy --dry-run` require Docker, which would break the one check
 * that keeps this config honest before there is an account.
 */
export class ReadApi extends Container<Env> {
  /** `server/main.go`'s default listen address. */
  defaultPort = 8080;

  /**
   * Long enough to cover a session and a gap, short enough to sleep overnight.
   *
   * A cold start is 1–3 s to pull the image plus a measured 0.78 s to open the
   * database and map the arrays, and the first interaction this app has with
   * anyone is them typing a species name into the palette — so the value is
   * bought with someone's first impression, not with money alone.
   *
   * It was 6h, which bought almost all of them at ~$26/month of memory. One
   * hour is the deliberate trade: an engaged reader browsing the tree never
   * meets a cold start, a second visit within the hour does not either, and
   * the container stops billing through the night. `docs/deployment.md` §2 has
   * the arithmetic and §6.1 is why this project takes the trade — the memory
   * line is the one large cost that is *capped*, and capping it lower matters
   * more here than avoiding the occasional 4 s wait.
   */
  sleepAfter = "1h";
}

/**
 * How many container instances `/v1` is spread over.
 *
 * One, deliberately. Every `/v1` response except `/v1/random` is
 * `Cache-Control: immutable` keyed by build id and Workers Cache is enabled in
 * wrangler.jsonc, so the edge absorbs the repeats — including a burst on a
 * cold key, which request collapsing turns into one invocation per data centre
 * rather than one per reader — and one instance is enough at this project's
 * traffic. Cloudflare has
 * no built-in autoscaling yet — the documented pattern is exactly this, a
 * fixed count with random routing — so raising this number is the scaling
 * knob, and it is a decision someone takes rather than something the platform
 * will take for us.
 */
const API_INSTANCES = 1;

/**
 * Headers that describe a hop rather than the request, and must not be
 * forwarded upstream. `host` is the loud one: sending Cloudflare's hostname to
 * an external origin makes every request look like it was meant for the edge,
 * which breaks any origin doing virtual hosting or TLS SNI matching.
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
    // routing mistake rather than a request to serve — and `no-store` because
    // a 404 is heuristically cacheable and Workers Cache would otherwise pin
    // the symptom of a misrouted path at the edge for the version's lifetime.
    if (!url.pathname.startsWith("/v1/")) {
      return new Response("Not found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (env.API_ORIGIN) return proxy(request, url, env.API_ORIGIN);

    // Returned as-is, like the proxy below. The API's own cache headers are
    // load-bearing and must not be second-guessed here: `/v1` responses are
    // `Cache-Control: immutable` keyed by build id because the data cannot
    // change within a build, and `/v1/random` is the one deliberate
    // exception, served `no-store` with no ETag. Caching that would give
    // every visitor the same "random" species forever — an endpoint that
    // appears to work and never picks twice.
    //
    // Edge caching now sits in front of this — wrangler.jsonc's `cache`
    // block — and it obeys that rule by construction: Workers Cache reads the
    // response's own Cache-Control per RFC 9111, so `/v1/random` is refused
    // without anything here naming the path. Nothing in this file may grow
    // into a list of cacheable paths, which is a list somebody eventually
    // forgets to add the next `/v1/random` to.
    const instance = await getRandom(env.READ_API, API_INSTANCES);
    return instance.fetch(request);
  },
};

/** Forward a request to an external API origin, verbatim. */
function proxy(request: Request, url: URL, origin: string): Promise<Response> {
  const target = new URL(url.pathname + url.search, origin);

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers.set(name, value);
  });

  return fetch(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}
