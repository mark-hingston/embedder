import { ChunkingOptions } from "./chunkOptions.js";

/**
 * Defines a structure to hold specific chunking configurations
 * for different categories of file types.
 */
export interface FileTypeChunkingOptions {
  code: ChunkingOptions;
  html: ChunkingOptions;
  json: ChunkingOptions;
  markdown: ChunkingOptions;
  text: ChunkingOptions;
}

/**
 * Default chunking options used if no specific overrides are provided.
 * These leverage different strategies from `@mastra/rag`.
 * Values for size and overlap are sourced from environment variables,
 * with sensible fallbacks if not set.
 */

const envChunkSize = parseInt(process.env.DEFAULT_CHUNK_SIZE || "32000", 10);
const envChunkOverlap = parseInt(process.env.DEFAULT_CHUNK_OVERLAP || "1000", 10);

const defaultSize = !isNaN(envChunkSize) && envChunkSize > 0 ? envChunkSize : 32000;
const defaultOverlap = !isNaN(envChunkOverlap) && envChunkOverlap >= 0 ? envChunkOverlap : 1000;

if (isNaN(envChunkSize) || envChunkSize <= 0) {
    console.warn(`Invalid or missing DEFAULT_CHUNK_SIZE environment variable. Using default: ${defaultSize}`);
}
if (isNaN(envChunkOverlap) || envChunkOverlap < 0) {
    console.warn(`Invalid or missing DEFAULT_CHUNK_OVERLAP environment variable. Using default: ${defaultOverlap}`);
}


export const DEFAULT_CHUNKING_OPTIONS: FileTypeChunkingOptions = {
  code: { strategy: "recursive", size: defaultSize, overlap: defaultOverlap, separator: "\n" },
  html: { strategy: "html", size: defaultSize },
  json: { strategy: "json", maxSize: defaultSize },
  markdown: { strategy: "markdown", size: defaultSize },
  text: { strategy: "recursive", size: defaultSize, overlap: defaultOverlap }
};