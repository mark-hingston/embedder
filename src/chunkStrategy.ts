/**
 * Defines the available chunking strategies, corresponding to those
 * supported by the `@mastra/rag` library or custom logic.
 */
export type ChunkStrategy = 'recursive' | 'html' | 'json' | 'markdown' | 'text' | 'code';