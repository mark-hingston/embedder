/**
 * Defines the structure of the state persisted between runs.
 */
export type FilePointsState = {
  /** A record mapping relative file paths to an array of Qdrant point IDs associated with that file. */
  files: Record<string, string[]>;
  /** The Git commit hash that was processed in the last successful run. Used for diffing. */
  lastProcessedCommit?: string;
};

/**
 * Interface for managing the application's state.
 * Implementations handle loading/saving the state (e.g., to a file system, blob storage).
 */
export interface StateManager {
  /**
   * Loads the state from the persistent store.
   * @returns A promise resolving to the loaded FilePointsState.
   */
  loadState(): Promise<FilePointsState>;

  /**
   * Saves the provided state to the persistent store.
   * @param state The FilePointsState object to save.
   */
  saveState(state: FilePointsState): Promise<void>;

 /**
   * Retrieves all Qdrant point IDs associated with a given set of file paths from the current state.
   * @param files A set of relative file paths.
   * @param currentState The current FilePointsState.
   * @returns An array of unique Qdrant point IDs.
   */
  getPointsForFiles(files: Set<string>, currentState: FilePointsState): string[];

  /**
   * Calculates the next state based on the current state, files marked for deletion,
   * and the mapping of files to newly generated points from the current run.
   * @param currentState The state loaded at the beginning of the run.
   * @param filesToDeletePointsFor Set of relative file paths whose points should be removed from the state.
   * @param newFilePoints A record mapping relative file paths to arrays of *new* Qdrant point IDs generated in this run.
   * @param currentCommit The current Git commit hash to store in the next state.
   * @returns The calculated next FilePointsState.
   */
  calculateNextState(
    currentState: FilePointsState,
    filesToDeletePointsFor: Set<string>,
    newFilePoints: Record<string, string[]>,
    currentCommit?: string
  ): FilePointsState;
}

// Default empty state constant
export const EMPTY_STATE: FilePointsState = { files: {}, lastProcessedCommit: undefined };