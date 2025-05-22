import { MDocument } from "@mastra/rag";
import { DEFAULT_CHUNKING_OPTIONS } from "./fileTypeChunkingOptions.js";
import pLimit from 'p-limit'; // Used for limiting concurrency during file chunking
import { processTextToFinalTokens } from './tokenProcessor.js'; // Import the shared token processor
/**
 * Handles the chunking of file content based on file type and analysis results.
 * It uses the `@mastra/rag` library for the underlying chunking logic
 * and incorporates LLM analysis results into the chunk metadata.
 * Includes optional delay between analysis calls when processing multiple files.
 */
export class Chunker {
    skipAnalysis;
    analysisService;
    chunkingOptions;
    defaultChunkSize;
    defaultChunkOverlap;
    analysisApiDelayMs;
    vocabulary; // Made public to be set by EmbeddingPipeline
    /**
     * Creates an instance of the Chunker.
     * @param analysisService Service to perform LLM analysis on code files.
     * @param analysisApiDelayMs Delay in milliseconds between analysis API calls when processing multiple files.
     * @param options Optional custom chunking options per file type.
     * @param defaultSize Default chunk size for fallback recursive chunking.
     * @param defaultOverlap Default chunk overlap for fallback recursive chunking.
     * @param vocabulary Optional pre-loaded vocabulary for sparse vector generation.
     */
    constructor(analysisService, analysisApiDelayMs = 0, options, defaultSize = 512, defaultOverlap = 50, vocabulary, skipAnalysis = false) {
        this.skipAnalysis = skipAnalysis;
        this.analysisService = analysisService;
        this.analysisApiDelayMs = analysisApiDelayMs;
        this.vocabulary = vocabulary;
        const userChunkingOptions = options ?? {};
        // Merge default and user-provided chunking options
        this.chunkingOptions = {
            code: { ...DEFAULT_CHUNKING_OPTIONS.code, ...userChunkingOptions.code },
            html: { ...DEFAULT_CHUNKING_OPTIONS.html, ...userChunkingOptions.html },
            json: { ...DEFAULT_CHUNKING_OPTIONS.json, ...userChunkingOptions.json },
            markdown: { ...DEFAULT_CHUNKING_OPTIONS.markdown, ...userChunkingOptions.markdown },
            text: { ...DEFAULT_CHUNKING_OPTIONS.text, ...userChunkingOptions.text }
        };
        this.defaultChunkSize = defaultSize;
        this.defaultChunkOverlap = defaultOverlap;
        this.analysisApiDelayMs = analysisApiDelayMs;
    }
    /**
     * Chunks a single file after performing LLM analysis.
     * Incorporates analysis results into chunk metadata.
     * Falls back to recursive chunking if the primary strategy fails.
     * @param file The file to process and chunk.
     * @param currentIndex The index of the current file being processed (optional).
     * @param totalFiles The total number of files being processed (optional).
     * @returns A promise resolving to an array of Chunks.
     */
    async chunkFile(file, currentIndex, totalFiles) {
        // 1. Perform LLM analysis on the entire file content first, passing progress info, unless skipping analysis
        let fileLevelAnalysis = { source: file.relativePath, analysisError: false }; // Default to no error if skipping analysis
        if (!this.skipAnalysis) {
            // Note: Delay is handled in chunkFiles to control rate across concurrent calls.
            const analysisResult = await this.analysisService.analyseCode(file.content, file.relativePath, currentIndex, totalFiles);
            // Check if analysis failed and log a warning
            const analysisError = typeof analysisResult !== 'string' && analysisResult.analysisError;
            if (analysisError) {
                console.warn(`Warning: LLM analysis failed for ${file.relativePath}. Proceeding with basic metadata only.`);
                fileLevelAnalysis = analysisResult;
            }
            else {
                fileLevelAnalysis = analysisResult;
            }
        }
        else {
            console.log(`Skipping LLM analysis for ${file.relativePath} as requested.`);
        }
        const doc = new MDocument({
            docs: [{ text: file.content, metadata: { source: file.relativePath, fileExtension: file.relativePath.slice(file.relativePath.lastIndexOf('.')) } }], // Initial metadata with source and extension
            type: file.strategy,
        });
        let chunks;
        try {
            // 3. Attempt chunking with the file-type specific strategy
            const options = this.getChunkingOptions(file.strategy);
            // Construct an object literal matching the expected ChunkParams structure
            // Cast strategy to 'any' to bypass the strict nominal type check
            chunks = await doc.chunk({
                strategy: options.strategy,
                size: options.size,
                overlap: options.overlap,
                separator: options.separator,
                maxSize: options.maxSize
            });
        }
        catch (error) {
            console.warn(`Error chunking ${file.relativePath} with strategy '${file.strategy}': ${error}. Falling back to basic recursive.`);
            try {
                // 4. Fallback to recursive chunking if the primary strategy fails
                // Construct a plain object literal for the fallback
                chunks = await doc.chunk({
                    strategy: "recursive",
                    size: this.defaultChunkSize,
                    overlap: this.defaultChunkOverlap
                });
            }
            catch (fallbackError) {
                console.error(`Fallback chunking strategy also failed for ${file.relativePath}: ${fallbackError}. Skipping file.`);
                return []; // Return empty array if all chunking fails
            }
        }
        if (!chunks || chunks.length === 0) {
            console.log(`No chunks generated for file: ${file.relativePath}.`);
            return [];
        }
        // 5. Finalise metadata for each chunk, adding the file-level analysis results and generating sparse vector
        return Promise.all(chunks.map(async (chunk, index) => {
            // Prepare the final metadata for the chunk
            // Start with basic chunk metadata (like source and extension, added during doc creation)
            const finalChunkMetadata = {
                ...(chunk.metadata || {}), // Basic metadata from chunk creation
                source: file.relativePath, // Ensure source (filePath) is present (might be overwritten by analysis, so set explicitly)
                fileExtension: file.relativePath.slice(file.relativePath.lastIndexOf('.')) // Add fileExtension (might be overwritten)
            };
            // Add analysis result to metadata
            if (typeof fileLevelAnalysis === 'string') {
                finalChunkMetadata.summary = fileLevelAnalysis;
            }
            else {
                finalChunkMetadata.analysisError = fileLevelAnalysis.analysisError;
                finalChunkMetadata.source = fileLevelAnalysis.source;
            }
            // Generate sparse vector based on the vocabulary, using only chunk.text
            if (this.vocabulary) {
                // Use the shared token processing function for sparse vector generation
                const processedTermsForLookup = processTextToFinalTokens(chunk.text);
                const termFrequencies = {};
                for (const processedTerm of processedTermsForLookup) {
                    termFrequencies[processedTerm] = (termFrequencies[processedTerm] || 0) + 1;
                }
                const indices = [];
                const values = [];
                for (const term in termFrequencies) {
                    if (this.vocabulary[term] !== undefined) {
                        indices.push(this.vocabulary[term]);
                        values.push(termFrequencies[term]);
                    }
                }
                if (indices.length > 0) {
                    finalChunkMetadata.sparseVector = { indices, values };
                }
                else {
                    finalChunkMetadata.sparseVector = { indices: [], values: [] };
                }
            }
            else {
                // Fallback or if vocabulary is not provided - can be undefined or empty
                finalChunkMetadata.sparseVector = { indices: [], values: [] }; // Or undefined, depending on desired Qdrant behavior
            }
            return {
                ...chunk,
                metadata: finalChunkMetadata
            };
        }));
    }
    /** Retrieves the appropriate chunking options based on the strategy type. */
    getChunkingOptions(strategy) {
        switch (strategy) {
            case "code": return this.chunkingOptions.code;
            case "html": return this.chunkingOptions.html;
            case "json": return this.chunkingOptions.json;
            case "markdown": return this.chunkingOptions.markdown;
            default: return this.chunkingOptions.text;
        }
    }
    /**
     * Chunks multiple files concurrently using a specified concurrency limit,
     * adding an optional delay between starting analysis for each file.
     * @param processableFiles A map of relative file paths to ProcessableFile objects.
     * @param maxConcurrency The maximum number of files to chunk simultaneously.
     * @returns A promise resolving to a map where keys are relative file paths
     *          and values are arrays of Chunks for that file.
     */
    async chunkFiles(processableFiles, maxConcurrency = 5) {
        console.log(`Chunking ${processableFiles.size} files with concurrency limit of ${maxConcurrency} (Analysis Delay: ${this.analysisApiDelayMs}ms)...`);
        const fileChunksMap = new Map();
        const fileEntries = Array.from(processableFiles.entries());
        // Function to process a single file entry, including the post-processing delay
        const processEntry = async ([relativePath, file], index) => {
            try {
                // Perform the analysis and chunking for this file, passing progress info
                const chunks = await this.chunkFile(file, index + 1, fileEntries.length); // Pass index+1 (1-based) and total
                if (chunks.length > 0) {
                    fileChunksMap.set(relativePath, chunks);
                }
                // If chunks.length is 0, the reason is logged in chunkFile, just don't add to map.
            }
            catch (error) {
                // Log errors from chunkFile itself if they somehow escape its internal handling
                console.error(`Error during chunkFile processing for ${relativePath}: ${error}`);
            }
            finally {
                // Apply delay *after* this file's processing is complete (or failed),
                // before p-limit potentially starts the next task.
                if (this.analysisApiDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.analysisApiDelayMs));
                }
            }
        };
        const limit = pLimit(maxConcurrency);
        // Pass the index along with the entry to processEntry
        const promises = fileEntries.map((entry, index) => limit(() => processEntry(entry, index)));
        await Promise.all(promises); // Wait for all concurrent operations (including delays) to complete
        console.log(`Successfully generated chunks for ${fileChunksMap.size} files out of ${processableFiles.size} processed.`);
        return fileChunksMap;
    }
}
