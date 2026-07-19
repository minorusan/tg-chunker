// Vector clustering — the "vector proposes" half of entity merging.
//
// THE IDEA IN ONE LINE: names that mean the same person sit CLOSE in meaning-space, even when they
// share no letters ("Саша" and "Александр" are near each other; "Байдо Саша" and "Байдо старший" too).
// So we turn every person into a vector, group the ones that are close, and hand each group to the LLM
// to make the final "same person? yes/no" call. Vector = cheap grouping (recall). LLM = the decision
// (precision). We cluster LOOSELY on purpose — a few wrong neighbours are fine because the LLM throws
// them out; a missed neighbour is not, because then two spellings of one person never get compared.
//
// Everything here is a few lines of plain maths + one local Ollama call. No libraries.

const EMBED_MODEL = 'nomic-embed-text'; // small local embedding model (already on the box for Maradel)

/** Turn each text into a vector (a list of numbers) using the local embedding model. One batched call. */
export async function embed(ollamaIp: string, texts: string[]): Promise<number[][]> {
  const res = await fetch(`http://${ollamaIp}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`ollama /api/embed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  if (!body.embeddings) throw new Error('no embeddings in response');
  return body.embeddings;
}

/** How similar two vectors are, from -1 (opposite) to 1 (identical). Just the angle between them. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/**
 * Group vectors that are close together. Any two vectors closer than `threshold` are put in the same
 * group; groups are the "islands" you get once you connect all the close pairs (classic union-find).
 * Returns the groups as lists of the ORIGINAL indices, so the caller knows which people ended up together.
 * Only groups with 2+ members are worth anything (a lone person has no one to merge with).
 */
export function clusterByVector(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);      // each starts as its own island
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (cosine(vectors[i], vectors[j]) >= threshold) union(i, j); // close enough → same island

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
  }
  return [...groups.values()].filter((g) => g.length > 1);        // only groups that actually group something
}
