# Label Change Diff Viewer

A local web app for reading the label-change safety signals produced by `label_change_diffs.py` (issue #2995). Pick a data source, find a drug by name or key, and read the diff for each PLR safety section next to the provenance that produced it, with the full section text a click away.

TypeScript on Bun, with DuckDB as the only dependency. It both queries the parquet and mirrors it locally, so one GCS HMAC key pair is the only credential anything needs.

## Quick start

```
make setup      # check HMAC credentials and toolchain
make install    # bun install
make serve      # read gs://monaco-dev-bucket/drug-safety-signaling-demo
```

Then open <http://127.0.0.1:8000>.

`make setup` is the thing to run first: it reports which credentials are present, masks their values, and tells you exactly which variables to export if any are missing.

## Credentials

Reading the bucket needs one GCS HMAC key pair, and nothing else:

```
export LABEL_DIFFS_HMAC_KEY_ID=GOOG1E...
export LABEL_DIFFS_HMAC_SECRET=...
```

`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are accepted under those names too, since that is how HMAC keys are usually exported for S3-compatible clients. To mint a pair against a service account that can read the bucket:

```
gcloud storage hmac create SERVICE_ACCOUNT_EMAIL
```

That is the whole setup. DuckDB reaches the bucket over its S3-compatible endpoint, which is exactly what HMAC keys are for, and it does both jobs: querying `gs://` in place and mirroring it locally. No cloud SDK is involved, nothing reads your `gcloud` login, and there is no second credential to keep in step. `gcloud` is only ever needed to mint the keys.

## Working locally

Querying local parquet is much faster than range requests over the network:

```
make sync           # mirror the bucket into ./data
make serve-local    # query ./data
```

`make sync-diffs` fetches only `label_change_diffs` and skips the much larger `label_section_versions`, which costs you the full-text tabs but downloads a small fraction of the data. Sync is resumable: a file already present is skipped, and `--force` overwrites.

The mirror is written by `COPY ... TO`, so the local files are re-encoded rather than byte-identical to the originals. Rows, schema and nested structs are preserved; treat `./data` as a cache, not an archive.

If `./data` exists, plain `bun run src/server.ts` prefers it over the bucket automatically.

## Docker

```
make docker-build
make docker-run     # passes the HMAC variables through
```

The image bakes in the bucket path and reads it directly, so nothing needs mounting. To run against a local copy instead, mount it at `/app/data` and append `--data ./data`.

## Make targets

| Target | Does |
| --- | --- |
| `setup` | Check HMAC credentials, bun, dependencies |
| `install` | `bun install` |
| `typecheck` | `tsc --noEmit` |
| `serve` | Run against the bucket |
| `serve-local` | Run against `./data` |
| `sync` / `sync-diffs` | Mirror the bucket into `./data` |
| `docker-build` / `docker-run` | Build and run the image |
| `clean` | Remove `node_modules` |

`DATA`, `HOST`, `PORT` and `IMAGE` are overridable: `make serve PORT=9000`.

## Layout

```
src/config.ts    data location, credentials, shared vocabulary
src/store.ts     DuckDB queries
src/duckdb.ts    connection setup, local or bucket
src/sync.ts      mirror the bucket into ./data
src/server.ts    Bun.serve routes
static/index.html  the whole UI
scripts/setup.sh   preflight check
```

The data, locally or under a bucket prefix:

```
data/
├── interleaved/
│   ├── label_change_diffs/     *.parquet
│   └── label_section_versions/ *.parquet
├── FDA_SPL/
└── DRUGS_AT_FDA/
```

A mode appears in the picker only if its `label_change_diffs` is present, so the app runs on a subset. `label_section_versions` is optional; without it the full-text tabs are hidden.

## Dependencies

`duckdb-async`, and nothing else. The HTTP server is `Bun.serve`, and the page is plain HTML, CSS and JavaScript with no framework, bundler or CDN. Bun runs the TypeScript directly, so there is no build step.

## Using it

**Source.** The three buttons are the three comparison modes. Interleaved puts Drugs@FDA and FDA SPL on one timeline, so a head from one source can be diffed against whichever version actually preceded it. The single-source modes restrict the comparison to that source. Hover a button for its row, drug and lineage counts.

**Search.** Type any part of a drug name or a drug key. Matches are ranked name-prefix first, then key-prefix, then substring. Arrow keys and Enter work; several spellings of one drug collapse to a single suggestion, since each source names drugs its own way.

**Reading a result.** A drug key can hold more than one lineage, because an application usually carries several SPL sets, one per labeler or repackager, each with an independent revision history. Each lineage is a collapsible panel with its own metadata and its changed sections. The newest is expanded on load.

Each lineage shows the full `_meta` struct. Every identifier is a key/value pair whose key names the source field it came from, so a `submission` and a `version_number` stay distinguishable when a comparison straddles the two sources. Such a comparison is tagged `cross-source`; those rows are noisier than same-source ones, because Drugs@FDA text is parsed out of PDFs and SPL text out of XML, so part of what they report is the gap between the two parsers.

**Reading a diff.** Removed words are red and struck through, added words are green. A long unchanged run collapses to `… N unchanged words …`; the pipeline keeps 250 words of context on each side of a change. The `distance` chip is a word-level Levenshtein distance, so it rises with dissimilarity and is not a percentage.

**Full section text.** Each section has `Diff`, `Before` and `After` tabs. `Before` and `After` show that section's complete text in the baseline and head versions, pulled from `label_section_versions` and stamped with the source, version label, date and drug category it came from. The fetch is lazy and happens once per lineage. A section absent from a version says so rather than rendering blank, which is worth noticing: a whole-section appearance or disappearance is a common artifact rather than a real editorial change.

The two tables join on `label_version_id`, which is `spl_id` for SPL and the `submissions` string for Drugs@FDA, together with the version's own source id, the set id for SPL and the application for Drugs@FDA. That key is unique for SPL. It is not always unique for Drugs@FDA, because one submission set can have produced several label PDFs: 1,986 keys are affected and 446 of those carry genuinely different text. The app resolves them by newest `as_of_date` then highest `version_ordinal`, and marks the panel `1 of N label PDFs for this submission` so a resolved ambiguity is never silent.

## Notes

Each mode is exposed as a DuckDB view over its parquet, plus a small in-memory index of `(drug_key, drug_name)` so typeahead does not rescan diff text on every keystroke. Startup builds those indexes, which is the slow part when reading the bucket.

Counts are cast to `INT` and dates to `VARCHAR` in SQL, so the driver hands back plain numbers and strings rather than BigInt and Date. Queries are parameterized; the paths and the HMAC secret are inlined only where DuckDB accepts no bound parameter (`CREATE VIEW`, `CREATE SECRET`), with quotes escaped.

The server binds to localhost by default. It is a dev tool, not a deployment.
