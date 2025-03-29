import { randomUUID } from "crypto";
/**
 * Orchestrates the entire process of embedding repository files into Qdrant.
 * Coordinates various managers and services (Git, File Processing, Chunking, Embedding, Qdrant, State).
 */
export class EmbeddingPipeline {
    options;
    constructor(options) {
        this.options = options;
    }
    /**
     * Executes the embedding pipeline steps.
     */
    async run() {
        console.log("Starting embedding pipeline...");
        try {
            // 0. Initial setup and validation
            await this.options.repositoryManager.checkRepository();
            await this.options.qdrantManager.ensureCollectionExists();
            // 1. Load the previous processing state (last commit, processed files/points)
            const previousState = await this.options.stateManager.loadState();
            // 2. Determine which files need processing based on Git changes (diff or full scan)
            const { filesToProcess, filesToDeletePointsFor } = await this.options.repositoryManager.listFiles(this.options.diffOnly, previousState);
            // 3. Identify the specific Qdrant point IDs associated with files marked for deletion
            const pointIdsToDelete = this.options.stateManager.getPointsForFiles(filesToDeletePointsFor, previousState);
            // 4. Delete outdated points from Qdrant *before* adding new ones
            // This prevents issues if the pipeline fails later. State is updated *after* successful upserts.
            await this.options.qdrantManager.deletePoints(pointIdsToDelete);
            console.log(`Deletion phase complete for ${filesToDeletePointsFor.size} files (found ${pointIdsToDelete.length} points).`);
            // 5. Filter the candidate files (e.g., remove binaries, locks) and load their content
            const processableFiles = await this.options.fileProcessor.filterAndLoadFiles(filesToProcess);
            // Early exit if no files remain after filtering, but still save state if deletions occurred.
            if (processableFiles.size === 0) {
                console.log("No files remaining to process after filtering.");
                const currentCommit = await this.options.repositoryManager.getCurrentCommit();
                // Calculate next state reflecting only deletions and the current commit hash
                const nextState = this.options.stateManager.calculateNextState(previousState, filesToDeletePointsFor, {}, // No new points
                currentCommit);
                await this.options.stateManager.saveState(nextState);
                console.log("Embedding pipeline finished: Only deletions were processed.");
                return;
            }
            // 6. Chunk the content of processable files, including LLM analysis metadata
            const fileChunksMap = await this.options.chunker.chunkFiles(processableFiles, this.options.maxConcurrentChunking);
            // Early exit if no chunks were generated (e.g., all files were empty or failed chunking),
            // but still save state reflecting deletions.
            if (fileChunksMap.size === 0) {
                console.log("No chunks were generated from the files processed.");
                const currentCommit = await this.options.repositoryManager.getCurrentCommit();
                const nextState = this.options.stateManager.calculateNextState(previousState, filesToDeletePointsFor, {}, // No new points
                currentCommit);
                await this.options.stateManager.saveState(nextState);
                console.log("Embedding pipeline finished: Deletions processed, no new chunks generated.");
                return;
            }
            // 7. Aggregate all generated chunks from all files into a single list for embedding
            const allChunksToEmbed = [];
            for (const [sourceFile, chunks] of fileChunksMap.entries()) {
                chunks.forEach(chunk => {
                    allChunksToEmbed.push({ chunk, sourceFile });
                });
            }
            console.log(`Prepared ${allChunksToEmbed.length} total chunks for embedding from ${fileChunksMap.size} files.`);
            // 8. Generate embeddings for all chunk texts in batches
            const chunkTexts = allChunksToEmbed.map(item => item.chunk.text);
            const embeddings = await this.options.embeddingService.embedTexts(chunkTexts);
            // 9. Prepare Qdrant points (ID, vector, payload) and track which points belong to which file
            const pointsToUpsert = [];
            // Temporary state to track file -> [new point IDs] mapping for this run
            const newFilePointsState = {};
            for (let i = 0; i < allChunksToEmbed.length; i++) {
                const { chunk, sourceFile } = allChunksToEmbed[i];
                const embedding = embeddings[i];
                const pointId = randomUUID(); // Generate a unique ID for each chunk/point
                pointsToUpsert.push({
                    id: pointId,
                    vector: embedding,
                    payload: {
                        text: chunk.text, // The chunk's text content
                        ...(chunk.metadata || {}), // Spread metadata from chunking (includes analysis results)
                        source: sourceFile, // Ensure the relative source path is in the payload
                    },
                });
                // Record the mapping from the source file to its newly generated point ID
                if (!newFilePointsState[sourceFile]) {
                    newFilePointsState[sourceFile] = [];
                }
                newFilePointsState[sourceFile].push(pointId);
            }
            console.log(`Prepared ${pointsToUpsert.length} points for Qdrant upsert.`);
            // 10. Upsert the prepared points into Qdrant in batches
            await this.options.qdrantManager.upsertPoints(pointsToUpsert);
            // 11. Calculate and save the final state *after* successful upsert
            // Get the current commit hash *after* all processing is done but *before* saving state.
            const currentCommit = await this.options.repositoryManager.getCurrentCommit();
            const finalState = this.options.stateManager.calculateNextState(previousState, filesToDeletePointsFor, // Files whose old points were targeted for deletion
            newFilePointsState, // Mapping of files to their new points successfully upserted in this run
            currentCommit // Current repository commit hash
            );
            await this.options.stateManager.saveState(finalState);
            console.log("Embedding pipeline completed successfully.");
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Embedding pipeline failed:", errorMessage);
            // Propagate the error to indicate failure to the caller (e.g., main.ts)
            throw error;
        }
    }
}
