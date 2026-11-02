import { readFileSync } from "node:fs";

/**
 * axon's version, from package.json, so a release bump can't leave the MCP handshake or export
 * documents behind. The path holds from both src/ (tsx) and dist/ (build), and the image ships
 * package.json next to dist/.
 */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
