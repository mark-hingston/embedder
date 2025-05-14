/**
 * Default chunking options used if no specific overrides are provided.
 * These leverage different strategies from `@mastra/rag`.
 * Values for size and overlap are sourced from environment variables,
 * with sensible fallbacks if not set.
 */
// Read chunk size and overlap from environment variables, with defaults
const envChunkSize = parseInt(process.env.DEFAULT_CHUNK_SIZE || "32000", 10);
const envChunkOverlap = parseInt(process.env.DEFAULT_CHUNK_OVERLAP || "1000", 10);
// Validate parsed values, falling back to compiled defaults if parsing fails or values are invalid
const defaultSize = !isNaN(envChunkSize) && envChunkSize > 0 ? envChunkSize : 32000;
const defaultOverlap = !isNaN(envChunkOverlap) && envChunkOverlap >= 0 ? envChunkOverlap : 1000;
if (isNaN(envChunkSize) || envChunkSize <= 0) {
    console.warn(`Invalid or missing DEFAULT_CHUNK_SIZE environment variable. Using default: ${defaultSize}`);
}
if (isNaN(envChunkOverlap) || envChunkOverlap < 0) {
    console.warn(`Invalid or missing DEFAULT_CHUNK_OVERLAP environment variable. Using default: ${defaultOverlap}`);
}
export const DEFAULT_CHUNKING_OPTIONS = {
    // Recursive strategy is often good for code, splitting by lines/blocks.
    code: { strategy: "recursive", size: defaultSize, overlap: defaultOverlap, separator: "\n" },
    // HTML strategy understands HTML structure.
    html: { strategy: "html", size: defaultSize }, // Size might relate to characters within tags
    // JSON strategy handles JSON structure, maxSize prevents overly large chunks.
    json: { strategy: "json", maxSize: defaultSize },
    // Markdown strategy understands Markdown structure (headers, paragraphs).
    markdown: { strategy: "markdown", size: defaultSize },
    // Recursive strategy is a general-purpose fallback for plain text.
    text: { strategy: "recursive", size: defaultSize, overlap: defaultOverlap }
};
