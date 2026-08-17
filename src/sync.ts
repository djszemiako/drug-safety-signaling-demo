/**
 * Mirror the parquet from the bucket into a local directory, so the viewer queries
 * local files instead of issuing range requests over the network.
 *
 * DuckDB does the whole job: `glob` lists the objects and `COPY ... TO` rewrites each
 * one locally, which means the same HMAC key pair the viewer already needs is the only
 * credential involved. The copies are re-encoded rather than byte-identical, so this
 * is a cache rather than an archive; rows, schema and nested structs are preserved.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_DATA_LOCATION,
  DIFFS_TABLE_KEY,
  LOCAL_DATA_DIR,
  MODES,
  VERSIONS_TABLE_KEY,
  argValue,
  isRemote,
  joinLocation,
  sqlLiteral,
} from "./config.ts";
import { openDatabase } from "./duckdb.ts";

interface SyncOptions {
  readonly source: string;
  readonly destination: string;
  readonly onlyDiffs: boolean;
  readonly force: boolean;
}

export interface SyncResult {
  copied: number;
  skipped: number;
}

/**
 * Copy every parquet file under a bucket prefix into a local directory.
 *
 * @param options Where to read from, where to write to, whether to skip the large
 *   versions tables, and whether to overwrite files already present
 * @returns How many files were copied and how many were already there
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  const database = await openDatabase(options.source);

  const result: SyncResult = { copied: 0, skipped: 0 };

  try {
    const tables = options.onlyDiffs
      ? [DIFFS_TABLE_KEY]
      : [DIFFS_TABLE_KEY, VERSIONS_TABLE_KEY];

    for (const { mode } of MODES) {
      for (const table of tables) {
        const pattern = joinLocation(options.source, mode, table, "*.parquet");

        const rows = await database.all(
          `SELECT file FROM glob(${sqlLiteral(pattern)}) ORDER BY file`,
        );

        if (rows.length === 0) continue;

        console.log(`${mode}/${table}: ${rows.length} files`);

        let done = 0;

        for (const row of rows) {
          const source = String(row.file);

          const name = source.slice(source.lastIndexOf("/") + 1);

          const destination = join(options.destination, mode, table, name);

          if (!options.force && (await Bun.file(destination).exists())) {
            result.skipped += 1;
          } else {
            await mkdir(dirname(destination), { recursive: true });

            // One file at a time, so peak memory follows the largest single part
            // rather than the whole table.
            await database.exec(
              `COPY (SELECT * FROM read_parquet(${sqlLiteral(source)})) ` +
                `TO ${sqlLiteral(destination)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
            );

            result.copied += 1;
          }

          done += 1;

          process.stdout.write(`\r  ${done}/${rows.length}`);
        }

        process.stdout.write("\n");
      }
    }
  } finally {
    await database.close();
  }

  return result;
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);

  const source = argValue(argv, "--data") ?? DEFAULT_DATA_LOCATION;

  const destination = argValue(argv, "--dest") ?? LOCAL_DATA_DIR;

  if (!isRemote(source)) {
    console.error(`--data must be a bucket URI, got ${source}`);

    process.exit(2);
  }

  console.log(`Mirroring ${source} -> ${destination}`);

  try {
    const result = await sync({
      source,
      destination,
      onlyDiffs: argv.includes("--diffs-only"),
      force: argv.includes("--force"),
    });

    console.log(`Copied ${result.copied}, already present ${result.skipped}`);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);

    process.exit(1);
  }
}
