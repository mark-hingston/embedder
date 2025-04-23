import { MDocument } from "@mastra/rag";
import { Chunk } from "./chunk.js";
import { ChunkingOptions } from "./chunkOptions.js";
import { FileTypeChunkingOptions, DEFAULT_CHUNKING_OPTIONS } from "./fileTypeChunkingOptions.js";
import { ProcessableFile } from "./fileProcessor.js";
import { ChunkStrategy } from "./chunkStrategy.js";
// Note: Importing ChunkOptions directly from @mastra/rag might be preferable if the type definition is exported.
// This path might be specific to the build output of @mastra/rag.
import { ChunkOptions } from "node_modules/@mastra/rag/dist/_tsup-dts-rollup.js";
import pLimit from 'p-limit'; // Used for limiting concurrency during file chunking
import { AnalysisService } from "./analysisService.js";
import { CodeFileAnalysis } from "./codeFileAnalysisSchema.js";

/**
 * Handles the chunking of file content based on file type and analysis results.
 * It uses the `@mastra/rag` library for the underlying chunking logic
 * and incorporates LLM analysis results into the chunk metadata.
 * Includes optional delay between analysis calls when processing multiple files.
 */
export class Chunker {
    private analysisService: AnalysisService;
    private chunkingOptions: FileTypeChunkingOptions;
    private defaultChunkSize: number;
    private defaultChunkOverlap: number;
    private analysisApiDelayMs: number; // <-- Add this property

    /**
     * Creates an instance of the Chunker.
     * @param analysisService Service to perform LLM analysis on code files.
     * @param analysisApiDelayMs Delay in milliseconds between analysis API calls when processing multiple files.
     * @param options Optional custom chunking options per file type.
     * @param defaultSize Default chunk size for fallback recursive chunking.
     * @param defaultOverlap Default chunk overlap for fallback recursive chunking.
     */
    constructor(
        analysisService: AnalysisService,
        analysisApiDelayMs: number = 0, // <-- Add parameter with default
        options?: Partial<FileTypeChunkingOptions>,
        defaultSize: number = 512,
        defaultOverlap: number = 50
    ) {
        this.analysisService = analysisService;
        this.analysisApiDelayMs = analysisApiDelayMs; // <-- Store the delay
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
    async chunkFile(file: ProcessableFile, currentIndex?: number, totalFiles?: number): Promise<Chunk[]> {
        // 1. Perform LLM analysis first, passing progress info
        // Note: The delay is handled in chunkFiles, not here, to control rate across concurrent calls.
        const analysis: CodeFileAnalysis | { source: string, analysisError: boolean } =
            await this.analysisService.analyseCode(file.content, file.relativePath, currentIndex, totalFiles);

        // Check if analysis failed and log a warning
        if ('analysisError' in analysis && analysis.analysisError) {
            console.warn(`Warning: LLM analysis failed for ${file.relativePath}. Proceeding with basic metadata only.`);
        }

        // 2. Prepare document for chunking, using analysis results as initial metadata
        const doc = new MDocument({
            docs: [{ text: file.content, metadata: analysis }],
            type: file.strategy,
        });

        let chunks: Chunk[] | undefined;
        try {
            // 3. Attempt chunking with the file-type specific strategy
            const options = this.getChunkingOptions(file.strategy);
            chunks = await doc.chunk(this.mapToChunkOptions(options));
        } catch (error) {
            console.warn(`Error chunking ${file.relativePath} with strategy '${file.strategy}': ${error}. Falling back to basic recursive.`);
            try {
                // 4. Fallback to recursive chunking if the primary strategy fails
                const fallbackOptions = {
                    strategy: "recursive",
                    size: this.defaultChunkSize,
                    overlap: this.defaultChunkOverlap
                } as ChunkOptions;
                chunks = await doc.chunk(fallbackOptions);
            } catch (fallbackError) {
                console.error(`Fallback chunking strategy also failed for ${file.relativePath}: ${fallbackError}. Skipping file.`);
                return []; // Return empty array if all chunking fails
            }
        }

        if (!chunks || chunks.length === 0) {
            console.log(`No chunks generated for file: ${file.relativePath}.`);
            return [];
        }

        // 5. Finalize metadata for each chunk
        return chunks.map(chunk => ({
            ...chunk,
            metadata: {
                ...(chunk.metadata || {}),
                ...analysis,
                source: file.relativePath
            }
        }));
    }

    /** Retrieves the appropriate chunking options based on the strategy type. */
    private getChunkingOptions(strategy: ChunkStrategy): ChunkingOptions {
        switch (strategy) {
            case "code": return this.chunkingOptions.code;
            case "html": return this.chunkingOptions.html;
            case "json": return this.chunkingOptions.json;
            case "markdown": return this.chunkingOptions.markdown;
            default: return this.chunkingOptions.text;
        }
    }

    /**
     * Maps internal ChunkingOptions to the ChunkOptions expected by @mastra/rag.
     */
    private mapToChunkOptions(options: ChunkingOptions): ChunkOptions {
        return {
            strategy: options.strategy,
            size: options.size,
            overlap: options.overlap,
            separator: options.separator,
            maxSize: options.maxSize
        } as ChunkOptions;
    }

    /**
     * Chunks multiple files concurrently using a specified concurrency limit,
     * adding an optional delay between starting analysis for each file.
     * @param processableFiles A map of relative file paths to ProcessableFile objects.
     * @param maxConcurrency The maximum number of files to chunk simultaneously.
     * @returns A promise resolving to a map where keys are relative file paths
     *          and values are arrays of Chunks for that file.
     */
    async chunkFiles(
        processableFiles: Map<string, ProcessableFile>,
        maxConcurrency: number = 5
    ): Promise<Map<string, Chunk[]>> {
        console.log(`Chunking ${processableFiles.size} files with concurrency limit of ${maxConcurrency} (Analysis Delay: ${this.analysisApiDelayMs}ms)...`);
        const fileChunksMap = new Map<string, Chunk[]>();
        const fileEntries = Array.from(processableFiles.entries());

        // Function to process a single file entry, including the post-processing delay
        const processEntry = async ([relativePath, file]: [string, ProcessableFile], index: number): Promise<void> => {
            try {
                // Perform the analysis and chunking for this file, passing progress info
                const chunks = await this.chunkFile(file, index + 1, fileEntries.length); // Pass index+1 (1-based) and total
                if (chunks.length > 0) {
                    fileChunksMap.set(relativePath, chunks);
                }
                // If chunks.length is 0, the reason is logged in chunkFile, just don't add to map.
            } catch (error) {
                 // Log errors from chunkFile itself if they somehow escape its internal handling
                 console.error(`Error during chunkFile processing for ${relativePath}: ${error}`);
            } finally {
                // Apply delay *after* this file's processing is complete (or failed),
                // before p-limit potentially starts the next task.
                if (this.analysisApiDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.analysisApiDelayMs));
                }
            }
        };

        // Use p-limit to control the concurrency of processEntry calls
        const limit = pLimit(maxConcurrency);
        // Pass the index along with the entry to processEntry
        const promises = fileEntries.map((entry, index) => limit(() => processEntry(entry, index)));

        await Promise.all(promises); // Wait for all concurrent operations (including delays) to complete

        console.log(`Successfully generated chunks for ${fileChunksMap.size} files out of ${processableFiles.size} processed.`);
        return fileChunksMap;
    }
}