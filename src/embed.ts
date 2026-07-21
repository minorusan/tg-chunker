// Embeddings + cosine + top-k — the semantic-retrieval core (HW2).
//
// Note the irony: we first reached for this to MERGE names and it failed — the local embedder can't
// tell "Саша" from "Александр". But that was the wrong job. THIS is the right one: finding which chunk
// is about a topic. nomic-embed-text is a retrieval model; topic-similarity is exactly what it's good at.
//
// nomic is ASYMMETRIC: documents and queries are embedded with different prefixes so a short question
// lands near the long passage that answers it. We honour that — it materially improves the ranking.

const EMBED_MODEL = 'nomic-embed-text';

async function embedRaw(ollamaIp: string, inputs: string[]): Promise<number[][]> {
  const res = await fetch(`http://${ollamaIp}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama /api/embed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  if (!body.embeddings) throw new Error('no embeddings in response');
  return body.embeddings;
}

/** Embed CHUNKS (the passages we store). Prefixed as documents. */
export const embedDocuments = (ollamaIp: string, texts: string[]) =>
  embedRaw(ollamaIp, texts.map((t) => `search_document: ${t}`));

/** Embed a QUERY (the user's question). Prefixed as a query so it lands near the answering document. */
export const embedQuery = async (ollamaIp: string, text: string) =>
  (await embedRaw(ollamaIp, [`search_query: ${text}`]))[0];

/** Cosine similarity: how aligned two vectors are, 0..1 for embeddings (higher = more similar). */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Brute-force top-k: score the query against every stored vector, return the k best.
 *  Exact (no approximation) and instant for hundreds/thousands of chunks — FAISS would be overkill. */
export function topK(queryVec: number[], vectors: number[][], k: number): Array<{ index: number; score: number }> {
  return vectors
    .map((v, index) => ({ index, score: cosine(queryVec, v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
