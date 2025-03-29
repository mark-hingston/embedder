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
  text: ChunkingOptions; // Default/fallback for other text types
}

/**
 * Default chunking options used if no specific overrides are provided.
 * These leverage different strategies from `@mastra/rag`.
 */
export const DEFAULT_CHUNKING_OPTIONS: FileTypeChunkingOptions = {
  // Recursive strategy is often good for code, splitting by lines/blocks.
  code: { strategy: "recursive", size: 512, overlap: 50, separator: "\n" },
  // HTML strategy understands HTML structure.
  html: { strategy: "html", size: 500 }, // Size might relate to characters within tags
  // JSON strategy handles JSON structure, maxSize prevents overly large chunks.
  json: { strategy: "json", maxSize: 512 },
  // Markdown strategy understands Markdown structure (headers, paragraphs).
  markdown: { strategy: "markdown", size: 512 },
  // Recursive strategy is a general-purpose fallback for plain text.
  text: { strategy: "recursive", size: 512, overlap: 50 }
};