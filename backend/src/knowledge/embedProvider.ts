// ---------------------------------------------------------------------------
// Embedding provider — a thin, OpenAI-`/embeddings`-compatible HTTP client
// (the shape most providers, including OpenAI itself, share). Uses the same
// global-`fetch` + `AbortSignal.timeout()` convention already established for
// the GPS route planner's Valhalla/Overpass calls and Automation Hub's
// http_request action — no new HTTP client dependency.
//
// Deliberately separate from OpenRouter's chat proxy (aiTools.ts /
// routes/ai.ts): OpenRouter does not uniformly expose an embeddings endpoint
// across its models, so this reads its OWN key/base URL/model, configurable
// independently in Settings → Knowledge Search (app_settings), falling back
// to OPENROUTER_API_KEY only as a convenience so a single key can cover both
// when the user points EMBEDDING_BASE_URL at a provider that supports it.
// ---------------------------------------------------------------------------

export interface EmbeddingProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface KnowledgeAppSettings {
  knowledge_search_enabled?: string;
  embedding_base_url?: string;
  embedding_model?: string;
  embedding_monthly_token_budget?: string;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'text-embedding-3-small';

/** Resolve the active embedding config, or null when the feature is unavailable/disabled — callers must treat null as "skip, don't error". */
export function getEmbeddingConfig(settings: KnowledgeAppSettings): EmbeddingProviderConfig | null {
  if (settings.knowledge_search_enabled === 'false') return null;
  const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (settings.embedding_base_url || process.env.EMBEDDING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = settings.embedding_model || process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
  return { baseUrl, apiKey, model };
}

export class EmbeddingProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'EmbeddingProviderError';
  }
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

/** Embed a batch of texts, preserving input order regardless of what order the provider returns them in. */
export async function embedTexts(texts: string[], config: EmbeddingProviderConfig): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${config.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new EmbeddingProviderError(`Embedding provider returned ${res.status}`, res.status);
  }
  const data = (await res.json()) as EmbeddingsResponse;
  const out: number[][] = new Array(texts.length);
  for (const item of data.data) out[item.index] = item.embedding;
  return out;
}

/** Format a JS number array as a pgvector text literal for a `$n::vector` cast — no ORM/driver support needed. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
