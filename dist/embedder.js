import { embedMany } from "ai";
import { MDocument } from "@mastra/rag";
import { readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "path";
import { simpleGit, CheckRepoActions } from "simple-git";
import { randomUUID } from "node:crypto";
import { DEFAULT_CHUNKING_OPTIONS } from "./fileTypeChunkingOptions.js";
import { fsExists, isCode, isHtml, isJson, isLockFile, isMarkdown } from "./utilities.js";
const { isText } = await import("istextorbinary");
const STATE_FILE_NAME = ".file-points.json";
const TEMP_STATE_FILE_NAME = ".file-points.json.tmp";
export class Embedder {
    baseDir;
    repo;
    diffOnly;
    embeddingModel;
    qdrantClient;
    collectionName;
    vectorDimensions;
    deleteBatchSize;
    upsertBatchSize;
    defaultChunkSize;
    defaultChunkOverlap;
    distanceMetric;
    maxConcurrentChunking;
    chunkingOptions;
    embeddingBatchSize;
    embeddingApiDelayMs;
    filesMarkedForDeletion = new Set();
    filesMarkedForProcessing = new Set();
    filePoints = {}; // Maps filename -> [pointId1, pointId2, ...]
    constructor(options) {
        this.baseDir = options.baseDir ?? process.cwd();
        this.repo = simpleGit(this.baseDir);
        this.diffOnly = options.diffOnly;
        this.embeddingModel = options.embeddingModel;
        this.qdrantClient = options.qdrantClient;
        this.collectionName = options.collectionName;
        this.vectorDimensions = options.vectorDimensions;
        this.deleteBatchSize = options.deleteBatchSize ?? 200;
        this.upsertBatchSize = options.upsertBatchSize ?? 100;
        this.defaultChunkSize = options.defaultChunkSize ?? 512;
        this.defaultChunkOverlap = options.defaultChunkOverlap ?? 50;
        this.distanceMetric = options.distanceMetric ?? "Cosine";
        this.maxConcurrentChunking = options.maxConcurrentChunking ?? 5;
        this.embeddingBatchSize = options.embeddingBatchSize ?? 96;
        this.embeddingApiDelayMs = options.embeddingApiDelayMs ?? 1000;
        // Merge provided chunking options with defaults
        const userChunkingOptions = options.chunkingOptions ?? {};
        this.chunkingOptions = {
            code: { ...DEFAULT_CHUNKING_OPTIONS.code, ...userChunkingOptions.code },
            html: { ...DEFAULT_CHUNKING_OPTIONS.html, ...userChunkingOptions.html },
            json: { ...DEFAULT_CHUNKING_OPTIONS.json, ...userChunkingOptions.json },
            markdown: { ...DEFAULT_CHUNKING_OPTIONS.markdown, ...userChunkingOptions.markdown },
            text: { ...DEFAULT_CHUNKING_OPTIONS.text, ...userChunkingOptions.text }
        };
    }
    async init() {
        if (!(await this.repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
            throw new Error(`Directory ${this.baseDir} is not a git repository root.`);
        }
        // Load state file using stat/try-catch
        const filePath = join(this.baseDir, STATE_FILE_NAME);
        try {
            await stat(filePath); // Check existence and accessibility first
            this.filePoints = JSON.parse(await readFile(filePath, "utf8"));
            console.log(`Loaded ${Object.keys(this.filePoints).length} files from ${STATE_FILE_NAME}`);
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                console.log(`${STATE_FILE_NAME} not found. Starting with empty state.`);
            }
            else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.warn(`Warning: Could not read or parse ${STATE_FILE_NAME}: ${errorMessage}. Proceeding with empty state.`);
            }
            this.filePoints = {}; // Ensure it's initialized
        }
        return this;
    }
    // Mark a file's existing points for deletion
    markFileForDeletion(file) {
        if (this.filePoints[file]) { // Only mark if we have known points for it
            this.filesMarkedForDeletion.add(file);
        }
        // Ensure it's not marked for processing if it's only being deleted
        this.filesMarkedForProcessing.delete(file);
    }
    // Mark a file for processing (implies potential deletion of old points too)
    markFileForProcessing(file) {
        this.filesMarkedForProcessing.add(file);
        // If we are processing it, its old points must be removed first.
        if (this.filePoints[file]) {
            this.filesMarkedForDeletion.add(file);
        }
    }
    /**
     * Retry an async operation with exponential backoff
     * @param operation The async operation to retry
     * @param options Retry configuration options
     * @returns The result of the operation
     */
    async retry(operation, options = {}) {
        const config = {
            maxRetries: 3,
            initialDelay: 100,
            maxDelay: 5000,
            factor: 2,
            onRetry: (error, attempt) => {
                console.warn(`Retry attempt ${attempt} after error: ${error.message}`);
            },
            ...options
        };
        let lastError;
        let delay = config.initialDelay;
        for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt >= config.maxRetries) {
                    break;
                }
                if (config.onRetry) {
                    config.onRetry(lastError, attempt);
                }
                // Calculate delay with exponential backoff
                delay = Math.min(delay * config.factor, config.maxDelay);
                // Add some jitter to prevent synchronized retries
                const jitter = delay * 0.1 * Math.random();
                await new Promise(resolve => setTimeout(resolve, delay + jitter));
            }
        }
        throw lastError;
    }
    // --- Process Git Diff: Extract from listFiles ---
    async processGitDiff() {
        let gitFiles = [];
        let explicitlyDeleted = [];
        let diffFailed = false;
        console.log("Processing diff between HEAD and HEAD~1...");
        try {
            await this.repo.revparse(['HEAD~1']); // Check if HEAD~1 exists
            const diffOutput = await this.repo.diff([
                "--name-status",
                "HEAD~1",
                "HEAD",
            ]);
            const diffSummary = diffOutput.split('\n').filter(line => line.trim() !== '');
            console.log(`Found ${diffSummary.length} changes between HEAD and HEAD~1.`);
            for (const line of diffSummary) {
                const parts = line.split('\t');
                const status = parts[0].trim();
                const path1 = parts[1].trim();
                const path2 = parts.length > 2 ? parts[2].trim() : null;
                if (status.startsWith('A') || status.startsWith('M') || status.startsWith('T')) {
                    this.markFileForProcessing(path1);
                }
                else if (status.startsWith('C')) {
                    // Process the NEW path, potentially delete old if it existed under old name
                    this.markFileForProcessing(path2 ?? path1);
                }
                else if (status.startsWith('R')) {
                    this.markFileForProcessing(path2 ?? path1); // Process NEW path
                    this.markFileForDeletion(path1); // Mark OLD path for deletion
                    explicitlyDeleted.push(path1);
                }
                else if (status.startsWith('D')) {
                    this.markFileForDeletion(path1); // Mark path for deletion
                    explicitlyDeleted.push(path1);
                }
            }
            // Collect files for existence/text check
            gitFiles = Array.from(this.filesMarkedForProcessing);
        }
        catch (error) {
            console.warn(`Could not get diff from HEAD~1 (maybe initial commit?). Falling back to listing all tracked files.`);
            diffFailed = true;
        }
        return { gitFiles, explicitlyDeleted, diffFailed };
    }
    // --- Process All Tracked Files: Extract from listFiles ---
    async processAllTrackedFiles() {
        console.log("Processing all tracked files (diffOnly=false or fallback)...");
        const gitFiles = (await this.repo.raw(["ls-files"])).split("\n").filter(Boolean);
        console.log(`Found ${gitFiles.length} files via ls-files.`);
        // Mark all found files for processing
        gitFiles.forEach(file => this.markFileForProcessing(file));
        // Identify files deleted since last run (present in state but not in ls-files)
        const currentFilesSet = new Set(gitFiles);
        const previouslyKnownFiles = Object.keys(this.filePoints);
        previouslyKnownFiles.forEach(knownFile => {
            if (!currentFilesSet.has(knownFile)) {
                this.markFileForDeletion(knownFile);
            }
        });
        return gitFiles;
    }
    // --- Filter Text Files: Extract from listFiles ---
    async filterTextFiles() {
        const filesToProcess = Array.from(this.filesMarkedForProcessing);
        for (const file of filesToProcess) {
            const filePath = join(this.baseDir, file);
            try {
                if (!(await fsExists(filePath))) {
                    console.warn(`File ${file} marked for processing but not found on disk. Skipping processing, ensuring deletion.`);
                    this.markFileForDeletion(file);
                    this.filesMarkedForProcessing.delete(file);
                    continue;
                }
                const fileBuffer = await readFile(filePath);
                if (!isText(filePath, fileBuffer)) {
                    console.log(`Skipping binary file: ${file}. Ensuring deletion.`);
                    this.markFileForDeletion(file);
                    this.filesMarkedForProcessing.delete(file);
                    continue;
                }
                // Skip lock files (package-lock.json, yarn.lock, etc.)
                if (isLockFile(file) || /\.yarn/.test(file) || file == STATE_FILE_NAME) {
                    console.log(`Skipping file: ${file}. Ensuring deletion.`);
                    this.markFileForDeletion(file);
                    this.filesMarkedForProcessing.delete(file);
                }
            }
            catch (readError) {
                console.error(`Error reading or checking file ${file}: ${readError}. Skipping processing, ensuring deletion.`);
                this.markFileForDeletion(file);
                this.filesMarkedForProcessing.delete(file);
            }
        }
    }
    // --- listFiles: Refactored to use helper methods ---
    async listFiles() {
        console.log(`Listing files in ${this.baseDir}...`);
        this.filesMarkedForDeletion.clear();
        this.filesMarkedForProcessing.clear();
        let gitFiles = [];
        let explicitlyDeleted = [];
        if (this.diffOnly) {
            const diffResult = await this.processGitDiff();
            gitFiles = diffResult.gitFiles;
            explicitlyDeleted = diffResult.explicitlyDeleted;
            if (diffResult.diffFailed) {
                this.diffOnly = false; // Force full processing
            }
        }
        // If not diffOnly or if diff failed and fell back
        if (!this.diffOnly || (gitFiles.length === 0 && explicitlyDeleted.length === 0 && !this.diffOnly)) {
            gitFiles = await this.processAllTrackedFiles();
        }
        console.log(`Initially marked ${this.filesMarkedForProcessing.size} files for processing and ${this.filesMarkedForDeletion.size} for deletion.`);
        // Filter for text files and check existence
        await this.filterTextFiles();
        console.log(`Final check: ${this.filesMarkedForProcessing.size} text files to process, ${this.filesMarkedForDeletion.size} files marked for point deletion.`);
    }
    // --- chunkFiles: Parallelized with concurrency limit and improved types ---
    async chunkFiles(files) {
        console.log(`Chunking ${files.length} files with concurrency limit of ${this.maxConcurrentChunking}...`);
        const fileChunksMap = new Map();
        // Helper function to process a single file
        const processFile = async (file) => {
            const filePath = join(this.baseDir, file);
            let content;
            try {
                // Existence check
                if (!(await fsExists(filePath))) {
                    console.warn(`File ${file} disappeared before chunking. Skipping.`);
                    this.markFileForDeletion(file);
                    this.filesMarkedForProcessing.delete(file);
                    return null;
                }
                content = await readFile(filePath, { encoding: "utf8" });
            }
            catch (error) {
                console.error(`Error reading file ${file} during chunking: ${error}. Skipping.`);
                this.markFileForDeletion(file);
                this.filesMarkedForProcessing.delete(file);
                return null;
            }
            const strategy = isCode(filePath) ? "code"
                : isHtml(filePath) ? "html"
                    : isJson(filePath) ? "json"
                        : isMarkdown(filePath) ? "markdown"
                            : "text";
            const doc = new MDocument({
                docs: [{ text: content, metadata: { source: file } }],
                type: strategy,
            });
            let chunks;
            try {
                // Use chunking options from class configuration with type assertions
                switch (strategy) {
                    case "code":
                        chunks = await doc.chunk(this.chunkingOptions.code);
                        break;
                    case "html":
                        chunks = await doc.chunk(this.chunkingOptions.html);
                        break;
                    case "json":
                        chunks = await doc.chunk(this.chunkingOptions.json);
                        break;
                    case "markdown":
                        chunks = await doc.chunk(this.chunkingOptions.markdown);
                        break;
                    default: chunks = await doc.chunk(this.chunkingOptions.text);
                }
            }
            catch (error) {
                console.warn(`Error chunking ${file} with strategy '${strategy}': ${error}. Falling back to basic recursive.`);
                try {
                    chunks = await doc.chunk({
                        strategy: "recursive",
                        size: this.defaultChunkSize,
                        overlap: this.defaultChunkOverlap
                    });
                }
                catch (fallbackError) {
                    console.error(`Fallback chunking strategy also failed for ${file}: ${fallbackError}. Skipping file.`);
                    this.markFileForDeletion(file);
                    this.filesMarkedForProcessing.delete(file);
                    return null;
                }
            }
            if (chunks && chunks.length > 0) {
                return [file, chunks];
            }
            else {
                console.log(`No chunks generated for file: ${file}. Ensuring deletion.`);
                this.markFileForDeletion(file);
                this.filesMarkedForProcessing.delete(file);
                return null;
            }
        };
        // Process files in batches to control concurrency
        const results = [];
        for (let i = 0; i < files.length; i += this.maxConcurrentChunking) {
            const batch = files.slice(i, i + this.maxConcurrentChunking);
            console.log(`Processing batch of ${batch.length} files (${i + 1}-${Math.min(i + this.maxConcurrentChunking, files.length)} of ${files.length})...`);
            const batchResults = await Promise.all(batch.map(file => processFile(file)));
            results.push(...batchResults);
        }
        // Add successful results to the map
        for (const result of results) {
            if (result) {
                const [file, chunks] = result;
                fileChunksMap.set(file, chunks);
            }
        }
        console.log(`Successfully chunked ${fileChunksMap.size} files out of ${files.length} attempted.`);
        return fileChunksMap;
    }
    // --- createCollectionIfNotExists: Use configurable distance metric ---
    async createCollectionIfNotExists() {
        try {
            const collectionInfo = await this.qdrantClient.getCollection(this.collectionName);
            // console.log(`Collection '${this.collectionName}' already exists.`); // Less verbose
            const existingSize = collectionInfo.config.params.vectors?.size; // Check vectors.size
            if (existingSize !== this.vectorDimensions) {
                // This is a fatal error usually, dimensions must match.
                throw new Error(`FATAL: Existing collection '${this.collectionName}' has dimension ${existingSize}, but expected ${this.vectorDimensions}. Aborting.`);
            }
        }
        catch (error) {
            // Check if error is specifically "Not Found" or similar
            const isNotFoundError = (error && typeof error === 'object' && 'status' in error && error.status === 404) ||
                (error instanceof Error && error.message?.includes('Not found'));
            if (isNotFoundError) {
                console.log(`Creating collection '${this.collectionName}' (dimensions: ${this.vectorDimensions})...`);
                await this.qdrantClient.createCollection(this.collectionName, {
                    vectors: { size: this.vectorDimensions, distance: this.distanceMetric },
                });
                console.log(`Collection '${this.collectionName}' created.`);
            }
            else {
                // Re-throw unexpected errors (e.g., connection issues)
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`Error checking/creating collection ${this.collectionName}:`, errorMessage);
                throw error;
            }
        }
    }
    // --- removeVectorsForFiles: Added retry logic ---
    async removeVectorsForFiles() {
        const filesToDelete = Array.from(this.filesMarkedForDeletion);
        if (filesToDelete.length === 0)
            return;
        // Collect point IDs to delete but don't modify state yet
        const pointIdsToDelete = [];
        const filePointsToDelete = {};
        filesToDelete.forEach(file => {
            if (this.filePoints[file]) {
                pointIdsToDelete.push(...this.filePoints[file]);
                filePointsToDelete[file] = [...this.filePoints[file]]; // Store a copy
            }
        });
        if (pointIdsToDelete.length === 0) {
            console.log("No existing points found in state for the files marked for deletion.");
            return;
        }
        console.log(`Attempting to delete ${pointIdsToDelete.length} points from Qdrant for ${filesToDelete.length} files...`);
        try {
            for (let i = 0; i < pointIdsToDelete.length; i += this.deleteBatchSize) {
                const batchIds = pointIdsToDelete.slice(i, i + this.deleteBatchSize);
                if (batchIds.length > 0) {
                    // Use retry logic for deletion
                    await this.retry(async () => {
                        const result = await this.qdrantClient.delete(this.collectionName, {
                            points: batchIds,
                            wait: true, // Wait for operation to complete is safer
                        });
                        if (result.status !== 'completed') {
                            throw new Error(`Qdrant deletion batch status: ${result.status}. Points might remain.`);
                        }
                        return result;
                    }, {
                        maxRetries: 3,
                        initialDelay: 500,
                        onRetry: (error, attempt) => {
                            console.warn(`Retry attempt ${attempt} for Qdrant delete operation: ${error.message}`);
                        }
                    });
                }
            }
            // Only update state after successful deletion
            for (const file of filesToDelete) {
                if (this.filePoints[file]) {
                    delete this.filePoints[file];
                }
            }
            console.log(`Successfully deleted ${pointIdsToDelete.length} points from Qdrant.`);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`ERROR during batch deletion by ID:`, errorMessage);
            console.error(`WARNING: Qdrant state may be inconsistent. Not updating local state to preserve point IDs.`);
            // Don't update state on error to maintain consistency with Qdrant
        }
    }
    // --- embedChunks: Added retry logic ---
    async embedChunks() {
        try {
            await this.createCollectionIfNotExists(); // Check/create collection first
            // 1. Determine files to process and delete using git logic
            await this.listFiles();
            // 2. Remove points for deleted/modified files *before* processing new ones
            await this.removeVectorsForFiles();
            // 3. Get the list of files that survived filtering and need chunking
            const filesToChunk = Array.from(this.filesMarkedForProcessing);
            if (filesToChunk.length === 0) {
                console.log("No files remaining to process after filtering.");
                await this.saveState(); // Save state (might have had deletions)
                return;
            }
            // 4. Chunk the necessary files
            const fileChunksMap = await this.chunkFiles(filesToChunk);
            // Re-check which files actually produced chunks
            const filesWithChunks = Array.from(fileChunksMap.keys());
            if (filesWithChunks.length === 0) {
                console.log("No chunks were generated from the files processed.");
                await this.saveState(); // Save state (deletions might have occurred)
                return;
            }
            console.log(`Preparing to embed chunks from ${filesWithChunks.length} files.`);
            // 5. Gather all chunks and their origins
            const allChunksToEmbed = [];
            for (const [fileName, chunks] of fileChunksMap.entries()) {
                chunks.forEach((chunk) => {
                    allChunksToEmbed.push({
                        text: chunk.text,
                        sourceFile: fileName,
                        metadata: chunk.metadata || { source: fileName } // Ensure metadata exists
                    });
                });
            }
            if (allChunksToEmbed.length === 0) {
                // Should not happen if filesWithChunks > 0, but safety check
                console.log("Collected 0 chunks to embed.");
                await this.saveState();
                return;
            }
            // 6. Batch Embed all chunks respecting API limits and with retry logic
            console.log(`Embedding ${allChunksToEmbed.length} chunks in total (API batch size: ${this.embeddingBatchSize} / Batches: ${Math.ceil(allChunksToEmbed.length / this.embeddingBatchSize)})...`);
            let allEmbeddings = []; // Initialize array to collect all embeddings
            try {
                for (let i = 0; i < allChunksToEmbed.length; i += this.embeddingBatchSize) {
                    const batchChunks = allChunksToEmbed.slice(i, i + this.embeddingBatchSize);
                    const batchTexts = batchChunks.map(c => c.text);
                    if (batchTexts.length === 0) {
                        continue; // Should not happen, but safety check
                    }
                    console.log(`Embedding batch ${Math.floor(i / this.embeddingBatchSize) + 1} (${batchTexts.length} chunks)...`);
                    // Apply retry logic to *each batch* sent to embedMany
                    const batchEmbeddings = await this.retry(async () => {
                        const embedResult = await embedMany({
                            model: this.embeddingModel,
                            values: batchTexts, // Send only the current batch texts
                        });
                        // Optional: Add a check for result length mismatch within the batch
                        if (embedResult.embeddings.length !== batchTexts.length) {
                            throw new Error(`Embedding mismatch in batch starting at index ${i}: expected ${batchTexts.length}, got ${embedResult.embeddings.length}`);
                        }
                        return embedResult.embeddings;
                    }, {
                        maxRetries: 3,
                        initialDelay: 1000, // You can adjust retry parameters
                        onRetry: (error, attempt) => {
                            console.warn(`Retry attempt ${attempt} for embedMany batch operation (size ${batchTexts.length}): ${error.message}`);
                        }
                    });
                    allEmbeddings.push(...batchEmbeddings); // Append results from this batch
                    // Add delay between batches if configured
                    if (this.embeddingApiDelayMs > 0 && i + this.embeddingBatchSize < allChunksToEmbed.length) {
                        console.log(`Waiting ${this.embeddingApiDelayMs}ms before next embedding batch...`);
                        await new Promise(resolve => setTimeout(resolve, this.embeddingApiDelayMs));
                    }
                }
                console.log(`Successfully received ${allEmbeddings.length} embeddings in total.`);
            }
            catch (embeddingError) {
                const errorMessage = embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
                // Log might be slightly less informative now about which batch failed without extra context
                console.error(`FATAL ERROR during batch embedding: ${errorMessage}. Aborting upsert.`);
                throw embeddingError; // Re-throw to stop the process
            }
            // --- Crucial Validation after all batches ---
            if (allEmbeddings.length !== allChunksToEmbed.length) {
                const errMsg = `FATAL MISMATCH after batching: Got ${allEmbeddings.length} embeddings for ${allChunksToEmbed.length} total chunks. Aborting.`;
                console.error(errMsg);
                throw new Error(errMsg); // Stop the process
            }
            // 7. Prepare all PointStructs for batch upsert
            console.log(`Preparing ${allEmbeddings.length} points for Qdrant upsert...`);
            const allPointsToUpsert = [];
            // Temporary state to build during point preparation
            const newFilePointsState = {};
            for (let i = 0; i < allChunksToEmbed.length; i++) {
                const chunkInfo = allChunksToEmbed[i];
                const embedding = allEmbeddings[i];
                const pointId = randomUUID();
                allPointsToUpsert.push({
                    id: pointId,
                    vector: embedding,
                    payload: {
                        text: chunkInfo.text, // Store the chunk text
                        ...chunkInfo.metadata, // Spread original metadata
                        source: chunkInfo.sourceFile, // Ensure source is correct filename
                    },
                });
                // Add the generated ID to the temporary state for the source file
                if (!newFilePointsState[chunkInfo.sourceFile]) {
                    newFilePointsState[chunkInfo.sourceFile] = [];
                }
                newFilePointsState[chunkInfo.sourceFile].push(pointId);
            }
            // 8. Batch Upsert all points with retry logic
            console.log(`Upserting ${allPointsToUpsert.length} points to Qdrant in batches of ${this.upsertBatchSize}...`);
            try {
                for (let i = 0; i < allPointsToUpsert.length; i += this.upsertBatchSize) {
                    const batch = allPointsToUpsert.slice(i, i + this.upsertBatchSize);
                    if (batch.length > 0) {
                        // Add retry logic to upsert
                        await this.retry(async () => {
                            const result = await this.qdrantClient.upsert(this.collectionName, {
                                points: batch,
                                wait: true, // Wait for completion for safer state update
                            });
                            if (result.status !== 'completed') {
                                throw new Error(`Qdrant upsert batch status: ${result.status}. Some points might be missing.`);
                            }
                            return result;
                        }, {
                            maxRetries: 3,
                            initialDelay: 500,
                            onRetry: (error, attempt) => {
                                console.warn(`Retry attempt ${attempt} for Qdrant upsert operation: ${error.message}`);
                            }
                        });
                    }
                }
                console.log("Successfully completed upserting all points.");
                // 9. Update the main state *after* successful upsert
                // Merge the newly generated points into the main state
                for (const [fileName, pointIds] of Object.entries(newFilePointsState)) {
                    this.filePoints[fileName] = pointIds;
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`ERROR during batch upsert: ${errorMessage}`);
                console.error(`WARNING: State update aborted. Points for files [${Object.keys(newFilePointsState).join(', ')}] might be missing or incomplete in Qdrant.`);
                // Do not save state here, as it would be inconsistent.
                throw error; // Re-throw to indicate failure
            }
            // 10. Save the final, updated state atomically
            await this.saveState();
            console.log("Embedding process completed successfully.");
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Embedding process failed:", errorMessage);
            // State might not have been saved if error occurred after deletion but before/during upsert.
        }
    }
    // --- saveState: Use Atomic Write ---
    async saveState() {
        console.log(`Saving state to ${STATE_FILE_NAME}...`);
        const tempFilePath = join(this.baseDir, TEMP_STATE_FILE_NAME);
        const finalFilePath = join(this.baseDir, STATE_FILE_NAME);
        try {
            const stateString = JSON.stringify(this.filePoints, null, 2);
            await writeFile(tempFilePath, stateString, "utf8");
            await rename(tempFilePath, finalFilePath); // Atomic rename
            // console.log(`${STATE_FILE_NAME} saved successfully.`); // Less verbose
        }
        catch (error) {
            console.error(`ERROR saving state file ${STATE_FILE_NAME}: ${error}`);
            // Attempt cleanup
            try {
                if (await fsExists(tempFilePath)) {
                    await unlink(tempFilePath);
                }
            }
            catch (cleanupError) {
                console.warn(`Warning: Failed to clean up temporary state file ${tempFilePath}: ${cleanupError}`);
            }
            // Re-throw the original error? Or just log? Depends on desired behavior.
        }
    }
}
