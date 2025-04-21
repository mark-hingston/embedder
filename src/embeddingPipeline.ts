import { randomUUID } from "crypto";
import { Chunk } from "./chunk.js";
import { EmbeddingPipelineOptions } from "./embeddingPipelineOptions.js";
import { QdrantPoint } from "./qdrantManager.js";

/**
 * Orchestrates the entire process of embedding repository files into Qdrant.
 * Coordinates various managers and services (Git, File Processing, Chunking, Embedding, Qdrant, State).
 */
export class EmbeddingPipeline {
    private options: EmbeddingPipelineOptions;

    constructor(options: EmbeddingPipelineOptions) {
        this.options = options;
    }

    /**
     * Executes the embedding pipeline steps.
     */
    async run(): Promise<void> {
        console.log("Starting embedding pipeline...");
        try {
            // 0. Initial setup and validation
            await this.options.repositoryManager.checkRepository();
            await this.options.qdrantManager.ensureCollectionExists();

            // 1. Load the previous processing state (last commit, processed files/points)
            const previousState = await this.options.stateManager.loadState();

            // 2. Determine the base commit for diffing, if applicable
            let diffBaseCommit: string | undefined = undefined;
            if (this.options.diffFromCommit) {
                console.log(`Using provided commit ${this.options.diffFromCommit} as diff base.`);
                diffBaseCommit = this.options.diffFromCommit;
            } else if (this.options.diffOnly && previousState.lastProcessedCommit) {
                console.log(`Using last processed commit ${previousState.lastProcessedCommit} from state as diff base.`);
                diffBaseCommit = previousState.lastProcessedCommit;
            } else {
                console.log("No valid diff base commit provided or found in state; performing full scan.");
            }

            // 2b. Determine which files need processing based on Git changes (diff or full scan)
            const { filesToProcess, filesToDeletePointsFor } = await this.options.repositoryManager.listFiles(
                diffBaseCommit, // Pass the determined base commit (or undefined)
                previousState
            );

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
                const nextState = this.options.stateManager.calculateNextState(
                    previousState,
                    filesToDeletePointsFor,
                    {}, // No new points
                    undefined, // No pending chunks either
                    currentCommit
                );
                await this.options.stateManager.saveState(nextState);
                console.log("Embedding pipeline finished: Only deletions were processed.");
                return;
            }

            // 6. Chunk the content of processable files, including LLM analysis metadata
            const fileChunksMap = await this.options.chunker.chunkFiles(
                processableFiles,
                this.options.maxConcurrentChunking
            );

            // Early exit if no chunks were generated (e.g., all files were empty or failed chunking),
            // but still save state reflecting deletions.
            if (fileChunksMap.size === 0) {
                console.log("No chunks were generated from the files processed.");
                const currentCommit = await this.options.repositoryManager.getCurrentCommit();
                const nextState = this.options.stateManager.calculateNextState(
                    previousState,
                    filesToDeletePointsFor,
                    {}, // No new points
                    undefined, // No pending chunks either
                    currentCommit
                );
                await this.options.stateManager.saveState(nextState);
                console.log("Embedding pipeline finished: Deletions processed, no new chunks generated.");
                return;
            }

            // 7. Combine pending chunks (if any) with newly generated chunks
            const allChunksToProcessMap = new Map<string, Chunk[]>();
            let pendingChunkCount = 0;
            let newChunkCount = 0;

            // Add pending chunks from previous state
            if (previousState.pendingChunks && Object.keys(previousState.pendingChunks).length > 0) {
                console.log(`Resuming with ${Object.keys(previousState.pendingChunks).length} files containing pending chunks from previous run.`);
                for (const [sourceFile, chunks] of Object.entries(previousState.pendingChunks)) {
                    allChunksToProcessMap.set(sourceFile, chunks);
                    pendingChunkCount += chunks.length;
                }
            }

            // Add newly generated chunks (overwriting pending ones for the same file if reprocessing occurred)
            for (const [sourceFile, chunks] of fileChunksMap.entries()) {
                 // If we are reprocessing a file that also had pending chunks, the new chunks take precedence.
                 // The old points were deleted earlier, and the pending state for this file will be overwritten below.
                allChunksToProcessMap.set(sourceFile, chunks);
                if (!previousState.pendingChunks?.[sourceFile]) { // Avoid double counting if file was pending and re-chunked
                   newChunkCount += chunks.length;
                } else {
                    // Adjust counts if overwriting pending chunks
                    pendingChunkCount -= previousState.pendingChunks[sourceFile].length;
                    newChunkCount += chunks.length;
                }
            }

            // Aggregate all chunks into a list for embedding
            const allChunksToEmbed: { chunk: Chunk; sourceFile: string }[] = [];
            for (const [sourceFile, chunks] of allChunksToProcessMap.entries()) {
                chunks.forEach(chunk => {
                    allChunksToEmbed.push({ chunk, sourceFile });
                });
            }

            if (allChunksToEmbed.length === 0) {
                 console.log("No pending or new chunks to process.");
                 // Save state reflecting only deletions and commit hash
                 const currentCommit = await this.options.repositoryManager.getCurrentCommit();
                 const finalState = this.options.stateManager.calculateNextState(
                     previousState,
                     filesToDeletePointsFor,
                     {}, // No new points upserted
                     undefined, // No pending chunks remain
                     currentCommit
                 );
                 await this.options.stateManager.saveState(finalState);
                 console.log("Embedding pipeline finished: No chunks to embed.");
                 return;
            }

            console.log(`Prepared ${allChunksToEmbed.length} total chunks (${pendingChunkCount} pending, ${newChunkCount} new) for embedding from ${allChunksToProcessMap.size} files.`);

            // 7.5 Save intermediate state *before* embedding, including all chunks marked as pending
            console.log("Saving intermediate state with pending chunks before embedding...");
            const intermediateCommit = await this.options.repositoryManager.getCurrentCommit(); // Get commit hash *now*
            const intermediateState = this.options.stateManager.calculateNextState(
                previousState,
                filesToDeletePointsFor, // Files whose old points were deleted
                {},                    // No points have been upserted *yet* in this stage
                Object.fromEntries(allChunksToProcessMap.entries()), // Mark *all* current chunks as pending
                intermediateCommit
            );
            await this.options.stateManager.saveState(intermediateState);
            console.log("Intermediate state saved.");

            // 8. Generate embeddings for all chunk texts in batches
            const chunkTexts = allChunksToEmbed.map(item => item.chunk.text);
            const embeddings = await this.options.embeddingService.embedTexts(chunkTexts);

            // 9. Prepare Qdrant points (ID, vector, payload) and track which points belong to which file
            const pointsToUpsert: QdrantPoint[] = [];
            // Temporary state to track file -> [new point IDs] mapping for this run
            const newFilePointsState: Record<string, string[]> = {};

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
            const finalState = this.options.stateManager.calculateNextState(
                intermediateState, // Start from the state we saved before embedding
                new Set<string>(), // No *additional* files need points deleted at this stage
                newFilePointsState, // Mapping of files to their new points successfully upserted in this run
                undefined,          // Crucially, clear pending chunks as embedding/upsert succeeded
                currentCommit       // Current repository commit hash
            );
            await this.options.stateManager.saveState(finalState);

            console.log("Embedding pipeline completed successfully.");

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("Embedding pipeline failed:", errorMessage);
            // Propagate the error to indicate failure to the caller (e.g., main.ts)
            throw error;
        }
    }
}