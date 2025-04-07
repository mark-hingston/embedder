// src/blobStateManager.ts
import { BlobServiceClient, ContainerClient, BlockBlobClient, StorageSharedKeyCredential, RestError } from "@azure/storage-blob";
import { StateManager, FilePointsState, EMPTY_STATE } from "./stateManager.js";
import { Chunk } from "./chunk.js";

/**
 * Manages loading and saving the application's state to Azure Blob Storage.
 * The state includes the mapping of processed files to their corresponding
 * Qdrant point IDs and the last processed Git commit hash.
 */
export class BlobStateManager implements StateManager {
  private containerClient: ContainerClient;
  private blobName: string;

  /**
   * Creates an instance of BlobStateManager.
   * @param connectionString Azure Storage connection string.
   * @param containerName The name of the blob container to use.
   * @param blobName The name of the blob file to store the state (e.g., 'embedding-state.json').
   */
  constructor(connectionString: string, containerName: string, blobName: string) {
    if (!connectionString) {
        throw new Error("Azure Storage connection string is required for BlobStateManager.");
    }
    if (!containerName) {
        throw new Error("Azure Storage container name is required for BlobStateManager.");
    }
    if (!blobName) {
        throw new Error("Azure Storage blob name is required for BlobStateManager.");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    this.containerClient = blobServiceClient.getContainerClient(containerName);
    this.blobName = blobName;
    console.log(`BlobStateManager initialized for container '${containerName}', blob '${blobName}'.`);
  }

  /**
   * Ensures the configured blob container exists.
   */
  async ensureContainerExists(): Promise<void> {
    try {
        const exists = await this.containerClient.exists();
        if (!exists) {
            console.log(`Container '${this.containerClient.containerName}' does not exist. Creating...`);
            await this.containerClient.create();
            console.log(`Container '${this.containerClient.containerName}' created successfully.`);
        } else {
             console.log(`Container '${this.containerClient.containerName}' already exists.`);
        }
    } catch (error) {
        console.error(`Error ensuring container '${this.containerClient.containerName}' exists:`, error);
        throw error; // Propagate error
    }
  }


  private getBlockBlobClient(): BlockBlobClient {
    return this.containerClient.getBlockBlobClient(this.blobName);
  }

  /**
   * Loads the state from the configured blob.
   * Handles blob not found errors by returning an empty state.
   * Handles potential JSON parsing errors.
   * @returns A promise resolving to the loaded FilePointsState.
   */
  async loadState(): Promise<FilePointsState> {
    const blobClient = this.getBlockBlobClient();
    try {
      const downloadResponse = await blobClient.downloadToBuffer();
      const stateString = downloadResponse.toString("utf8");
      const state = JSON.parse(stateString);
      console.log(
        `Loaded state for ${Object.keys(state.files || {}).length} files (Commit: ${state.lastProcessedCommit || 'N/A'}) from blob '${this.blobName}'`
      );

      // Basic validation/migration could be added here if needed
      if (!state.files) {
          state.files = {};
      }

      return state as FilePointsState;

    } catch (error: unknown) {
      // Check if it's a "BlobNotFound" error (404)
      if (error instanceof RestError && error.statusCode === 404) {
        console.log(`State blob '${this.blobName}' not found in container '${this.containerClient.containerName}'. Starting with empty state.`);
        return { ...EMPTY_STATE }; // Return a copy
      } else {
        // Log other errors (parsing, network, permissions) as warnings and proceed with empty state
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(
          `Warning: Could not read or parse state blob '${this.blobName}': ${errorMessage}. Proceeding with empty state.`
        );
        return { ...EMPTY_STATE }; // Return a copy
      }
    }
  }

  /**
   * Saves the provided state to the configured blob, overwriting if it exists.
   * @param state The FilePointsState object to save.
   */
  async saveState(state: FilePointsState): Promise<void> {
    const numFiles = Object.keys(state.files).length;
    console.log(`Saving state for ${numFiles} files (Commit: ${state.lastProcessedCommit || 'N/A'}) to blob '${this.blobName}'...`);
    const blobClient = this.getBlockBlobClient();
    try {
      const stateString = JSON.stringify(state, null, 2); // Pretty-print JSON
      const buffer = Buffer.from(stateString, "utf8");
      await blobClient.uploadData(buffer, {
          blobHTTPHeaders: { blobContentType: "application/json" }
      });
      console.log(`State blob '${this.blobName}' saved successfully.`);
    } catch (error) {
      console.error(`ERROR saving state blob '${this.blobName}': ${error}`);
      throw error; // Re-throw the original error to signal failure
    }
  }

  // --- Pure Logic Methods (copied/adapted from original StateManager) ---

  getPointsForFiles(files: Set<string>, currentState: FilePointsState): string[] {
    const pointIds = new Set<string>();
    for (const file of files) {
        if (currentState.files[file]) {
            currentState.files[file].forEach(id => pointIds.add(id));
        }
    }
    return Array.from(pointIds);
  }

  calculateNextState(
    currentState: FilePointsState,
    filesToDeletePointsFor: Set<string>,
    newFilePoints: Record<string, string[]>, // Points successfully upserted in this run
    pendingChunks?: Record<string, Chunk[]>, // Chunks generated but not yet upserted
    currentCommit?: string
  ): FilePointsState {
    const nextFilesState = { ...currentState.files };

    for (const file of filesToDeletePointsFor) {
        delete nextFilesState[file];
    }

    for (const [file, points] of Object.entries(newFilePoints)) {
        nextFilesState[file] = points;
    }

    // Also remove pending chunks for files whose points are being deleted/updated
    const nextPendingChunks = { ...(currentState.pendingChunks ?? {}) };
    for (const file of filesToDeletePointsFor) {
        delete nextPendingChunks[file];
    }
    // Add any new pending chunks from this run
    if (pendingChunks) {
        for (const [file, chunks] of Object.entries(pendingChunks)) {
            nextPendingChunks[file] = chunks;
        }
    }


    const nextState: FilePointsState = {
      files: nextFilesState,
      pendingChunks: Object.keys(nextPendingChunks).length > 0 ? nextPendingChunks : undefined, // Store only if not empty
      lastProcessedCommit: currentCommit ?? currentState.lastProcessedCommit
    };

    return nextState;
  }
}