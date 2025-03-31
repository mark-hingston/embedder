import { promises as fs } from 'fs';
import path from 'path';
import { EMPTY_STATE } from './stateManager.js';
/**
 * Implements the StateManager interface using the local file system.
 * Stores the state in a JSON file.
 */
export class FileStateManager {
    stateFilePath;
    /**
     * Creates an instance of FileStateManager.
     * @param stateFilePath The absolute or relative path to the JSON file where the state will be stored.
     */
    constructor(stateFilePath) {
        // Ensure the path is absolute or resolve it relative to the current working directory
        this.stateFilePath = path.resolve(stateFilePath);
        console.log(`FileStateManager initialized. State file path: ${this.stateFilePath}`);
    }
    /**
     * Ensures the directory for the state file exists.
     */
    async ensureStateDirectoryExists() {
        const dir = path.dirname(this.stateFilePath);
        try {
            await fs.mkdir(dir, { recursive: true });
            console.log(`Ensured state directory exists: ${dir}`);
        }
        catch (error) {
            // Ignore EEXIST error (directory already exists)
            if (error.code !== 'EEXIST') {
                console.error(`Error creating state directory ${dir}:`, error);
                throw error; // Re-throw other errors
            }
            console.log(`State directory already exists: ${dir}`);
        }
    }
    /**
     * Loads the state from the JSON file.
     * If the file doesn't exist, returns the EMPTY_STATE.
     * @returns A promise resolving to the loaded FilePointsState.
     */
    async loadState() {
        try {
            await this.ensureStateDirectoryExists(); // Ensure directory exists before reading
            const data = await fs.readFile(this.stateFilePath, 'utf-8');
            const state = JSON.parse(data);
            console.log(`State loaded successfully from ${this.stateFilePath}`);
            // Basic validation
            if (!state || typeof state.files !== 'object') {
                console.warn(`Invalid state format found in ${this.stateFilePath}. Returning empty state.`);
                return { ...EMPTY_STATE }; // Return a copy
            }
            return state;
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`State file ${this.stateFilePath} not found. Returning empty state.`);
                return { ...EMPTY_STATE }; // Return a copy if file doesn't exist
            }
            console.error(`Error loading state from ${this.stateFilePath}:`, error);
            throw error; // Re-throw other errors
        }
    }
    /**
     * Saves the provided state to the JSON file.
     * @param state The FilePointsState object to save.
     */
    async saveState(state) {
        try {
            await this.ensureStateDirectoryExists(); // Ensure directory exists before writing
            const data = JSON.stringify(state, null, 2); // Pretty print JSON
            await fs.writeFile(this.stateFilePath, data, 'utf-8');
            console.log(`State saved successfully to ${this.stateFilePath}`);
        }
        catch (error) {
            console.error(`Error saving state to ${this.stateFilePath}:`, error);
            throw error;
        }
    }
    /**
    * Retrieves all Qdrant point IDs associated with a given set of file paths from the current state.
    * @param files A set of relative file paths.
    * @param currentState The current FilePointsState.
    * @returns An array of unique Qdrant point IDs.
    */
    getPointsForFiles(files, currentState) {
        const pointIds = new Set();
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
        const nextStateFiles = { ...currentState.files };
        // Remove entries for files whose points were deleted
        for (const file of filesToDeletePointsFor) {
            delete nextStateFiles[file];
        }
        // Add or update entries for newly processed files
        for (const file in newFilePoints) {
            // It's crucial to overwrite here, as calculateNextState is called *after*
            // old points for modified files have already been deleted from Qdrant.
            nextStateFiles[file] = newFilePoints[file];
        }
        return {
            files: nextStateFiles,
            lastProcessedCommit: currentCommit ?? currentState.lastProcessedCommit, // Keep old commit if new one isn't provided
        };
    }
}
