import { ChunkStrategy } from "./chunkStrategy.js";

/**
 * Defines the configuration options for a specific chunking strategy.
 * These options are used internally and then mapped to the options
 * expected by the @mastra/rag library.
 */
export interface ChunkingOptions {
  /** The chunking strategy to use (e.g., 'recursive', 'html'). */
  strategy?: ChunkStrategy;
  /** Target size for chunks (interpretation depends on strategy). */
  size?: number;
  /** Number of characters/tokens to overlap between chunks (for recursive/text). */
  overlap?: number;
  /** Separator used for splitting (primarily for recursive strategy). */
  separator?: string;
  /** Maximum size for chunks (primarily for JSON strategy). */
  maxSize?: number;
}