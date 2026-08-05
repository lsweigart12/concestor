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
   * Where {@link BEACON_PATH} writes. `docs/analytics.md` is the whole design.
   *
   * Analytics Engine rather than a database, because this is append-only,
   * unindexed by anything the app reads, and must never be something `/v1` can
   * wait on. It is also the only store on this platform that a Worker may write
   * to without the write being a request the reader paid for in latency:
   * `writeDataPoint` does not return a promise and does not extend the
   * invocation.
   */
  TELEMETRY: AnalyticsEngineDataset;
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
 * One, deliberately. **Every** `/v1` response is cacheable and keyed by build
 * id, and Workers Cache is enabled in wrangler.jsonc, so the edge absorbs the
 * repeats — including a burst on a cold key, which request collapsing turns
 * into one invocation per data centre rather than one per reader — and one
 * instance is enough at this project's traffic.
 *
 * That sentence used to read "every response except `/v1/random`", and losing
 * the exception is what makes this number defensible rather than merely
 * survivable. `/v1/random` was `no-store`, so it was the one path the edge
 * could not absorb *and* the one that could not be request-collapsed — and
 * measured against production it cost **1.2 s** of the half vCPU per press.
 * The draw now happens on the client from a pool served like everything else.
 * Cloudflare has
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

/**
 * The analytics beacon. `web/src/analytics/beacon.ts` is the other half.
 *
 * Under `/v1/` because that is what `run_worker_first` routes to this Worker,
 * and a second glob would be a second thing to keep in step with this file. It
 * is not part of the read API and the container never sees it.
 *
 * **It is a `POST`, and that is the caching argument.** Every `/v1` response is
 * `Cache-Control: immutable` behind Workers Cache, and the one rule
 * `docs/deployment.md` §5 lays down is that nothing in this file may grow into
 * a list of paths the cache should treat specially. A `POST` is uncacheable per
 * RFC 9111 without anyone deciding it should be, so the beacon adds a path that
 * the caching design does not have to know exists.
 */
const BEACON_PATH = "/v1/e";

/** The three events. Anything else is a client that got ahead of this Worker. */
const KINDS = new Set(["search", "add", "tree"]);

// Caps, mirroring `beacon.ts`. Both sides truncate: the client so that a long
// paste is not sent, this side because the client is the open internet.
const MAX_BODY = 8 * 1024;
const MAX_EVENTS = 32;
const MAX_SUBJECT = 128;
const MAX_TREE = 1024;
const MAX_SESSION = 64;
/** `blob4`'s width. The longest cause, `sequence-cut`, is 12 characters. */
const MAX_CAUSE = 16;

/**
 * The field that marks a beacon line in Workers Logs, and its value.
 *
 * Workers Logs holds everything this Worker emits and everything the platform
 * emits about it, so the browsable surface needs one filter that isolates the
 * events from all of that: `concestor = "beacon"`. The name is the project's
 * rather than something plausible like `event` or `type`, because a key that
 * could collide with a platform field is a filter that quietly starts matching
 * things nobody wrote. `docs/analytics.md` §9 is the dashboard.
 */
const LOG_MARKER = "beacon";

/**
 * Record what the browser says happened.
 *
 * Answers `204` to everything it accepts and to most of what it does not: a
 * beacon is fire-and-forget, the client cannot act on a `400`, and a status
 * code is not the place to teach anyone the schema. What a bad payload gets is
 * to be dropped.
 *
 * **The blob order below is the schema, and it is positional.** Analytics
 * Engine has no column names — the SQL API reads `blob1`, `blob2`, and so on —
 * so inserting a field in the middle silently reinterprets every row written
 * before it. Append only, and `docs/analytics.md` §3 is the table that says
 * what each one holds.
 *
 * Every accepted event is written **twice**, to two stores with different jobs:
 * the dataset, which is durable and queried over SQL, and a structured log line,
 * which is what the Workers Observability dashboard can chart. The log's keys
 * are names rather than positions, so it is not bound by the paragraph above —
 * but it carries the same values from the same variables, because two surfaces
 * that can disagree about what a reader did are worse than one.
 */
