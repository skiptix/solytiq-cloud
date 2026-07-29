// ---------------------------------------------------------------------------
// Whether the `vector` extension (pgvector) is available on this Postgres
// instance. Set once, at startup, by runMigrations() in index.ts after it
// attempts `CREATE EXTENSION IF NOT EXISTS vector` — a plain Postgres 16 image
// (rather than pgvector/pgvector:pg16) doesn't ship the extension, so this
// must degrade gracefully rather than crash the whole app. Every knowledge/
// module checks this flag before touching entity_chunks.embedding or issuing
// a `<=>` similarity query; when false, search silently falls back to
// trigram-only (see knowledge/search.ts) and the embedding worker never calls
// out to a provider.
// ---------------------------------------------------------------------------

let available = false;

export function setPgvectorAvailable(value: boolean): void {
  available = value;
}

export function isPgvectorAvailable(): boolean {
  return available;
}

/** The embedding dimensionality this schema is fixed to (OpenAI/most providers' small models). Changing this requires a new column + re-embed, not a live migration. */
export const EMBEDDING_DIMENSIONS = 1536;
