/**
 * DuckDB-backed reader over the per-mode parquet.
 *
 * Each mode becomes a view, plus a small in-memory autocomplete index so typeahead
 * does not rescan the diff text on every keystroke. Dates are cast to text in SQL so
 * they cross into JSON without a timezone round trip, and counts are cast to INT so
 * the driver does not hand back BigInt.
 */

import type { Database } from "duckdb-async";

import {
  DIFFS_TABLE_KEY,
  MAX_SUGGESTIONS,
  MODES,
  SECTION_COLUMNS,
  SECTION_ORDER,
  VERSIONS_TABLE_KEY,
  joinLocation,
  sqlLiteral,
} from "./config.ts";
import { openDatabase } from "./duckdb.ts";

export interface ModeSummary {
  mode: string;
  label: string;
  n_diffs: number;
  n_drugs: number;
  n_lineages: number;
}

export interface Suggestion {
  drug_key: string;
  drug_name: string | null;
  drug_names: string[];
  n_diffs: number;
  n_lineages: number;
  latest_date: string | null;
}

export interface KeyValue {
  key: string | null;
  value: string | null;
}

export interface LineageMeta {
  source: string | null;
  baseline_source: string | null;
  cross_source: boolean;
  version: KeyValue;
  baseline_version: KeyValue;
  label_version_id: KeyValue;
  baseline_label_version_id: KeyValue;
}

export interface SectionDiff {
  section: string;
  diff_text: string | null;
  n_words_added: number | null;
  n_words_removed: number | null;
  similarity: number | null;
  semantic_diff: boolean | null;
}

export interface Lineage {
  set_id: string | null;
  application_numbers: string[];
  drug_name: string | null;
  date: string | null;
  baseline_date: string | null;
  run_id: string | null;
  meta: LineageMeta;
  sections: SectionDiff[];
}

export interface DrugDetail {
  drug_key: string;
  drug_names: string[];
  lineages: Lineage[];
  has_section_text: boolean;
}

export interface VersionSections {
  source: string;
  label_version_id: string;
  version_label: string | null;
  as_of_date: string | null;
  drug_name: string | null;
  drug_category: string | null;
  n_candidates: number;
  sections: Record<string, string | null>;
}

export interface LineageSectionText {
  head: VersionSections | null;
  baseline: VersionSections | null;
}

/** Coerce whatever the driver returns for a numeric column into a JS number. */
function toNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);

  return Number(value ?? 0);
}

/** Coerce a nullable numeric column, preserving null. */
function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  return toNumber(value);
}

/** Coerce a nullable string column, preserving null. */
function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  return String(value);
}

export class DiffStore {
  private readonly location: string;

  private database!: Database;

  /** Modes whose diffs parquet was found, in MODES order. */
  public availableModes: string[] = [];

  /** Modes that also have label_section_versions, so can serve full section text. */
  public sectionTextModes = new Set<string>();

  private constructor(location: string) {
    this.location = location.replace(/\/+$/, "");
  }