async function beacon(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return noStore(405);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return noStore(413);

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return noStore(413);
    body = JSON.parse(text);
  } catch {
    return noStore(204);
  }

  if (!body || typeof body !== "object") return noStore(204);
  const { session, events } = body as { session?: unknown; events?: unknown };
  if (!Array.isArray(events)) return noStore(204);

  const sid = typeof session === "string" ? session.slice(0, MAX_SESSION) : "";

  for (const raw of events.slice(0, MAX_EVENTS)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind : "";
    if (!KINDS.has(kind)) continue;

    const subject = str(e.subject, MAX_SUBJECT);
    const tree = str(e.tree, MAX_TREE);
    const cause = str(e.cause, MAX_CAUSE);
    // Derived here rather than sent, so it can never disagree with the string it
    // describes. Both writers below take it from this one variable, for the same
    // reason.
    const size = tree === "" ? 0 : tree.split(",").length;

    env.TELEMETRY.writeDataPoint({
      // The sampling key. Low cardinality on purpose: Analytics Engine samples
      // per index once volume is high, so a chatty `search` never costs the
      // rarer `tree` its fidelity. It also means every count in SQL has to be
      // weighted by `_sample_interval` — docs/analytics.md §4.
      indexes: [kind],
      blobs: [kind, subject, tree, cause, sid],
      doubles: [size],
    });

    // The same event again, as a log line, and the duplication is the design.
    //
    // Analytics Engine keeps this for three months and has no dashboard of any
    // kind — a SQL API, a Grafana integration, and querying from a Worker. The
    // Observability tab *is* a dashboard, with charts, a query builder and CSV
    // export, and it reads whatever this Worker logs: a JSON object's fields are
    // extracted and indexed, so each key below becomes something a reader can
    // filter, group and visualise by. Neither store replaces the other — logs
    // retain 7 days and are browsable, the dataset retains three months and is
    // what `scripts/analytics-report.sh` reads — and docs/analytics.md §9 says
    // which question to take to which.
    //
    // Flat, because a nested object is one key holding JSON rather than seven
    // keys. And these are the *validated, truncated* values, never the parsed
    // body: an unknown kind never reaches here, every string is capped, and a
    // log holding unchecked client input is a log you cannot trust when you read
    // it back — which matters more than the bytes, since the body is capped at
    // 8 KB and a single log at 256 KB.
    console.log({
      concestor: LOG_MARKER,
      kind,
      subject,
      tree,
      cause,
      session: sid,
      size,
    });
  }

  return noStore(204);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function noStore(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

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

    // Before the origin branch, so the beacon behaves identically under
    // `wrangler dev`, under a local `scripts/serve.sh`, and in production.
    // Proxying it would send it to the Go binary, which has never heard of it.
    if (url.pathname === BEACON_PATH) return beacon(request, env);

    if (env.API_ORIGIN) return proxy(request, url, env.API_ORIGIN);

    // Returned as-is, like the proxy below. The API's own cache headers are
    // load-bearing and must not be second-guessed here: `/v1` responses are
    // `Cache-Control: immutable` keyed by build id because the data cannot
    // change within a build — and there is no longer any exception to that.
    // There was one: `/v1/random` drew server-side and was served `no-store`
    // with no ETag, because caching it would have given every visitor the same
    // "random" species forever, an endpoint that appears to work and never
    // picks twice. The draw moved to the client, which fetches a pool from
    // `/v1/random-pool/{build_id}` — cacheable by the ordinary rule, because a
    // pool *is* a function of the build even though a draw is not.
    //
    // Edge caching sits in front of this — wrangler.jsonc's `cache` block —
    // and it obeys that rule by construction: Workers Cache reads the
    // response's own Cache-Control per RFC 9111, so nothing here names a path.
    // Nothing in this file may grow into a list of cacheable paths, which is a
    // list somebody eventually forgets to add the next exception to. That rule
    // is now true with an empty list rather than a list of one, which is the
    // strongest form it can take.
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
