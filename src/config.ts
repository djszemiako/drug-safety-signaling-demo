/**
 * Shared configuration: where the data lives, how credentials are found, and the
 * vocabulary the two parquet tables share.
 */

import { existsSync } from "node:fs";

/** Bucket prefix the demo data is published to. */
export const DEFAULT_DATA_LOCATION = "gs://monaco-dev-bucket/drug-safety-signaling-demo";

/** Local directory `sync` downloads into, and the default when it exists. */
export const LOCAL_DATA_DIR = "./data";

export const DATA_LOCATION_ENVVAR = "LABEL_DIFFS_DATA";

export const DIFFS_TABLE_KEY = "label_change_diffs";

export const VERSIONS_TABLE_KEY = "label_section_versions";

/**
 * GCS interoperability (HMAC) credentials. The AWS names are accepted too, because
 * that is how HMAC keys are usually exported for S3-compatible clients.
 */
export const HMAC_KEY_ID_ENVVARS = ["LABEL_DIFFS_HMAC_KEY_ID", "AWS_ACCESS_KEY_ID"] as const;

export const HMAC_SECRET_ENVVARS = [
  "LABEL_DIFFS_HMAC_SECRET",
  "AWS_SECRET_ACCESS_KEY",
] as const;

export const REMOTE_URI_SCHEMES = ["gs://", "gcs://", "s3://"] as const;

export interface ModeDefinition {
  readonly mode: string;
  readonly label: string;
}

/** Directory name under the data location, and how it is shown in the picker. */
export const MODES: readonly ModeDefinition[] = [
  { mode: "interleaved", label: "Interleaved" },
  { mode: "FDA_SPL", label: "FDA SPL" },
  { mode: "DRUGS_AT_FDA", label: "Drugs@FDA" },
];

/** `label_section_versions` column paired with the Title Case name the diffs use. */
export const SECTION_COLUMNS: readonly (readonly [string, string])[] = [
  ["boxed_warning", "Boxed Warning"],
  ["contraindications", "Contraindications"],
  ["warnings_and_precautions", "Warnings and Precautions"],
  ["adverse_reactions", "Adverse Reactions"],
  ["drug_interactions", "Drug Interactions"],
];

export const SECTION_ORDER: readonly string[] = SECTION_COLUMNS.map(([, title]) => title);

export const MAX_SUGGESTIONS = 25;

/** Report whether a data location is an object-store URI rather than a local path. */
export function isRemote(location: string): boolean {
  return REMOTE_URI_SCHEMES.some((scheme) => location.startsWith(scheme));
}

/**
 * Join location segments with forward slashes, which both local paths and bucket URIs
 * accept.
 */
export function joinLocation(...parts: string[]): string {
  const head = parts.slice(0, -1).map((part) => part.replace(/\/+$/, ""));

  return [...head, parts[parts.length - 1]].join("/");
}

/** Quote a value as a SQL string literal, doubling any embedded quote. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Return the first environment variable in `names` that is set and non-empty. */
export function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];

    if (value) return value;
  }

  return undefined;
}

export interface HmacCredentials {
  readonly keyId: string;
  readonly secret: string;
}

/**
 * Resolve the HMAC key pair from the environment.
 *
 * @returns The credentials, or undefined when either half is missing
 */
export function hmacCredentials(): HmacCredentials | undefined {
  const keyId = firstEnv(HMAC_KEY_ID_ENVVARS);

  const secret = firstEnv(HMAC_SECRET_ENVVARS);

  if (!keyId || !secret) return undefined;

  return { keyId, secret };
}

/** Human-readable instruction for the missing-credentials case. */
export function missingHmacMessage(location: string): string {
  return (
    `${location} needs GCS HMAC credentials. Set ` +
    `${HMAC_KEY_ID_ENVVARS[0]} and ${HMAC_SECRET_ENVVARS[0]} ` +
    `(or ${HMAC_KEY_ID_ENVVARS[1]} and ${HMAC_SECRET_ENVVARS[1]}).`
  );
}

/**
 * Read a `--flag value` pair out of argv.
 *
 * @param argv The argument list to scan
 * @param flag The flag to look for
 * @returns The value that followed the flag, or undefined
 */
export function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);

  if (index === -1 || index === argv.length - 1) return undefined;

  return argv[index + 1];
}

/**
 * Decide where to read data from: an explicit `--data`, then the environment, then a
 * local `./data` if it exists, and finally the published bucket.
 *
 * @param argv The process arguments
 * @returns The resolved data location
 */
export async function resolveDataLocation(argv: string[]): Promise<string> {
  const explicit = argValue(argv, "--data") ?? process.env[DATA_LOCATION_ENVVAR];

  if (explicit) return explicit;

  if (existsSync(`${LOCAL_DATA_DIR}/interleaved/${DIFFS_TABLE_KEY}`)) return LOCAL_DATA_DIR;

  return DEFAULT_DATA_LOCATION;
}
