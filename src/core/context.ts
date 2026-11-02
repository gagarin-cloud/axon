import type { Config } from "../config.js";
import type { Embedder } from "../embed/embedder.js";
import type { PgStore } from "../store/pg.js";
import type { Memory, SearchHit } from "../store/types.js";
import { contentTokens, embeddingText } from "./content.js";
import { AxonError } from "./errors.js";
import type { Hit } from "./views.js";

/** Suggestions this close below the duplicate threshold are flagged as likely overlaps. */
const OVERLAP_MARGIN = 0.1;

/** What every use case runs against, and the lookups they share. */
export class ServiceContext {
  constructor(
    readonly store: PgStore,
    readonly embedder: Embedder,
    readonly config: Config,
  ) {}

  async requireProject(slug: string): Promise<string> {
    const project = await this.store.getProject(slug);
    if (!project) throw new AxonError("not_found", `Project ${slug} has no memories yet.`);
    return project.id;
  }

  async requireMemory(projectId: string, seq: number, slug: string): Promise<Memory> {
    const [memory] = await this.store.getMemories(projectId, [seq]);
    if (!memory) throw new AxonError("not_found", `#${seq} not found in ${slug}`);
    return memory;
  }

  /** Memories by seq; missing seqs are absent. */
  async memoryMap(projectId: string, seqs: number[]): Promise<Map<number, Memory>> {
    return new Map((await this.store.getMemories(projectId, seqs)).map((m) => [m.seq, m]));
  }

  /** Search hits with their memories, in hit order. */
  async loadHits(projectId: string, found: SearchHit[]): Promise<Hit[]> {
    const bySeq = await this.memoryMap(
      projectId,
      found.map((h) => h.seq),
    );
    return found.flatMap((h) => {
      const memory = bySeq.get(h.seq);
      return memory ? [{ memory, similarity: h.similarity, keyword: h.keyword }] : [];
    });
  }

  /**
   * Records what an agent read in full (it feeds ranking), and strengthens the links it followed to
   * get there (Hebbian). Briefings don't record reads: pinned memories would always look read.
   */
  async recordRead(projectId: string, read: number[], followed: [number, number][] = []): Promise<void> {
    await this.store.touch(projectId, read);
    await this.store.reinforce(projectId, followed);
  }

  /** What every write of a memory's text needs: its document embedding and its size. */
  async prepareContent(title: string, body: string): Promise<{ embedding: number[]; tokens: number }> {
    return {
      embedding: await this.embedder.embedDocument(embeddingText(title, body)),
      tokens: contentTokens(title, body),
    };
  }

  /**
   * Similarity at which two memories are probably the same fact reworded: just under the duplicate
   * threshold. `remember` flags new writes above it as likely overlaps, and `review` lists existing pairs
   * above it. Derived from the dedup threshold rather than the link-suggest one, because same-topic facts
   * score only a little above link-suggest (~0.6 under Qwen3) and would bury real duplicates in neighbours.
   */
  get overlapFloor(): number {
    return this.config.dedupSimilarity - OVERLAP_MARGIN;
  }
}
