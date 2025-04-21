import { simpleGit, SimpleGit, CheckRepoActions } from "simple-git";
import { FilePointsState } from "./stateManager.js";

/**
 * Interface describing the changes detected in the repository.
 */
export interface FileChanges {
    /** Set of relative file paths that are new, modified, copied, or renamed (new path). These need processing. */
    filesToProcess: Set<string>;
    /** Set of relative file paths whose old Qdrant points should be deleted (modified, renamed old path, deleted). */
    filesToDeletePointsFor: Set<string>;
}

/**
 * Manages interactions with the Git repository.
 * Responsible for checking repository validity, getting the current commit,
 * and listing files based on either all tracked files or changes since the last processed commit.
 */
export class RepositoryManager {
    private repo: SimpleGit;

    constructor(private baseDir: string) {
        // Initialize simple-git instance for the specified directory
        this.repo = simpleGit(this.baseDir);
    }

    /**
     * Checks if the base directory is the root of a Git repository.
     * Throws an error if it's not.
     */
    async checkRepository(): Promise<void> {
        if (!(await this.repo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT))) {
            throw new Error(`Directory ${this.baseDir} is not a git repository root.`);
        }
        console.log(`Confirmed ${this.baseDir} is a git repository root.`);
    }

    /**
     * Retrieves the current HEAD commit hash of the repository.
     * @returns A promise resolving to the commit hash string.
     */
    async getCurrentCommit(): Promise<string> {
        // Use revparse to get the full commit hash of HEAD
        return (await this.repo.revparse(['HEAD'])).trim();
    }

    /**
     * Lists files to be processed and files whose points should be deleted.
     * If `diffBaseCommit` is provided, it attempts a `git diff` from that commit to HEAD.
     * It tries to fetch full history (`--depth=0`) if the commit isn't found locally.
     * If `diffBaseCommit` is undefined, it falls back to `git ls-files` (full scan).
     * @param diffBaseCommit The commit hash to diff from, or undefined for a full scan.
     * @param previousState The state from the previous run, containing the last processed commit and file mappings.
     * @returns A promise resolving to a FileChanges object.
     * @throws Error if `diffBaseCommit` is provided but invalid/not found after fetching.
     */
    async listFiles(diffBaseCommit: string | undefined, previousState: FilePointsState): Promise<FileChanges> {
        console.log(`Listing files in ${this.baseDir}...`);
        const filesToProcess = new Set<string>();
        const filesToDeletePointsFor = new Set<string>();

        let useDiff = !!diffBaseCommit; // Use diff if a base commit is provided

        if (useDiff) {
            const baseCommit = diffBaseCommit!;
            console.log(`Attempting to process diff between ${baseCommit} and HEAD...`);

            try {
                // 1. Check if the base commit exists locally
                try {
                    await this.repo.raw(['cat-file', '-e', `${baseCommit}^{commit}`]);
                    console.log(`Commit ${baseCommit} found locally.`);
                } catch (checkError) {
                    // 2. If not local, attempt to fetch full history
                    console.warn(`Commit ${baseCommit} not found locally. Attempting to fetch full history (git fetch --depth=0)...`);
                    try {
                        await this.repo.fetch(['--depth=0']);
                        console.log("Fetch complete. Retrying commit check...");
                        // Re-check after fetch
                        await this.repo.raw(['cat-file', '-e', `${baseCommit}^{commit}`]);
                        console.log(`Commit ${baseCommit} found after fetch.`);
                    } catch (fetchOrRecheckError) {
                        console.error(`Failed to fetch or find commit ${baseCommit} after fetch.`, fetchOrRecheckError);
                        throw new Error(`Provided DIFF_FROM_COMMIT hash "${baseCommit}" is invalid or could not be found in the repository history even after fetching.`);
                    }
                }

                // 3. Perform the diff
                console.log(`Performing diff: ${baseCommit}..HEAD`);
                const diffOutput = await this.repo.diff([
                    "--name-status", // Output format: <status>\t<file1>[\t<file2>]
                    baseCommit,
                    "HEAD",
                ]);
                const diffSummary = diffOutput.split('\n').filter(line => line.trim() !== '');
                console.log(`Found ${diffSummary.length} changes between ${baseCommit} and HEAD.`);

                // 4. Process the diff output
                for (const line of diffSummary) {
                    const parts = line.split('\t');
                    const status = parts[0].trim(); // e.g., 'A', 'M', 'D', 'R100', 'C050'
                    const path1 = parts[1].trim(); // Old path for R/C, path for A/M/D/T
                    const path2 = parts.length > 2 ? parts[2].trim() : null; // New path for R/C

                    if (status.startsWith('A')) { // Added
                        filesToProcess.add(path1);
                    } else if (status.startsWith('M') || status.startsWith('T')) { // Modified or Type Changed
                        filesToProcess.add(path1);
                        // Existing points for modified files need deletion before upserting new ones
                        if (previousState.files[path1]) filesToDeletePointsFor.add(path1);
                    } else if (status.startsWith('C')) { // Copied
                        const targetPath = path2 ?? path1; // path2 should exist for Copy
                        filesToProcess.add(targetPath);
                        // Points for the original path (path1) are *not* deleted unless path1 was also modified/deleted separately.
                    } else if (status.startsWith('R')) { // Renamed
                        const oldPath = path1;
                        const newPath = path2 ?? path1; // path2 should exist for Rename
                        filesToProcess.add(newPath);
                        // Points associated with the old path need deletion
                        if (previousState.files[oldPath]) filesToDeletePointsFor.add(oldPath);
                    } else if (status.startsWith('D')) { // Deleted
                        // Points associated with the deleted path need deletion
                        if (previousState.files[path1]) filesToDeletePointsFor.add(path1);
                    }
                }
            } catch (diffError) {
                // This catch block now specifically handles failures *during the diff command itself*,
                // after the commit has been verified or fetched.
                console.error(`Error performing diff between ${baseCommit} and HEAD:`, diffError);
                // According to the plan, we should error out if the diff fails after verifying the commit
                throw new Error(`Failed to perform git diff between verified commit "${baseCommit}" and HEAD.`);
            }
        } else {
            // Full Scan Logic (if diffBaseCommit was undefined)
            console.log("Processing all tracked files (full scan)...");
            // Get all files currently tracked by Git
            const gitFiles = (await this.repo.raw(["ls-files"])).split("\n").filter(Boolean);
            console.log(`Found ${gitFiles.length} files via ls-files.`);

            const currentFilesSet = new Set(gitFiles);

            // Mark all currently tracked files for potential processing
            gitFiles.forEach(file => filesToProcess.add(file));

            // Identify files that were in the previous state but are *not* currently tracked (i.e., deleted)
            // Also, in a full scan, mark all *existing* files from the previous state for point deletion,
            // as they will be re-processed.
            const previouslyKnownFiles = Object.keys(previousState.files);
            previouslyKnownFiles.forEach(knownFile => {
                if (!currentFilesSet.has(knownFile)) {
                    // File was deleted since last state save
                    filesToDeletePointsFor.add(knownFile);
                } else {
                    // File still exists, but in a full scan, its old points need deletion before re-processing
                    filesToDeletePointsFor.add(knownFile);
                }
            });
        }

        console.log(`Identified ${filesToProcess.size} candidates for processing, ${filesToDeletePointsFor.size} files for potential point deletion.`);
        return { filesToProcess, filesToDeletePointsFor };
    }
}