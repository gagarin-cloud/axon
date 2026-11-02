import { env, type FeatureExtractionPipeline, ModelFileNotFoundError, pipeline } from "@huggingface/transformers";
import type { EmbedDtype } from "../config.js";
import type { Embedder } from "./embedder.js";

const QUERY_TASK = "Given a question or keywords about a software project, retrieve project memories that answer it";

/**
 * Local ONNX embedder (default: Qwen3-Embedding-0.6B). Qwen3 is asymmetric: queries carry an
 * instruction prefix, documents are embedded raw, and the sentence vector is the last token's state.
 *
 * Texts are encoded one at a time: last-token pooling reads position -1, which in a padded batch
 * can land on a pad token.
 */
export class TransformersEmbedder implements Embedder {
  readonly id: string;
  private extractor?: Promise<FeatureExtractionPipeline>;
  private dim?: number;
  // ONNX sessions are not re-entrant; serialise calls.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly model: string,
    private readonly dtype: EmbedDtype,
    cacheDir: string,
  ) {
    this.id = `${model}@${dtype}`;
    env.cacheDir = cacheDir;
  }

  async dimension(): Promise<number> {
    if (this.dim === undefined) this.dim = (await this.embed("dimension probe")).length;
    return this.dim;
  }

  embedQuery(text: string): Promise<number[]> {
    return this.embed(`Instruct: ${QUERY_TASK}\nQuery:${text}`);
  }

  embedDocument(text: string): Promise<number[]> {
    return this.embed(text);
  }

  /** Loads the model now instead of on first use. */
  async warmup(): Promise<void> {
    await this.dimension();
  }

  private embed(text: string): Promise<number[]> {
    const run = this.queue.then(async () => {
      const extractor = await this.load();
      const out = await extractor(text, { pooling: "last_token", normalize: true });
      return Array.from(out.data as Float32Array);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Local first: with the model in `cacheDir` (baked into the image, or downloaded earlier) the
   * load touches neither the network nor the disk, so it works offline on a read-only filesystem,
   * and an optional file the library asks for is simply absent rather than fetched. Only a missing
   * required file falls back to downloading — the first run, `axon warmup`. (The per-call
   * `local_files_only` option is not honoured for the config in transformers.js 4.3, hence `env`.)
   */
  private load(): Promise<FeatureExtractionPipeline> {
    this.extractor ??= (async () => {
      env.allowRemoteModels = false;
      try {
        return await this.pipeline();
      } catch (err) {
        if (!(err instanceof ModelFileNotFoundError)) throw err;
        env.allowRemoteModels = true;
        return this.pipeline();
      }
    })();
    return this.extractor;
  }

  private pipeline(): Promise<FeatureExtractionPipeline> {
    return pipeline("feature-extraction", this.model, { dtype: this.dtype }) as Promise<FeatureExtractionPipeline>;
  }
}
