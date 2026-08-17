/**
 * HTTP entry point. Serves the single page and the JSON endpoints it calls, backed by
 * DuckDB over parquet that lives either locally or in a bucket.
 */

import { DIFFS_TABLE_KEY, argValue, isRemote, resolveDataLocation } from "./config.ts";
import { DiffStore } from "./store.ts";

const STATIC_DIR = new URL("../static/", import.meta.url).pathname;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Resolve a mode from the query string, rejecting anything the store did not register.
 *
 * @param store The open store
 * @param url The request URL
 * @returns The mode, or an error Response to return as-is
 */
function requireMode(store: DiffStore, url: URL): string | Response {
  const mode = url.searchParams.get("mode") ?? "";

  if (!store.availableModes.includes(mode)) {
    return json({ error: `unknown mode: ${JSON.stringify(mode)}` }, 400);
  }

  return mode;
}

/**
 * Serve a file from `static/`, defaulting to the page itself and refusing anything
 * that escapes the directory.
 */
async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");

  const resolved = new URL(relative, `file://${STATIC_DIR}`).pathname;

  if (!resolved.startsWith(STATIC_DIR)) return json({ error: "not found" }, 404);

  const file = Bun.file(resolved);

  if (!(await file.exists())) return json({ error: "not found" }, 404);

  return new Response(file);
}

async function handle(store: DiffStore, request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/modes") {
    return json({ modes: await store.modeSummaries() });
  }

  if (url.pathname === "/api/search") {
    const mode = requireMode(store, url);

    if (mode instanceof Response) return mode;

    return json({ results: await store.search(mode, url.searchParams.get("q") ?? "") });
  }

  if (url.pathname === "/api/drug") {
    const mode = requireMode(store, url);

    if (mode instanceof Response) return mode;

    const drugKey = url.searchParams.get("drug_key") ?? "";

    if (!drugKey) return json({ error: "drug_key is required" }, 400);

    const drug = await store.drug(mode, drugKey);

    if (!drug) return json({ error: `no diffs for ${JSON.stringify(drugKey)}` }, 404);

    return json(drug);
  }

  if (url.pathname === "/api/sections") {
    const mode = requireMode(store, url);

    if (mode instanceof Response) return mode;

    const drugKey = url.searchParams.get("drug_key") ?? "";

    if (!drugKey) return json({ error: "drug_key is required" }, 400);

    const sections = await store.sectionText(mode, drugKey, url.searchParams.get("set_id") ?? "");

    if (!sections) return json({ error: "no section text for that lineage" }, 404);

    return json(sections);
  }

  if (url.pathname.startsWith("/api/")) return json({ error: "unknown endpoint" }, 404);

  return serveStatic(url.pathname);
}

const argv = Bun.argv.slice(2);

const location = await resolveDataLocation(argv);

const hostname = argValue(argv, "--host") ?? process.env.HOST ?? "127.0.0.1";

const port = Number(argValue(argv, "--port") ?? process.env.PORT ?? 8000);

console.log(`Indexing parquet under ${location} ...`);

if (isRemote(location)) {
  console.log("  reading over the network; the first index build takes longer");
}

let store: DiffStore;

try {
  store = await DiffStore.open(location);
} catch (error) {
  // Missing credentials and an unreachable bucket are both ordinary setup problems,
  // so report them as such rather than as an unhandled throw.
  console.error(`\nCould not open ${location}`);

  console.error(`  ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);

  if (isRemote(location)) {
    console.error("\nCheck the HMAC credentials and that the bucket prefix exists:");

    console.error("  bash scripts/setup.sh");
  }

  process.exit(1);
}

if (store.availableModes.length === 0) {
  console.error(`No parquet found. Expected ${location}/<mode>/${DIFFS_TABLE_KEY}/*.parquet`);

  process.exit(1);
}

for (const summary of await store.modeSummaries()) {
  const text = store.sectionTextModes.has(summary.mode) ? "with section text" : "diffs only";

  console.log(
    `  ${summary.label.padEnd(12)} ${String(summary.n_diffs).padStart(7)} diffs` +
      `  ${String(summary.n_drugs).padStart(6)} drugs` +
      `  ${String(summary.n_lineages).padStart(6)} lineages  (${text})`,
  );
}

const server = Bun.serve({
  hostname,
  port,
  idleTimeout: 120,
  fetch: (request) =>
    handle(store, request).catch((error: unknown) =>
      json({ error: error instanceof Error ? error.message : String(error) }, 500),
    ),
});

console.log(`\nServing on http://${server.hostname}:${server.port}  (ctrl-c to stop)`);