  /**
   * Open a store over a data location.
   *
   * @param location A local directory or a bucket prefix
   * @returns The ready store, with its views and indexes built
   */
  static async open(location: string): Promise<DiffStore> {
    const store = new DiffStore(location);

    store.database = await openDatabase(store.location);

    await store.registerModes();

    return store;
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  /** Create one view and one autocomplete index per mode that has parquet on disk. */
  private async registerModes(): Promise<void> {
    for (const { mode } of MODES) {
      const diffsGlob = joinLocation(this.location, mode, DIFFS_TABLE_KEY, "*.parquet");

      if (!(await this.hasParquet(diffsGlob))) continue;

      const versionsGlob = joinLocation(this.location, mode, VERSIONS_TABLE_KEY, "*.parquet");

      if (await this.hasParquet(versionsGlob)) {
        await this.database.exec(
          `CREATE VIEW ${this.versionsView(mode)} AS ` +
            `SELECT * FROM read_parquet(${sqlLiteral(versionsGlob)})`,
        );

        this.sectionTextModes.add(mode);
      }

      const view = this.diffsView(mode);

      await this.database.exec(
        `CREATE VIEW ${view} AS SELECT * FROM read_parquet(${sqlLiteral(diffsGlob)})`,
      );

      // One row per (drug_key, drug_name). A key can carry several spellings because
      // each source names the drug its own way, and all should be searchable.
      await this.database.exec(`
        CREATE TABLE ${view}_index AS
        SELECT
            drug_key,
            drug_name,
            lower(coalesce(drug_name, '')) AS drug_name_lower,
            lower(drug_key) AS drug_key_lower,
            count(*)::INT AS n_diffs,
            count(DISTINCT coalesce(set_id, ''))::INT AS n_lineages,
            max(date)::VARCHAR AS latest_date
        FROM ${view}
        GROUP BY 1, 2
      `);

      this.availableModes.push(mode);
    }
  }

  /**
   * Report whether any file matches, using DuckDB's own glob so local paths and bucket
   * URIs are checked the same way. A credential or network failure propagates, since
   * treating it as an absent mode would hide the real problem behind an empty picker.
   */
  private async hasParquet(globPattern: string): Promise<boolean> {
    const rows = await this.database.all(
      `SELECT count(*)::INT AS n FROM glob(${sqlLiteral(globPattern)})`,
    );

    return toNumber(rows[0]?.n) > 0;
  }

  private diffsView(mode: string): string {
    return `diffs_${mode.replace(/[^0-9A-Za-z_]/g, "_")}`;
  }

  private versionsView(mode: string): string {
    return `versions_${mode.replace(/[^0-9A-Za-z_]/g, "_")}`;
  }

  /** Summarize every available mode for the mode picker. */
  async modeSummaries(): Promise<ModeSummary[]> {
    const summaries: ModeSummary[] = [];

    for (const { mode, label } of MODES) {
      if (!this.availableModes.includes(mode)) continue;

      const rows = await this.database.all(`
        SELECT
            count(*)::INT AS n_diffs,
            count(DISTINCT drug_key)::INT AS n_drugs,
            count(DISTINCT (drug_key, coalesce(set_id, '')))::INT AS n_lineages
        FROM ${this.diffsView(mode)}
      `);

      const row = rows[0] ?? {};

      summaries.push({
        mode,
        label,
        n_diffs: toNumber(row.n_diffs),
        n_drugs: toNumber(row.n_drugs),
        n_lineages: toNumber(row.n_lineages),
      });
    }

    return summaries;
  }

  /** Find drugs whose name or key matches, ranked so prefix matches come first. */
  async search(mode: string, query: string): Promise<Suggestion[]> {
    const needle = query.trim().toLowerCase();

    if (!needle) return [];

    const pattern = `%${needle}%`;

    const rows = await this.database.all(
      `
      SELECT
          drug_key,
          arg_min(drug_name, match_rank) AS drug_name,
          list(DISTINCT drug_name) AS drug_names,
          sum(n_diffs)::INT AS n_diffs,
          max(n_lineages)::INT AS n_lineages,
          max(latest_date) AS latest_date
      FROM (
          SELECT
              *,
              CASE
                  WHEN starts_with(drug_name_lower, ?) THEN 0
                  WHEN starts_with(drug_key_lower, ?) THEN 1
                  WHEN drug_name_lower LIKE ? THEN 2
                  ELSE 3
              END AS match_rank
          FROM ${this.diffsView(mode)}_index
          WHERE drug_name_lower LIKE ? OR drug_key_lower LIKE ?
      )
      GROUP BY drug_key
      ORDER BY min(match_rank), lower(arg_min(drug_name, match_rank)), drug_key
      LIMIT ${MAX_SUGGESTIONS}
      `,
      needle,
      needle,
      pattern,
      pattern,
      pattern,
    );

    return rows.map((row) => ({
      drug_key: String(row.drug_key),
      drug_name: toNullableString(row.drug_name),
      drug_names: (row.drug_names ?? []) as string[],
      n_diffs: toNumber(row.n_diffs),
      n_lineages: toNumber(row.n_lineages),
      latest_date: toNullableString(row.latest_date),
    }));
  }

  /** Fetch every diff recorded for one drug key, grouped into its lineages. */
  async drug(mode: string, drugKey: string): Promise<DrugDetail | null> {
    const rows = await this.database.all(
      `
      SELECT
          set_id,
          application_numbers,
          drug_name,
          section,
          date::VARCHAR AS date,
          baseline_date::VARCHAR AS baseline_date,
          diff_text,
          n_words_added,
          n_words_removed,
          similarity,
          semantic_diff,
          run_id,
          _meta.source AS meta_source,
          _meta.baseline_source AS meta_baseline_source,
          _meta.version.key AS version_key,
          _meta.version.value AS version_value,
          _meta.baseline_version.key AS baseline_version_key,
          _meta.baseline_version.value AS baseline_version_value,
          _meta.label_version_id.key AS label_version_id_key,
          _meta.label_version_id.value AS label_version_id_value,
          _meta.baseline_label_version_id.key AS baseline_label_version_id_key,
          _meta.baseline_label_version_id.value AS baseline_label_version_id_value
      FROM ${this.diffsView(mode)}
      WHERE drug_key = ?
      `,
      drugKey,
    );

    if (rows.length === 0) return null;

    const lineages = new Map<string, Lineage>();

    const names = new Set<string>();

    for (const row of rows) {
      const setId = toNullableString(row.set_id);

      if (row.drug_name) names.add(String(row.drug_name));

      const lineageId = setId ?? "";

      let lineage = lineages.get(lineageId);

      if (!lineage) {
        const source = toNullableString(row.meta_source);

        const baselineSource = toNullableString(row.meta_baseline_source);

        lineage = {
          set_id: setId,
          application_numbers: (row.application_numbers ?? []) as string[],
          drug_name: toNullableString(row.drug_name),
          date: toNullableString(row.date),
          baseline_date: toNullableString(row.baseline_date),
          run_id: toNullableString(row.run_id),
          meta: {
            source,
            baseline_source: baselineSource,
            cross_source: Boolean(source && baselineSource && source !== baselineSource),
            version: {
              key: toNullableString(row.version_key),
              value: toNullableString(row.version_value),
            },
            baseline_version: {
              key: toNullableString(row.baseline_version_key),
              value: toNullableString(row.baseline_version_value),
            },
            label_version_id: {
              key: toNullableString(row.label_version_id_key),
              value: toNullableString(row.label_version_id_value),
            },
            baseline_label_version_id: {
              key: toNullableString(row.baseline_label_version_id_key),
              value: toNullableString(row.baseline_label_version_id_value),
            },
          },
          sections: [],
        };

        lineages.set(lineageId, lineage);
      }

      lineage.sections.push({
        section: String(row.section),
        diff_text: toNullableString(row.diff_text),
        n_words_added: toNullableNumber(row.n_words_added),
        n_words_removed: toNullableNumber(row.n_words_removed),
        similarity: toNullableNumber(row.similarity),
        semantic_diff: row.semantic_diff === null ? null : Boolean(row.semantic_diff),
      });
    }

    const sectionRank = (section: string): number => {
      const index = SECTION_ORDER.indexOf(section);

      return index === -1 ? SECTION_ORDER.length : index;
    };

    const ordered = [...lineages.values()].sort((left, right) =>
      (right.date ?? "").localeCompare(left.date ?? "") ||
      (right.set_id ?? "").localeCompare(left.set_id ?? ""),
    );

    for (const lineage of ordered) {
      lineage.sections.sort((left, right) => sectionRank(left.section) - sectionRank(right.section));
    }

    return {
      drug_key: drugKey,
      drug_names: [...names].sort(),
      lineages: ordered,
      has_section_text: this.sectionTextModes.has(mode),
    };
  }

  /** Load the full section text of the two versions one lineage compared. */
  async sectionText(
    mode: string,
    drugKey: string,
    setId: string,
  ): Promise<LineageSectionText | null> {
    if (!this.sectionTextModes.has(mode)) return null;

    const rows = await this.database.all(
      `
      SELECT DISTINCT
          _meta.source AS head_source,
          _meta.label_version_id.value AS head_label_version_id,
          _meta.baseline_source AS baseline_source,
          _meta.baseline_label_version_id.value AS baseline_label_version_id
      FROM ${this.diffsView(mode)}
      WHERE drug_key = ? AND coalesce(set_id, '') = ?
      `,
      drugKey,
      setId,
    );

    const row = rows[0];

    if (!row) return null;

    return {
      head: await this.versionSections(
        mode,
        drugKey,
        setId,
        toNullableString(row.head_source),
        toNullableString(row.head_label_version_id),
      ),
      baseline: await this.versionSections(
        mode,
        drugKey,
        setId,
        toNullableString(row.baseline_source),
        toNullableString(row.baseline_label_version_id),
      ),
    };
  }

  /**
   * Fetch one label version's section text.
   *
   * `label_section_versions` is keyed by the version's own source id, which is the set
   * id for SPL and the application for Drugs@FDA, so the lookup picks whichever
   * matches the side being read.
   */
  private async versionSections(
    mode: string,
    drugKey: string,
    setId: string,
    source: string | null,
    labelVersionId: string | null,
  ): Promise<VersionSections | null> {
    if (!source || !labelVersionId) return null;

    const sourceDrugId = source === "FDA_SPL" ? setId : drugKey;

    const columns = SECTION_COLUMNS.map(([column]) => column).join(", ");

    // A Drugs@FDA submission set can have produced more than one label PDF, so the key
    // is not always unique. Resolve deterministically and report the ambiguity rather
    // than silently showing one of several.
    const rows = await this.database.all(
      `
      SELECT version_label, as_of_date::VARCHAR AS as_of_date, drug_name, drug_category, ${columns}
      FROM ${this.versionsView(mode)}
      WHERE source = ? AND source_drug_id = ? AND label_version_id = ?
      ORDER BY as_of_date DESC, version_ordinal DESC
      `,
      source,
      sourceDrugId,
      labelVersionId,
    );

    const row = rows[0];

    if (!row) return null;

    const sections: Record<string, string | null> = {};

    for (const [column, title] of SECTION_COLUMNS) {
      sections[title] = toNullableString(row[column]);
    }

    return {
      source,
      label_version_id: labelVersionId,
      version_label: toNullableString(row.version_label),
      as_of_date: toNullableString(row.as_of_date),
      drug_name: toNullableString(row.drug_name),
      drug_category: toNullableString(row.drug_category),
      n_candidates: rows.length,
      sections,
    };
  }
}
