/**
 * Opening a DuckDB connection that can reach the data, wherever it lives.
 *
 * A bucket is read over DuckDB's S3-compatible path, so one GCS HMAC key pair is the
 * whole authentication story: no cloud SDK, no application default credentials.
 */

import { Database } from "duckdb-async";

import { hmacCredentials, isRemote, missingHmacMessage, sqlLiteral } from "./config.ts";

/**
 * Open an in-memory database, configured for the given data location.
 *
 * @param location A local directory or a bucket prefix
 * @returns The ready connection
 * @throws When the location is a bucket and the HMAC credentials are absent
 */
export async function openDatabase(location: string): Promise<Database> {
  const database = await Database.create(":memory:");

  if (!isRemote(location)) return database;

  await database.exec("INSTALL httpfs");

  await database.exec("LOAD httpfs");

  const credentials = hmacCredentials();

  if (!credentials) throw new Error(missingHmacMessage(location));

  // CREATE SECRET takes no bound parameters, so the values are inlined as quoted
  // literals. TYPE GCS points DuckDB at the S3-compatible endpoint for the bucket.
  await database.exec(
    "CREATE OR REPLACE SECRET label_diffs_gcs (TYPE GCS, KEY_ID " +
      `${sqlLiteral(credentials.keyId)}, SECRET ${sqlLiteral(credentials.secret)})`,
  );

  // Parquet footers and column chunks arrive by range request, so caching the
  // per-file metadata keeps repeated point lookups from re-reading them.
  for (const statement of [
    "SET enable_http_metadata_cache=true",
    "SET enable_object_cache=true",
  ]) {
    try {
      await database.exec(statement);
    } catch {
      // Only a speedup; some builds do not expose the setting.
    }
  }

  return database;
}
