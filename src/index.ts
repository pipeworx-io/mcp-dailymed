interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * DailyMed MCP — FDA Structured Product Labels via NLM
 *
 * No auth. JSON via `?format=json` (default for v2 endpoints).
 * Docs: https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'DailyMed');
}

const BASE = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_drugs',
    description: 'Search Structured Product Labels by any combination of name, ANDA/NDA, NDC, RxCUI.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drug name (brand or generic)' },
        application_number: { type: 'string', description: 'ANDA/NDA number (e.g. "NDA021436")' },
        ndc: { type: 'string', description: 'NDC code (11-digit)' },
        rxcui: { type: 'string', description: 'RxNorm RxCUI' },
        manufacturer: { type: 'string', description: 'Manufacturer name' },
        page: { type: 'number', description: '1-based page (default 1)' },
        pagesize: { type: 'number', description: '1-100 (default 25)' },
      },
    },
  },
  {
    name: 'get_drug',
    description:
      'FULL FDA DRUG LABEL TEXT from the current DailyMed Structured Product Label \u2014 indications, dosage and administration, contraindications, warnings and precautions, boxed warning, adverse reactions, and every other labeled section, as readable plain text. Pass a DRUG NAME ("Ozempic", "ibuprofen") and it resolves the label automatically, or a DailyMed set_id. PREFER OVER WEB SEARCH for "what are the warnings for X", "what is X indicated for", "what is the dose of X", "does X have a boxed warning". Returns the label title, labeler, SPL version and publication date alongside the sections.',
    inputSchema: {
      type: 'object',
      properties: {
        drug_name: { type: 'string', description: 'Drug brand or generic name (e.g. "Ozempic", "ibuprofen"). Resolved to the primary manufacturer\'s label. Use this OR set_id.' },
        set_id: { type: 'string', description: 'DailyMed SET ID UUID, when you already have one. Takes precedence over drug_name.' },
        section: { type: 'string', description: 'Optional case-insensitive substring filter, matched against both the section heading and its LOINC category, e.g. "boxed warning", "warnings", "dosage", "indications". Omit for the whole label.' },
        max_section_chars: { type: 'number', description: 'Truncate each section body to this many characters (default 4000, max 40000).' },
      },
    },
  },
  {
    name: 'list_labels_for_drug_name',
    description: 'All labels mentioning a drug name.',
    inputSchema: {
      type: 'object',
      properties: {
        drug_name: { type: 'string' },
        page: { type: 'number' },
        pagesize: { type: 'number' },
      },
      required: ['drug_name'],
    },
  },
  {
    name: 'recent_updates',
    description: 'Return the most recently updated FDA Structured Product Labels from DailyMed (NLM), up to 100 results, ordered by update date descending. Useful for tracking newly revised drug labeling.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '1-100 (default 25)' } },
    },
  },
  {
    name: 'label_history',
    description:
      'Drug LABEL REVISION HISTORY — when a prescription drug\'s FDA label was revised, and how many times. Pass a DRUG NAME ("Ozempic", "semaglutide") and it resolves to that drug\'s Structured Product Label automatically; or pass a DailyMed set_id directly. PREFER OVER WEB SEARCH for "has the label for X changed recently", "when was X\'s label last updated", "how many label revisions does X have", label-change monitoring, and safety-labeling-change surveillance. Returns every published SPL version with its date, plus official archive URLs where DailyMed exposes them. Use before label_diff to see which versions are downloadable and pick two to compare.',
    inputSchema: {
      type: 'object',
      properties: {
        drug_name: { type: 'string', description: 'Drug brand or generic name (e.g. "Ozempic", "semaglutide"). Resolved to the primary manufacturer\'s label (the most-revised SPL for that name, over repackager duplicates). Use this OR set_id.' },
        set_id: { type: 'string', description: 'DailyMed SET ID UUID, when you already have one. Takes precedence over drug_name.' },
      },
    },
  },
  {
    name: 'label_diff',
    description:
      'WHAT CHANGED between two versions of a drug\'s FDA label — conservative section-level text comparison of official DailyMed SPL versions. Pass a DRUG NAME ("Ozempic") and it resolves the label automatically; or pass a set_id. Defaults to the latest version versus its immediate predecessor. PREFER OVER WEB SEARCH for "what changed in X\'s label", "new warnings added to X", "did X get a boxed warning", label-change diffing. Reports added, removed, and changed sections with normalized before/after text. Reports textual change only and leaves clinical materiality to the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        drug_name: { type: 'string', description: 'Drug brand or generic name (e.g. "Ozempic"). Resolved to the primary manufacturer\'s label. Use this OR set_id.' },
        set_id: { type: 'string', description: 'DailyMed SET ID UUID, when you already have one. Takes precedence over drug_name.' },
        from_version: { type: 'number', description: 'Older SPL version. Defaults to the version immediately before the latest.' },
        to_version: { type: 'number', description: 'Newer SPL version. Defaults to the latest version.' },
        include_unchanged: { type: 'boolean', description: 'Include unchanged sections (default false).' },
        max_sections: { type: 'number', description: 'Maximum section records returned (1-100, default 25); counts cover all sections.' },
      },
    },
  },
  {
    name: 'list_classes',
    description: 'List pharmacologic drug-class reference entries from DailyMed, optionally filtered by class_code or class type (EPC = established pharmacologic class, MoA = mechanism of action, PE = physiologic effect, CS = chemical structure). Returns class codes and display names. ~1,210 classes total, 100 per page.',
    inputSchema: {
      type: 'object',
      properties: {
        class_code: { type: 'string', description: 'Restrict to a specific class code. NLM RxClass format, e.g. "N0000175809" — not a UMLS CUI.' },
        type: { type: 'string', description: 'EPC | MoA | PE | CS' },
        page: { type: 'number', description: '1-based page (100 per page, ~13 pages). Ignored when class_code is given.' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_drugs': {
      const params = new URLSearchParams();
      if (args.name) params.set('drug_name', String(args.name));
      if (args.application_number) params.set('application_number', String(args.application_number));
      if (args.ndc) params.set('ndc', String(args.ndc));
      if (args.rxcui) params.set('rxcui', String(args.rxcui));
      if (args.manufacturer) params.set('manufacturer', String(args.manufacturer));
      params.set('page', String(Math.max(1, (args.page as number) ?? 1)));
      params.set('pagesize', String(Math.min(100, Math.max(1, (args.pagesize as number) ?? 25))));
      return dailymedGet(`/spls.json?${params}`);
    }
    case 'get_drug': {
      const r = await resolveSetId(args);
      const drug = await getDrugLabel(r.set_id, args);
      return r.resolved_from ? { ...drug, resolved_from: r.resolved_from } : drug;
    }
    case 'list_labels_for_drug_name': {
      const params = new URLSearchParams({
        drug_name: reqStr(args, 'drug_name', '"ibuprofen"'),
        page: String(Math.max(1, (args.page as number) ?? 1)),
        pagesize: String(Math.min(100, Math.max(1, (args.pagesize as number) ?? 25))),
      });
      return dailymedGet(`/spls.json?${params}`);
    }
    case 'recent_updates': {
      const params = new URLSearchParams({
        pagesize: String(Math.min(100, Math.max(1, (args.limit as number) ?? 25))),
      });
      return dailymedGet(`/spls.json?${params}`);
    }
    case 'label_history': {
      const r = await resolveSetId(args);
      const history = await getLabelHistory(r.set_id);
      return r.resolved_from ? { ...history, resolved_from: r.resolved_from } : history;
    }
    case 'label_diff': {
      const r = await resolveSetId(args);
      const diff = await diffLabelVersions({ ...args, set_id: r.set_id });
      return r.resolved_from ? { ...(diff as Record<string, unknown>), resolved_from: r.resolved_from } : diff;
    }
    case 'list_classes': {
      // The v2 path was renamed: `/pharmacologic_classes.json` now 302s to the
      // DailyMed HTML site, so every call died parsing `<!DOCTYPE` as JSON. The
      // live path is `/drugclasses.json`.
      const type = args.type ? String(args.type) : undefined;
      const code = args.class_code ? String(args.class_code).trim() : undefined;
      const pageUrl = (p: number) => {
        const params = new URLSearchParams({ pagesize: '100', page: String(p) });
        if (type) params.set('type', type);
        return `/drugclasses.json?${params}`;
      };
      if (!code) return dailymedGet(pageUrl(Math.max(1, (args.page as number) ?? 1)));
      // `class_code` is NOT a server-side filter. Passing it (or `drug_class_code`)
      // returns 200 with `total_elements: 0` instead of an error, so a code lookup
      // would confidently report "no such class" for codes that do exist. The full
      // list is only ~1,210 rows and pagesize caps at 100, so resolve the code by
      // walking pages and stopping at the first match.
      for (let p = 1; p <= 20; p++) {
        const body = (await dailymedGet(pageUrl(p))) as {
          data?: Array<{ code?: string }>;
          metadata?: { total_pages?: number };
        };
        const hit = (body.data ?? []).find((r) => r.code === code);
        if (hit) return { data: [hit], metadata: { matched_by: 'class_code', found_on_page: p } };
        if (p >= (body.metadata?.total_pages ?? 1)) break;
      }
      return {
        data: [],
        metadata: {
          matched_by: 'class_code',
          total_elements: 0,
          note: `No drug class with code "${code}". DailyMed class codes look like "N0000175809"; call without class_code to browse.`,
        },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function dailymedGet(path: string) {
  const res = await pwFetch(`${BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'pipeworx-mcp-dailymed/1.0 (+https://pipeworx.io)',
    },
  });
  if (res.status === 404) throw new Error('DailyMed: not found');
  if (res.status === 429) throw new Error('DailyMed: rate-limit (HTTP 429)');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DailyMed error: ${res.status} ${t.slice(0, 200)}`);
  }
  // DailyMed intermittently serves an HTML holding page under a 200 — five of
  // eleven `list_classes` calls this week died on `Unexpected token '<'`.
  return parseJson<unknown>(res, 'DailyMed');
}

interface LabelHistoryEntry {
  spl_version?: string | number;
  published_date?: string;
}

interface LabelHistoryResponse {
  metadata?: Record<string, unknown>;
  data?: {
    history?: LabelHistoryEntry[];
    spl?: { setid?: string; title?: string };
  };
}

// The current SPL is only served as XML: DailyMed retired the JSON
// representation of a whole label, so `/spls/<setid>.json` answers 415 with an
// empty body for every set id (its sub-resources — history.json, media.json —
// still speak JSON). We fetch the SPL document itself and shape it into the
// record the tool has always promised, reusing the same section parser
// label_diff runs on archived versions.
async function fetchCurrentLabelXml(setId: string): Promise<string> {
  const url = `${BASE}/spls/${encodeURIComponent(setId)}.xml`;
  const res = await pwFetch(url, {
    // Deliberately not application/json — this endpoint content-negotiates and
    // answers 406 for anything it cannot render as the SPL document.
    headers: { Accept: '*/*', 'User-Agent': 'pipeworx-mcp-dailymed/1.0 (+https://pipeworx.io)' },
  });
  if (res.status === 404) throw new Error(`DailyMed: no label found for set_id ${setId}.`);
  if (res.status === 429) throw new Error('DailyMed: rate-limit (HTTP 429)');
  if (!res.ok) throw await httpError(res, 'DailyMed label fetch error');
  return res.text();
}

function attrValue(xml: string, tag: string): string | null {
  return xml.match(new RegExp(`<${tag}\\b[^>]*\\bvalue="([^"]*)"`, 'i'))?.[1] ?? null;
}

function splDate(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

async function getDrugLabel(setId: string, args: Record<string, unknown>) {
  const xml = await fetchCurrentLabelXml(setId);
  const head = xml.slice(0, xml.search(/<component\b/i) > 0 ? xml.search(/<component\b/i) : 4000);
  const filter = typeof args.section === 'string' ? args.section.trim().toLowerCase() : '';
  const maxChars = Math.min(40_000, Math.max(200, Number(args.max_section_chars) || 4000));

  const all = [...parseLabelSections(xml).values()].filter((section) => section.text.trim().length > 0);
  const matched = filter
    ? all.filter(
        (section) =>
          section.title.toLowerCase().includes(filter) ||
          (section.category ?? '').toLowerCase().includes(filter),
      )
    : all;

  return {
    set_id: setId,
    title: plainXmlText(tagBody(head, 'title') ?? '') || null,
    labeler: plainXmlText(tagBody(head, 'name') ?? '') || null,
    document_type: head.match(/<code\b[^>]*\bdisplayName="([^"]*)"/i)?.[1] ?? null,
    spl_version: Number(attrValue(head, 'versionNumber')) || null,
    effective_date: splDate(attrValue(head, 'effectiveTime')),
    section_filter: filter || null,
    total_sections: all.length,
    returned_sections: matched.length,
    sections: matched.map((section) => ({
      code: section.code,
      category: section.category,
      title: section.title,
      text: section.text.length > maxChars ? `${section.text.slice(0, maxChars)}\u2026` : section.text,
      truncated: section.text.length > maxChars,
    })),
    ...(filter && matched.length === 0
      ? {
          found: false,
          reason: 'no_section_match',
          hint: `No section title or category contains "${filter}". Available: ${all
            .map((s) => (s.category && s.category.toLowerCase() !== s.title.toLowerCase() ? `${s.title} (${s.category})` : s.title))
            .slice(0, 25)
            .join(' | ')}`,
        }
      : {}),
    source: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${encodeURIComponent(setId)}`,
  };
}

async function getLabelHistory(setId: string) {
  const [raw, archiveDownloads] = await Promise.all([
    dailymedGet(`/spls/${encodeURIComponent(setId)}/history.json`) as Promise<LabelHistoryResponse>,
    getArchiveDownloads(setId).catch(() => new Map<number, string>()),
  ]);
  const entries = (raw.data?.history ?? [])
    .map((h) => ({
      version: Number(h.spl_version),
      published_date: normalizePublishedDate(h.published_date),
      download_url: archiveDownloads.get(Number(h.spl_version)) ?? null,
    }))
    .filter((h) => Number.isInteger(h.version) && h.version > 0)
    .sort((a, b) => b.version - a.version);
  return {
    set_id: raw.data?.spl?.setid ?? setId,
    title: raw.data?.spl?.title ?? null,
    count: entries.length,
    downloadable_count: entries.filter((entry) => entry.download_url).length,
    missing_download_versions: entries.filter((entry) => !entry.download_url).map((entry) => entry.version),
    versions: entries,
    source: `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${encodeURIComponent(setId)}/history.json`,
    archive_search: archiveSearchUrl(setId),
  };
}

function normalizePublishedDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function archiveSearchUrl(setId: string): string {
  const params = new URLSearchParams({ query: setId, pagesize: '100' });
  return `https://dailymed.nlm.nih.gov/dailymed/archives/index.cfm?${params}`;
}

async function getArchiveDownloads(setId: string): Promise<Map<number, string>> {
  const res = await pwFetch(archiveSearchUrl(setId), {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'pipeworx-mcp-dailymed/1.0 (+https://pipeworx.io)',
    },
  });
  if (res.status === 429) throw new Error('DailyMed: rate-limit (HTTP 429)');
  if (!res.ok) throw await httpError(res, 'DailyMed archive search error');
  const html = await res.text();
  const downloads = new Map<number, string>();
  for (const match of html.matchAll(
    /<li\b[^>]*>[\s\S]*?getArchivalFile\.cfm\?archive_id=(\d+)[\s\S]*?<div class="version">\s*Version:\s*<span>(\d+)<\/span>[\s\S]*?<\/li>/gi,
  )) {
    downloads.set(Number(match[2]), `https://dailymed.nlm.nih.gov/dailymed/getArchivalFile.cfm?archive_id=${match[1]}`);
  }
  return downloads;
}

async function fetchLabelXml(setId: string, version: number, downloadUrl: string | null): Promise<string> {
  if (!downloadUrl) {
    throw new Error(
      `DailyMed: no archive download was returned for version ${version} of ${setId}. Check ${archiveSearchUrl(setId)}.`,
    );
  }
  const res = await pwFetch(downloadUrl, {
    headers: {
      Accept: 'application/zip, application/octet-stream',
      'User-Agent': 'pipeworx-mcp-dailymed/1.0 (+https://pipeworx.io)',
    },
  });
  if (res.status === 404) throw new Error(`DailyMed: label version ${version} not found for ${setId}`);
  if (res.status === 429) throw new Error('DailyMed: rate-limit (HTTP 429)');
  if (!res.ok) throw await httpError(res, 'DailyMed label download error');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > 15_000_000) throw new Error('DailyMed label archive exceeds the 15 MB comparison limit.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 15_000_000) throw new Error('DailyMed label archive exceeds the 15 MB comparison limit.');
  return unzipFirstXml(bytes);
}

async function unzipFirstXml(bytes: Uint8Array): Promise<string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65_536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('DailyMed ZIP: central directory not found.');
  const total = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < total; i++) {
    if (offset + 46 > bytes.length || dv.getUint32(offset, true) !== 0x02014b50) break;
    const method = dv.getUint16(offset + 10, true);
    const compressedSize = dv.getUint32(offset + 20, true);
    const nameLength = dv.getUint16(offset + 28, true);
    const extraLength = dv.getUint16(offset + 30, true);
    const commentLength = dv.getUint16(offset + 32, true);
    const localOffset = dv.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.toLowerCase().endsWith('.xml')) continue;
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = dv.getUint16(localOffset + 26, true);
    const localExtraLength = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = bytes.subarray(start, start + compressedSize);
    if (method === 0) return decoder.decode(payload);
    if (method === 8) return inflateText(payload);
    throw new Error(`DailyMed ZIP: unsupported compression method ${method}.`);
  }
  throw new Error('DailyMed ZIP: no SPL XML document found.');
}

async function inflateText(payload: Uint8Array): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

interface LabelSection {
  key: string;
  code: string | null;
  title: string;
  text: string;
  // The LOINC displayName for the section code. Often the ONLY place the
  // canonical name appears: a boxed warning is titled with its actual subject
  // ("WARNING: RISK OF THYROID C-CELL TUMORS"), and only the code says what
  // kind of section it is.
  category: string | null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function plainXmlText(value: string): string {
  return decodeXml(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:paragraph|item|list|table|tr|section|title|content)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function tagBody(xml: string, tag: string): string | null {
  return xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? null;
}

function parseLabelSections(xml: string): Map<string, LabelSection> {
  const sections = new Map<string, LabelSection>();
  const occurrences = new Map<string, number>();
  const starts = [...xml.matchAll(/<section\b/gi)].map((m) => m.index ?? -1).filter((i) => i >= 0);
  for (const start of starts) {
    const openEnd = xml.indexOf('>', start);
    if (openEnd < 0) continue;
    let depth = 1;
    const tags = /<\/?section\b[^>]*>/gi;
    tags.lastIndex = openEnd + 1;
    let end = -1;
    for (let match = tags.exec(xml); match; match = tags.exec(xml)) {
      if (match[0].startsWith('</')) depth--;
      else depth++;
      if (depth === 0) {
        end = tags.lastIndex;
        break;
      }
    }
    if (end < 0) continue;
    const block = xml.slice(start, end);
    const codeTag = block.match(/<code\b[^>]*>/i)?.[0] ?? '';
    const code = codeTag.match(/\bcode="([^"]+)"/i)?.[1] ?? null;
    const displayName = decodeXml(codeTag.match(/\bdisplayName="([^"]+)"/i)?.[1] ?? '').trim();
    const title = plainXmlText(tagBody(block, 'title') ?? '') || displayName || code || 'Untitled section';
    const text = plainXmlText(tagBody(block, 'text') ?? '');
    if (!text) continue;
    const baseKey = code ? `code:${code}` : `title:${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);
    const key = `${baseKey}#${occurrence}`;
    sections.set(key, { key, code, title, text, category: displayName || null });
  }
  return sections;
}

function normalizedForComparison(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function highAttentionSection(section: LabelSection): boolean {
  return /(boxed warning|warnings? and precautions|contraindications|indications? and usage|dosage and administration|adverse reactions?)/i.test(section.title);
}

async function diffLabelVersions(args: Record<string, unknown>) {
  const setId = reqStr(args, 'set_id', '"abc123-..."');
  const history = await getLabelHistory(setId);
  const versions = history.versions.map((v) => v.version);
  if (versions.length < 2) throw new Error(`DailyMed: ${setId} has fewer than two label versions to compare.`);
  // DailyMed does not archive every version — the NEWEST version frequently has
  // no downloadable archive yet. Defaulting blindly to the latest made the
  // zero-arg call fail on active labels, so defaults are drawn from the
  // downloadable set. Explicitly requested versions are still honored (and fail
  // with a clear archive error if that version was never archived).
  const downloadable = history.versions.filter((v) => v.download_url).map((v) => v.version);
  const defaultPool = downloadable.length >= 2 ? downloadable : versions;
  const skippedNewer = args.to_version == null && defaultPool.length > 0 && defaultPool[0] !== versions[0]
    ? versions.filter((v) => v > defaultPool[0])
    : [];
  const toVersion = args.to_version == null ? defaultPool[0] : Number(args.to_version);
  const fromVersion = args.from_version == null
    ? defaultPool.find((version) => version < toVersion)
    : Number(args.from_version);
  if (!Number.isInteger(toVersion) || !versions.includes(toVersion)) {
    throw new Error(`to_version must be one of: ${versions.join(', ')}`);
  }
  if (fromVersion == null) {
    throw new Error(`DailyMed: version ${toVersion} has no older version to compare.`);
  }
  if (!Number.isInteger(fromVersion) || !versions.includes(fromVersion)) {
    throw new Error(`from_version must be one of: ${versions.join(', ')}`);
  }
  if (fromVersion === toVersion) throw new Error('from_version and to_version must differ.');
  if (fromVersion > toVersion) throw new Error('from_version must be older than and numerically lower than to_version.');

  const [beforeXml, afterXml] = await Promise.all([
    fetchLabelXml(setId, fromVersion, history.versions.find((v) => v.version === fromVersion)?.download_url ?? null),
    fetchLabelXml(setId, toVersion, history.versions.find((v) => v.version === toVersion)?.download_url ?? null),
  ]);
  const before = parseLabelSections(beforeXml);
  const after = parseLabelSections(afterXml);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const includeUnchanged = args.include_unchanged === true;
  const maxSections = Math.min(100, Math.max(1, Number(args.max_sections) || 25));
  const changes: Array<Record<string, unknown>> = [];
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const key of keys) {
    const oldSection = before.get(key);
    const newSection = after.get(key);
    const type = !oldSection ? 'added'
      : !newSection ? 'removed'
        : normalizedForComparison(oldSection.text) === normalizedForComparison(newSection.text) ? 'unchanged'
          : 'changed';
    counts[type]++;
    if (type === 'unchanged' && !includeUnchanged) continue;
    const section = newSection ?? oldSection as LabelSection;
    const cap = (text: string | undefined) => text && text.length > 6000 ? `${text.slice(0, 6000)}…` : text ?? null;
    changes.push({
      change_type: type,
      section_code: section.code,
      section_title: section.title,
      section_occurrence: Number(section.key.match(/#(\d+)$/)?.[1] ?? 1),
      high_attention_section: highAttentionSection(section),
      before_text: cap(oldSection?.text),
      after_text: cap(newSection?.text),
      before_truncated: (oldSection?.text.length ?? 0) > 6000,
      after_truncated: (newSection?.text.length ?? 0) > 6000,
    });
  }
  changes.sort((a, b) =>
    Number(b.high_attention_section) - Number(a.high_attention_section)
    || String(a.section_title).localeCompare(String(b.section_title)));
  const returnedChanges = changes.slice(0, maxSections);
  return {
    set_id: setId,
    title: history.title,
    from_version: fromVersion,
    to_version: toVersion,
    ...(skippedNewer.length
      ? {
          newer_versions_not_archived: skippedNewer,
          version_selection_note: `Version(s) ${skippedNewer.join(', ')} are published but have no downloadable DailyMed archive, so the newest ARCHIVED pair was compared instead. Pass to_version explicitly to override.`,
        }
      : {}),
    counts,
    returned_sections: returnedChanges.length,
    sections_truncated: changes.length > returnedChanges.length,
    changes: returnedChanges,
    interpretation:
      'This is a normalized section-text comparison, not a clinical-materiality assessment. high_attention_section is only a routing hint for sections commonly reviewed for safety or use changes. Read the before/after text and official SPLs before characterizing significance.',
    sources: {
      history: history.source,
      archive_search: history.archive_search,
      from_label: history.versions.find((v) => v.version === fromVersion)?.download_url ?? null,
      to_label: history.versions.find((v) => v.version === toVersion)?.download_url ?? null,
    },
  };
}

interface SetIdResolution {
  set_id: string;
  resolved_from?: {
    drug_name: string;
    matched_title: string;
    spl_version: number;
    published_date: string | null;
    candidates_considered: number;
    note: string;
    alternatives: { set_id: string; title: string; spl_version: number }[];
  };
}

/**
 * Accept either a set_id or a drug NAME on the label tools. A DailyMed set_id
 * is an opaque UUID no caller knows up front, which made these tools
 * unreachable without a separate lookup; a drug name is what agents actually
 * have.
 *
 * A name search returns the manufacturer's label alongside repackager
 * duplicates of the same drug (e.g. Ozempic → Novo Nordisk plus several
 * "A-S MEDICATION SOLUTIONS" entries). We pick by highest spl_version: the
 * actively-maintained primary label accrues revisions (20+) while repackager
 * SPLs sit at 1-6 — and version count is exactly what these history/diff tools
 * are about. Titles starting with the queried name are preferred first so a
 * brand query does not drift to a combination-product label.
 */
async function resolveSetId(args: Record<string, unknown>): Promise<SetIdResolution> {
  const rawSetId = typeof args.set_id === 'string' ? args.set_id.trim() : '';
  if (rawSetId) return { set_id: rawSetId };

  const drugName = typeof args.drug_name === 'string' ? args.drug_name.trim() : '';
  if (!drugName) {
    throw new Error(
      'Pass either "drug_name" (e.g. "Ozempic" — resolved automatically) or "set_id" (a DailyMed SET ID UUID).',
    );
  }

  const params = new URLSearchParams({ drug_name: drugName, page: '1', pagesize: '50' });
  const found = (await dailymedGet(`/spls.json?${params}`)) as {
    data?: { setid?: string; title?: string; spl_version?: number | string; published_date?: string }[];
  };
  const rows = (found.data ?? []).filter((r) => typeof r.setid === 'string' && r.setid);
  if (rows.length === 0) {
    throw new Error(
      `No DailyMed label found for drug_name "${drugName}". Check the spelling, try the generic name (or the brand name), or use search_drugs to locate a set_id.`,
    );
  }

  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const q = norm(drugName);
  const ver = (r: { spl_version?: number | string }) => Number(r.spl_version) || 0;
  const ranked = rows.slice().sort((a, b) => {
    const aStarts = norm(a.title ?? '').startsWith(q) ? 1 : 0;
    const bStarts = norm(b.title ?? '').startsWith(q) ? 1 : 0;
    return bStarts - aStarts || ver(b) - ver(a);
  });
  const best = ranked[0];

  return {
    set_id: best.setid as string,
    resolved_from: {
      drug_name: drugName,
      matched_title: best.title ?? '',
      spl_version: ver(best),
      published_date: best.published_date ?? null,
      candidates_considered: rows.length,
      note: 'Resolved from drug_name to the most-revised matching SPL (the primary manufacturer label, over repackager duplicates). Pass set_id explicitly to target a different label.',
      alternatives: ranked.slice(1, 4).map((r) => ({
        set_id: r.setid as string,
        title: r.title ?? '',
        spl_version: ver(r),
      })),
    },
  };
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
