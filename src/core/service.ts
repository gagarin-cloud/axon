import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import type { Embedder } from "../embed/embedder.js";
import { checkEmbeddingModel, openCodec } from "../store/bindings.js";
import { PgStore } from "../store/pg.js";
import { briefing } from "./briefing.js";
import { ServiceContext } from "./context.js";
import { get, listProjects, related, search } from "./reads.js";
import { remember } from "./remember.js";
import { review } from "./review.js";
import type {
  BriefingInput,
  DeleteProjectInput,
  ExportInput,
  GetInput,
  ImportInput,
  LinkInput,
  RelatedInput,
  RememberInput,
  ReviewInput,
  SearchInput,
  UpdateInput,
} from "./schemas.js";
import { exportProject, importProject } from "./transfer.js";
import { deleteProject, link, update } from "./writes.js";

export type { BriefingResult } from "./briefing.js";
export { LARGE_MEMORY_TOKENS } from "./content.js";
export { AxonError, type ErrorCode } from "./errors.js";
export type { GetResult, ProjectsResult, RelatedResult, SearchResult } from "./reads.js";
export type { RememberResult } from "./remember.js";
export type { ReviewResult } from "./review.js";
export type { ExportResult, ImportResult } from "./transfer.js";
export type { MemoryView, Shown } from "./views.js";
export type { DeleteProjectResult, LinkResult, UpdateResult } from "./writes.js";

/** How long a readiness probe waits for the database before calling it down. */
const PING_TIMEOUT_MS = 2000;

/**
 * Axon's domain logic, independent of transport: the one entry point MCP, REST and the CLI call.
 * Every read that returns memory content is packed to a token budget; every result carries
 * structured data plus a compact `text` rendering for agents. Each use case lives in its own
 * module (briefing, reads, writes, review, transfer) and runs against a shared ServiceContext.
 */
export class AxonService {
  private constructor(private readonly ctx: ServiceContext) {}

  static async create(sql: Sql, embedder: Embedder, config: Config): Promise<AxonService> {
    const dim = await embedder.dimension();
    await checkEmbeddingModel(sql, embedder.id, dim);
    const store = new PgStore(sql, dim, await openCodec(sql, config.encryptionKey));
    return new AxonService(new ServiceContext(store, embedder, config));
  }

  get embedderId(): string {
    return this.ctx.embedder.id;
  }

  /** Resolves if the database answers `SELECT 1` within 2 seconds; rejects otherwise. */
  ping(): Promise<void> {
    return this.ctx.store.ping(PING_TIMEOUT_MS);
  }

  // ── reads ──

  listProjects() {
    return listProjects(this.ctx);
  }

  briefing(input: BriefingInput) {
    return briefing(this.ctx, input);
  }

  search(input: SearchInput) {
    return search(this.ctx, input);
  }

  get(input: GetInput) {
    return get(this.ctx, input);
  }

  related(input: RelatedInput) {
    return related(this.ctx, input);
  }

  // ── writes ──

  remember(input: RememberInput) {
    return remember(this.ctx, input);
  }

  update(input: UpdateInput) {
    return update(this.ctx, input);
  }

  link(input: LinkInput) {
    return link(this.ctx, input);
  }

  deleteProject(input: DeleteProjectInput) {
    return deleteProject(this.ctx, input);
  }

  // ── housekeeping, export and import ──

  review(input: ReviewInput) {
    return review(this.ctx, input);
  }

  exportProject(input: ExportInput) {
    return exportProject(this.ctx, input);
  }

  importProject(input: ImportInput) {
    return importProject(this.ctx, input);
  }
}
