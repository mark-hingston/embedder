import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { EMPTY_STATE } from "./stateManager.js";
/**
 * Manages loading and saving the application's state to Azure Blob Storage.
 * The state includes the mapping of processed files to their corresponding
 * Qdrant point IDs and the last processed Git commit hash.
 */
export class BlobStateManager {
    containerClient;
    blobName;
    /**
     * Creates an instance of BlobStateManager.
     * @param connectionString Azure Storage connection string.
     * @param containerName The name of the blob container to use.
     */
    constructor(connectionString, containerName) {
        if (!connectionString) {
            throw new Error("Azure Storage connection string is required for BlobStateManager.");
        }
        if (!containerName) {
            throw new Error("Azure Storage container name is required for BlobStateManager.");
        }
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        this.containerClient = blobServiceClient.getContainerClient(containerName);
        this.blobName = "file-points.json";
        console.log(`BlobStateManager initialised for container '${containerName}', blob '${this.blobName}'.`);
    }
    /**
     * Ensures the configured blob container exists.
     */
    async ensureContainerExists() {
        try {
            const exists = await this.containerClient.exists();
            if (!exists) {
                console.log(`Container '${this.containerClient.containerName}' does not exist. Creating...`);
                await this.containerClient.create();
                console.log(`Container '${this.containerClient.containerName}' created successfully.`);
            }
            else {
                console.log(`Container '${this.containerClient.containerName}' already exists.`);
            }
        }
        catch (error) {
            console.error(`Error ensuring container '${this.containerClient.containerName}' exists:`, error);
            throw error; // Propagate error
        }
    }
    getBlockBlobClient() {
        return this.containerClient.getBlockBlobClient(this.blobName);
    }
    /**
     * Loads the state from the configured blob.
     * Handles blob not found errors by returning an empty state.
     * Handles potential JSON parsing errors.
     * @returns A promise resolving to the loaded FilePointsState.
     */
    async loadState() {
        const blobClient = this.getBlockBlobClient();
        try {
            const downloadResponse = await blobClient.downloadToBuffer();
            const stateString = downloadResponse.toString("utf8");
            const state = JSON.parse(stateString);
            console.log(`Loaded state for ${Object.keys(state.files || {}).length} files (Commit: ${state.lastProcessedCommit || 'N/A'}) from blob '${this.blobName}'`);
            // Basic validation/migration could be added here if needed
            if (!state.files) {
                state.files = {};
            }
            // Ensure pendingChunks is present if needed, or default to empty
            if (!state.pendingChunks) {
                state.pendingChunks = {};
            }
            return state;
        }
        catch (error) {
            // Check if it's a "BlobNotFound" error (404)
            if (error instanceof RestError && error.statusCode === 404) {
                console.log(`State blob '${this.blobName}' not found in container '${this.containerClient.containerName}'. Starting with empty state.`);
                return { ...EMPTY_STATE }; // Return a copy
            }
            else {
                // Log other errors (parsing, network, permissions) as warnings and proceed with empty state
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.warn(`Warning: Could not read or parse state blob '${this.blobName}': ${errorMessage}. Proceeding with empty state.`);
                return { ...EMPTY_STATE }; // Return a copy
            }
        }
    }
    /**
     * Saves the provided state to the configured blob, overwriting if it exists.
     * @param state The FilePointsState object to save.
     */
    async saveState(state) {
        const numFilesWithPoints = Object.keys(state.files).length;
        const numFilesWithPending = state.pendingChunks ? Object.keys(state.pendingChunks).length : 0;
        let logMessage = `Saving state (Commit: ${state.lastProcessedCommit || 'N/A'}) to blob '${this.blobName}'...`;
        if (numFilesWithPending > 0) {
            logMessage += `\n  - Files with successfully processed points: ${numFilesWithPoints}`;
            logMessage += `\n  - Files with pending chunks: ${numFilesWithPending}`;
        }
        else {
            // Keep simpler format if no pending chunks
            logMessage = `Saving state for ${numFilesWithPoints} files (Commit: ${state.lastProcessedCommit || 'N/A'}) to blob '${this.blobName}'...`;
        }
        console.log(logMessage);
        const blobClient = this.getBlockBlobClient();
        try {
            // Ensure pendingChunks is defined (as empty obj) if null/undefined before stringifying
            const stateToSave = {
                ...state,
                pendingChunks: state.pendingChunks ?? {}
            };
            const stateString = JSON.stringify(stateToSave, null, 2); // Pretty-print JSON
            const buffer = Buffer.from(stateString, "utf8");
            await blobClient.uploadData(buffer, {
                blobHTTPHeaders: { blobContentType: "application/json" }
            });
            console.log(`State blob '${this.blobName}' saved successfully.`);
        }
        catch (error) {
            console.error(`ERROR saving state blob '${this.blobName}': ${error}`);
            throw error; // Re-throw the original error to signal failure
        }
    }
    /**
       * Loads the vocabulary from a separate blob.
       * @returns A promise resolving to the loaded Vocabulary object or undefined if not found.
       */
    async loadVocabulary() {
        const vocabularyBlobName = this.blobName.replace(/\.json$/, '-vocabulary.json'); // Use a distinct blob name
        const blobClient = this.containerClient.getBlockBlobClient(vocabularyBlobName);
        try {
            const downloadResponse = await blobClient.downloadToBuffer();
            const vocabularyString = downloadResponse.toString("utf8");
            const vocabulary = JSON.parse(vocabularyString);
            console.log(`Loaded vocabulary with ${Object.keys(vocabulary).length} terms from blob '${vocabularyBlobName}'`);
            return vocabulary;
        }
        catch (error) {
            if (error instanceof RestError && error.statusCode === 404) {
                console.log(`Vocabulary blob '${vocabularyBlobName}' not found. Returning undefined.`);
                return undefined;
            }
            else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.warn(`Warning: Could not read or parse vocabulary blob '${vocabularyBlobName}': ${errorMessage}. Returning undefined.`);
                return undefined;
            }
        }
    }
    /**
     * Saves the provided vocabulary to a separate blob, overwriting if it exists.
     * @param vocabulary The Vocabulary object to save.
     */
    async saveVocabulary(vocabulary) {
        const vocabularyBlobName = 'vocabulary.json';
        console.log(`Saving vocabulary with ${Object.keys(vocabulary).length} terms to blob '${vocabularyBlobName}'...`);
        const blobClient = this.containerClient.getBlockBlobClient(vocabularyBlobName);
        try {
            const vocabularyString = JSON.stringify(vocabulary, null, 2); // Pretty-print JSON
            const buffer = Buffer.from(vocabularyString, "utf8");
            await blobClient.uploadData(buffer, {
                blobHTTPHeaders: { blobContentType: "application/json" }
            });
            console.log(`Vocabulary blob '${vocabularyBlobName}' saved successfully.`);
        }
        catch (error) {
            console.error(`ERROR saving vocabulary blob '${vocabularyBlobName}': ${error}`);
            throw error; // Re-throw the original error
        }
    }
    // --- Pure Logic Methods (copied/adapted from original StateManager) ---
    getPointsForFiles(files, currentState) {
        const pointIds = new Set();
        for (const file of files) {
            // Ensure currentState.files[file] exists before trying to iterate
            if (currentState.files && currentState.files[file]) {
                currentState.files[file].forEach(id => pointIds.add(id));
            }
        }
        return Array.from(pointIds);
    }
    /**
     * Calculates the next state based on the current state, files marked for deletion,
     * and the mapping of files to newly generated points from the current run.
     * @param currentState The state loaded at the beginning of the run, or the intermediate state.
     * @param filesToDeletePointsFor Set of relative file paths whose points should be removed from the state.
     * @param newFilePoints A record mapping relative file paths to arrays of *new* Qdrant point IDs generated in this run.
     * @param pendingChunks Chunks generated but not yet upserted. **Crucially: If `undefined`, it signifies that all pending chunks from `currentState` should be cleared (used when calculating final state after successful upsert).** If an object (even empty), it represents the new set of pending chunks (used when calculating intermediate state).
     * @param currentCommit The current Git commit hash to store in the next state.
     * @returns The calculated next FilePointsState.
     */
    calculateNextState(currentState, filesToDeletePointsFor, newFilePoints, // Points successfully upserted in this run
    pendingChunks, // See JSDoc above for behavior
    currentCommit) {
        // Ensure currentState has files and pendingChunks initialised if they are missing
        const currentFiles = currentState.files ?? {};
        const currentPending = currentState.pendingChunks ?? {};
        const nextFilesState = { ...currentFiles };
        // Remove entries for files whose points were deleted/updated
        for (const file of filesToDeletePointsFor) {
            delete nextFilesState[file];
        }
        // Add or update entries for newly processed files
        // Overwrite is correct here, as old points were deleted earlier.
        for (const [file, points] of Object.entries(newFilePoints)) {
            nextFilesState[file] = points;
        }
        // --- Corrected Pending Chunks Logic ---
        let finalPendingChunks = undefined;
        // Case 1: Calculating INTERMEDIATE state (pendingChunks argument is provided)
        if (pendingChunks !== undefined) {
            // Start with pending chunks from the state we are basing this on
            const updatedPending = { ...currentPending };
            // Remove pending chunks for files whose associated points in `currentState`
            // are being deleted/updated now.
            for (const file of filesToDeletePointsFor) {
                delete updatedPending[file];
            }
            // Add/overwrite with the *new* pending chunks passed in the argument
            for (const [file, chunks] of Object.entries(pendingChunks)) {
                updatedPending[file] = chunks;
            }
            // Only keep the pending field if it's not empty after updates
            if (Object.keys(updatedPending).length > 0) {
                finalPendingChunks = updatedPending;
            }
            // If updatedPending is empty, finalPendingChunks remains undefined
        }
        // Case 2: Calculating FINAL state (pendingChunks argument is undefined)
        // In this case, finalPendingChunks simply remains undefined, effectively clearing them.
        // --- End Corrected Logic ---
        return {
            files: nextFilesState,
            pendingChunks: finalPendingChunks, // Use the correctly calculated value (will be undefined for final state)
            lastProcessedCommit: currentCommit ?? currentState.lastProcessedCommit, // Keep old commit if new one isn't provided
        };
    }
}
