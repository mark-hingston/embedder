/**
 * Represents a single chunk of text extracted from a source file,
 * along with associated metadata.
 */
export interface Chunk {
  /** The text content of the chunk. */
  text: string;
  /** Arbitrary metadata associated with the chunk (e.g., source file, analysis results). */
  metadata: { sparseVector?: { indices: number[]; values: number[]; }; [key: string]: any; };
}