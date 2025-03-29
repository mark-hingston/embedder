import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { join } from "path";
import { fsExists } from "./utilities.js";
// Constants for state file names
const STATE_FILE_NAME = ".file-points.json";
const TEMP_STATE_FILE_NAME = ".file-points.json.tmp"; // Used for atomic writes
/**
 * Manages loading and saving the application's state to a JSON file.
 * The state includes the mapping of processed files to their corresponding
 * Qdrant point IDs and the last processed Git commit hash.
 * Uses a temporary file and atomic rename for safer writes.
 */
export class StateManager {
    baseDir;
    stateFilePath;
    tempStateFilePath;
    constructor(baseDir) {
        this.baseDir = baseDir;
        // Define paths relative to the base directory
        this.stateFilePath = join(this.baseDir, STATE_FILE_NAME);
        this.tempStateFilePath = join(this.baseDir, TEMP_STATE_FILE_NAME);
    }
    /**
     * Loads the state from the state file.
     * Handles file not found errors by returning an empty state.
     * Handles potential JSON parsing errors or legacy formats.
     * @returns A promise resolving to the loaded FilePointsState.
     */
    async loadState() {
        try {
            // Check existence and read permissions first
            await stat(this.stateFilePath);
            const fileContent = await readFile(this.stateFilePath, "utf8");
            const state = JSON.parse(fileContent);
            console.log(`Loaded state for ${Object.keys(state.files || {}).length} files (Commit: ${state.lastProcessedCommit || 'N/A'}) from ${STATE_FILE_NAME}`);
            // Handle potential legacy state format (where state was just Record<string, string[]>)
            if (!state.files && Object.keys(state).length > 0 && !state.lastProcessedCommit) {
                console.warn(`Converting legacy state format found in ${STATE_FILE_NAME} to new structure.`);
                return {
                    files: state, // Assume the old root object was the file map
                    lastProcessedCommit: undefined
                };
            }
            // Ensure the 'files' property exists, even if empty
            if (!state.files) {
                state.files = {};
            }
            return state;
        }
        catch (error) {
            // Handle specific "file not found" error
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                console.log(`${STATE_FILE_NAME} not found. Starting with empty state.`);
            }
            else {
                // Log other errors (parsing, permissions) as warnings and proceed with empty state
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.warn(`Warning: Could not read or parse ${STATE_FILE_NAME}: ${errorMessage}. Proceeding with empty state.`);
            }
            // Return a default empty state if loading fails
            return { files: {}, lastProcessedCommit: undefined };
        }
    }
    /**
     * Saves the provided state to the state file atomically.
     * Writes to a temporary file first, then renames it to the final state file path.
     * @param state The FilePointsState object to save.
     */
    async saveState(state) {
        const numFiles = Object.keys(state.files).length;
        console.log(`Saving state for ${numFiles} files (Commit: ${state.lastProcessedCommit || 'N/A'}) to ${STATE_FILE_NAME}...`);
        try {
            const stateString = JSON.stringify(state, null, 2); // Pretty-print JSON
            // Write to temporary file
            await writeFile(this.tempStateFilePath, stateString, "utf8");
            // Atomically rename temporary file to the actual state file
            await rename(this.tempStateFilePath, this.stateFilePath);
            console.log(`${STATE_FILE_NAME} saved successfully.`);
        }
        catch (error) {
            console.error(`ERROR saving state file ${STATE_FILE_NAME}: ${error}`);
            // Attempt to clean up the temporary file if it exists after an error
            try {
                if (await fsExists(this.tempStateFilePath)) {
                    await unlink(this.tempStateFilePath);
                    console.log(`Cleaned up temporary state file: ${this.tempStateFilePath}`);
                }
            }
            catch (cleanupError) {
                console.warn(`Warning: Failed to clean up temporary state file ${this.tempStateFilePath}: ${cleanupError}`);
            }
            throw error; // Re-throw the original error to signal failure
        }
    }
    /**
     * Retrieves all Qdrant point IDs associated with a given set of file paths from the current state.
     * @param files A set of relative file paths.
     * @param currentState The current FilePointsState.
     * @returns An array of unique Qdrant point IDs.
     */
    getPointsForFiles(files, currentState) {
        const pointIds = new Set(); // Use a Set to automatically handle duplicates
        for (const file of files) {
            if (currentState.files[file]) {
                currentState.files[file].forEach(id => pointIds.add(id));
            }
        }
        return Array.from(pointIds);
    }
    /**
     * Calculates the next state based on the current state, files marked for deletion,
     * and the mapping of files to newly generated points from the current run.
     * @param currentState The state loaded at the beginning of the run.
     * @param filesToDeletePointsFor Set of relative file paths whose points should be removed from the state.
     * @param newFilePoints A record mapping relative file paths to arrays of *new* Qdrant point IDs generated in this run.
     * @param currentCommit The current Git commit hash to store in the next state.
     * @returns The calculated next FilePointsState.
     */
    calculateNextState(currentState, filesToDeletePointsFor, newFilePoints, currentCommit) {
        // Start with a copy of the current state's files map
        const nextFilesState = { ...currentState.files };
        // Remove entries for files whose points were deleted or are being replaced
        for (const file of filesToDeletePointsFor) {
            delete nextFilesState[file];
        }
        // Add or overwrite entries with the newly generated points for processed files
        for (const [file, points] of Object.entries(newFilePoints)) {
            nextFilesState[file] = points;
        }
        // Construct the final next state object
        const nextState = {
            files: nextFilesState,
            // Update the commit hash if provided, otherwise keep the old one (should always be provided on success)
            lastProcessedCommit: currentCommit ?? currentState.lastProcessedCommit
        };
        return nextState;
    }
}
