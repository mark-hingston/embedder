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
        this.stateFilePath = path.resolve(stateFilePath);
        console.log(`FileStateManager initialised. State file path: ${this.stateFilePath}`);
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
            if (error.code !== 'EEXIST') {
                console.error(`Error creating state directory ${dir}:`, error);
                throw error;
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
            if (!state || typeof state.files !== 'object') {
                console.warn(`Invalid state format found in ${this.stateFilePath} (missing 'files' object). Returning empty state.`);
                return { ...EMPTY_STATE }; // Return a copy
            }
            if (state.pendingChunks === undefined || state.pendingChunks === null) {
                state.pendingChunks = {};
            }
            return state;
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`State file ${this.stateFilePath} not found. Returning empty state.`);
                return { ...EMPTY_STATE }; // Return a copy if file doesn't exist
            }
            console.error(`Error loading state from ${this.stateFilePath}:`, error);
            console.warn(`Returning empty state due to load error.`);
            return { ...EMPTY_STATE };
        }
    }
    /**
     * Saves the provided state to the JSON file.
     * @param state The FilePointsState object to save.
     */
    async saveState(state) {
        try {
            await this.ensureStateDirectoryExists(); // Ensure directory exists before writing
            const stateToSave = {
                ...state,
                pendingChunks: state.pendingChunks ?? {}
            };
            const data = JSON.stringify(stateToSave, null, 2);
            await fs.writeFile(this.stateFilePath, data, 'utf-8');
            const numFilesWithPoints = Object.keys(stateToSave.files).length;
            const numFilesWithPending = Object.keys(stateToSave.pendingChunks).length;
            let logMessage = `State saved successfully to ${this.stateFilePath} (Commit: ${state.lastProcessedCommit || 'N/A'})`;
            if (numFilesWithPending > 0) {
                logMessage += `\n  - Files with successfully processed points: ${numFilesWithPoints}`;
                logMessage += `\n  - Files with pending chunks: ${numFilesWithPending}`;
            }
            else {
                logMessage = `State saved successfully for ${numFilesWithPoints} files to ${this.stateFilePath} (Commit: ${state.lastProcessedCommit || 'N/A'})`;
            }
            console.log(logMessage);
        }
        catch (error) {
            console.error(`Error saving state to ${this.stateFilePath}:`, error);
            throw error;
        }
    }
    /**
     * Loads the vocabulary from a separate JSON file.
     * @returns A promise resolving to the loaded Vocabulary object or undefined if not found.
     */
    async loadVocabulary() {
        const vocabularyFilePath = this.stateFilePath.replace(/\.json$/, '-vocabulary.json');
        try {
            await this.ensureStateDirectoryExists(); // Ensure directory exists before reading
            const data = await fs.readFile(vocabularyFilePath, 'utf-8');
            const vocabulary = JSON.parse(data);
            console.log(`Vocabulary loaded successfully from ${vocabularyFilePath}`);
            return vocabulary;
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`Vocabulary file ${vocabularyFilePath} not found. Returning undefined.`);
                return undefined;
            }
            console.error(`Error loading vocabulary from ${vocabularyFilePath}:`, error);
            console.warn(`Returning undefined due to vocabulary load error.`);
            return undefined;
        }
    }
    /**
     * Saves the provided vocabulary to a separate JSON file.
     * @param vocabulary The Vocabulary object to save.
     */
    async saveVocabulary(vocabulary) {
        const vocabularyFilePath = this.stateFilePath.replace(/\.json$/, '-vocabulary.json');
        console.log(`Saving vocabulary with ${Object.keys(vocabulary).length} terms to ${vocabularyFilePath}...`);
        try {
            await this.ensureStateDirectoryExists(); // Ensure directory exists before writing
            const data = JSON.stringify(vocabulary, null, 2);
            await fs.writeFile(vocabularyFilePath, data, 'utf-8');
            console.log(`Vocabulary saved successfully to ${vocabularyFilePath}.`);
        }
        catch (error) {
            console.error(`Error saving vocabulary to ${vocabularyFilePath}:`, error);
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
        const currentFiles = currentState.files ?? {};
        const currentPending = currentState.pendingChunks ?? {};
        const nextFilesState = { ...currentFiles };
        for (const file of filesToDeletePointsFor) {
            delete nextFilesState[file];
        }
        for (const [file, points] of Object.entries(newFilePoints)) {
            nextFilesState[file] = points;
        }
        let finalPendingChunks = undefined;
        if (pendingChunks !== undefined) {
            const updatedPending = { ...currentPending };
            for (const file of filesToDeletePointsFor) {
                delete updatedPending[file];
            }
            for (const [file, chunks] of Object.entries(pendingChunks)) {
                updatedPending[file] = chunks;
            }
            if (Object.keys(updatedPending).length > 0) {
                finalPendingChunks = updatedPending;
            }
        }
        return {
            files: nextFilesState,
            pendingChunks: finalPendingChunks,
            lastProcessedCommit: currentCommit ?? currentState.lastProcessedCommit,
        };
    }
}
