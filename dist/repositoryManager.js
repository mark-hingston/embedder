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
    async listFiles(diffBaseCommit, previousState) {
        console.log(`Listing files in ${this.baseDir}...`);
        const filesToProcess = new Set();
        const filesToDeletePointsFor = new Set();
        let useDiff = !!diffBaseCommit;
        if (useDiff) {
            const baseCommit = diffBaseCommit;
            console.log(`Attempting to process diff between ${baseCommit} and HEAD...`);
            try {
                try {
                    await this.repo.raw(['cat-file', '-e', `${baseCommit}^{commit}`]);
                    console.log(`Commit ${baseCommit} found locally.`);
                }
                catch (checkError) {
                    console.warn(`Commit ${baseCommit} not found locally. Attempting to fetch full history (git fetch --depth=0)...`);
                    try {
                        await this.repo.fetch(['--depth=0']);
                        console.log("Fetch complete. Retrying commit check...");
                        await this.repo.raw(['cat-file', '-e', `${baseCommit}^{commit}`]);
                        console.log(`Commit ${baseCommit} found after fetch.`);
                    }
                    catch (fetchOrRecheckError) {
                        console.error(`Failed to fetch or find commit ${baseCommit} after fetch.`, fetchOrRecheckError);
                        throw new Error(`Provided DIFF_FROM_COMMIT hash "${baseCommit}" is invalid or could not be found in the repository history even after fetching.`);
                    }
                }
                console.log(`Performing diff: ${baseCommit}..HEAD`);
                const diffOutput = await this.repo.diff([
                    "--name-status",
                    baseCommit,
                    "HEAD",
                ]);
                const diffSummary = diffOutput.split('\n').filter(line => line.trim() !== '');
                console.log(`Found ${diffSummary.length} changes between ${baseCommit} and HEAD.`);
                for (const line of diffSummary) {
                    const parts = line.split('\t');
                    const status = parts[0].trim();
                    const path1 = parts[1].trim();
                    const path2 = parts.length > 2 ? parts[2].trim() : null;
                    if (status.startsWith('A')) {
                        filesToProcess.add(path1);
                    }
                    else if (status.startsWith('M') || status.startsWith('T')) {
                        filesToProcess.add(path1);
                        if (previousState.files[path1])
                            filesToDeletePointsFor.add(path1);
                    }
                    else if (status.startsWith('C')) {
                        const targetPath = path2 ?? path1;
                        filesToProcess.add(targetPath);
                    }
                    else if (status.startsWith('R')) {
                        const oldPath = path1;
                        const newPath = path2 ?? path1;
                        filesToProcess.add(newPath);
                        if (previousState.files[oldPath])
                            filesToDeletePointsFor.add(oldPath);
                    }
                    else if (status.startsWith('D')) {
                        if (previousState.files[path1])
                            filesToDeletePointsFor.add(path1);
                    }
                }
            }
            catch (diffError) {
                console.error(`Error performing diff between ${baseCommit} and HEAD:`, diffError);
                throw new Error(`Failed to perform git diff between verified commit "${baseCommit}" and HEAD.`);
            }
        }
        else {
            console.log("Processing all tracked files (full scan)...");
            const gitFiles = (await this.repo.raw(["ls-files"])).split("\n").filter(Boolean);
            console.log(`Found ${gitFiles.length} files via ls-files.`);
            const currentFilesSet = new Set(gitFiles);
            gitFiles.forEach(file => filesToProcess.add(file));
            const previouslyKnownFiles = Object.keys(previousState.files);
            previouslyKnownFiles.forEach(knownFile => {
                if (!currentFilesSet.has(knownFile)) {
                    filesToDeletePointsFor.add(knownFile);
                }
                else {
                    filesToDeletePointsFor.add(knownFile);
                }
            });
        }
        console.log(`Identified ${filesToProcess.size} candidates for processing, ${filesToDeletePointsFor.size} files for potential point deletion.`);
        return { filesToProcess, filesToDeletePointsFor };
    }
}
