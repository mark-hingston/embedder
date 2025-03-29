import { simpleGit, CheckRepoActions } from "simple-git";
/**
 * Manages interactions with the Git repository.
 * Responsible for checking repository validity, getting the current commit,
 * and listing files based on either all tracked files or changes since the last processed commit.
 */
export class RepositoryManager {
    baseDir;
    repo;
    constructor(baseDir) {
        this.baseDir = baseDir;
        // Initialize simple-git instance for the specified directory
        this.repo = simpleGit(this.baseDir);
    }
    /**
     * Checks if the base directory is the root of a Git repository.
     * Throws an error if it's not.
     */
    async checkRepository() {
        if (!(await this.repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
            throw new Error(`Directory ${this.baseDir} is not a git repository root.`);
        }
        console.log(`Confirmed ${this.baseDir} is a git repository root.`);
    }
    /**
     * Retrieves the current HEAD commit hash of the repository.
     * @returns A promise resolving to the commit hash string.
     */
    async getCurrentCommit() {
        // Use revparse to get the full commit hash of HEAD
        return (await this.repo.revparse(['HEAD'])).trim();
    }
    /**
     * Lists files to be processed and files whose points should be deleted.
     * If `diffOnly` is true and a previous commit exists in the state, it uses `git diff`.
     * Otherwise, or if the diff fails, it falls back to `git ls-files` (full scan).
     * @param diffOnly Flag indicating whether to perform a diff or a full scan.
     * @param previousState The state from the previous run, containing the last processed commit.
     * @returns A promise resolving to a FileChanges object.
     */
    async listFiles(diffOnly, previousState) {
        console.log(`Listing files in ${this.baseDir}...`);
        const filesToProcess = new Set();
        const filesToDeletePointsFor = new Set();
        // Determine if we can use git diff (requires diffOnly flag and a previous commit hash)
        let useDiff = diffOnly && !!previousState.lastProcessedCommit;
        let diffFailed = false;
        if (useDiff) {
            const lastCommit = previousState.lastProcessedCommit;
            console.log(`Attempting to process diff between ${lastCommit} and HEAD...`);
            try {
                // Get diff summary (status + paths) between last processed commit and current HEAD
                const diffOutput = await this.repo.diff([
                    "--name-status", // Output format: <status>\t<file1>[\t<file2>]
                    lastCommit,
                    "HEAD",
                ]);
                const diffSummary = diffOutput.split('\n').filter(line => line.trim() !== '');
                console.log(`Found ${diffSummary.length} changes between ${lastCommit} and HEAD.`);
                // Process each line of the diff output
                for (const line of diffSummary) {
                    const parts = line.split('\t');
                    const status = parts[0].trim(); // e.g., 'A', 'M', 'D', 'R100', 'C050'
                    const path1 = parts[1].trim(); // Old path for R/C, path for A/M/D/T
                    const path2 = parts.length > 2 ? parts[2].trim() : null; // New path for R/C
                    if (status.startsWith('A')) { // Added
                        filesToProcess.add(path1);
                    }
                    else if (status.startsWith('M') || status.startsWith('T')) { // Modified or Type Changed
                        filesToProcess.add(path1);
                        // Existing points for modified files need deletion before upserting new ones
                        if (previousState.files[path1])
                            filesToDeletePointsFor.add(path1);
                    }
                    else if (status.startsWith('C')) { // Copied
                        const targetPath = path2 ?? path1; // path2 should exist for Copy
                        filesToProcess.add(targetPath);
                        // Points for the original path (path1) are *not* deleted unless path1 was also modified/deleted separately.
                    }
                    else if (status.startsWith('R')) { // Renamed
                        const oldPath = path1;
                        const newPath = path2 ?? path1; // path2 should exist for Rename
                        filesToProcess.add(newPath);
                        // Points associated with the old path need deletion
                        if (previousState.files[oldPath])
                            filesToDeletePointsFor.add(oldPath);
                    }
                    else if (status.startsWith('D')) { // Deleted
                        // Points associated with the deleted path need deletion
                        if (previousState.files[path1])
                            filesToDeletePointsFor.add(path1);
                    }
                }
            }
            catch (error) {
                // Handle cases where diff fails (e.g., initial commit, invalid lastCommit hash)
                console.warn(`Could not get diff from ${lastCommit}. Falling back to listing all tracked files. Error: ${error}`);
                diffFailed = true;
                useDiff = false; // Force full scan on failure
            }
        }
        // Fallback: If not using diff, or if diff failed, list all currently tracked files
        if (!useDiff || diffFailed) {
            console.log("Processing all tracked files (diffOnly=false or diff fallback)...");
            // Get all files currently tracked by Git
            const gitFiles = (await this.repo.raw(["ls-files"])).split("\n").filter(Boolean);
            console.log(`Found ${gitFiles.length} files via ls-files.`);
            const currentFilesSet = new Set(gitFiles);
            // Mark all currently tracked files for potential processing
            gitFiles.forEach(file => filesToProcess.add(file));
            // Identify files that were in the previous state but are *not* currently tracked (i.e., deleted)
            const previouslyKnownFiles = Object.keys(previousState.files);
            previouslyKnownFiles.forEach(knownFile => {
                if (!currentFilesSet.has(knownFile)) {
                    filesToDeletePointsFor.add(knownFile);
                }
                else if (!diffOnly) {
                    // If doing a full scan (not diffOnly), existing files also need their old points deleted
                    // before potentially being re-processed and getting new points.
                    filesToDeletePointsFor.add(knownFile);
                }
            });
        }
        console.log(`Identified ${filesToProcess.size} candidates for processing, ${filesToDeletePointsFor.size} files for potential point deletion.`);
        return { filesToProcess, filesToDeletePointsFor };
    }
}
