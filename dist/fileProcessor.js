import { join } from "path";
import { readFile } from "node:fs/promises";
import { fsExists, isCode, isHtml, isJson, isLockFile, isMarkdown, isTextFile, isImageFile } from "./utilities.js";
import * as crypto from 'crypto'; // Import crypto module for hashing
/**
 * Filters a list of candidate file paths, loads the content of valid text files,
 * and determines the appropriate chunking strategy for each.
 */
export class FileProcessor {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    /**
     * Filters a set of relative file paths, loads content for valid text files,
     * and determines their chunking strategy.
     * @param files A set of relative file paths identified by the RepositoryManager.
     * @returns A promise resolving to a Map where keys are relative paths and
     *          values are ProcessableFile objects for files that passed filtering.
     */
    async filterAndLoadFiles(files) {
        console.log(`Filtering and loading content for ${files.size} candidate files...`);
        const processableFiles = new Map();
        let skippedBinary = 0;
        let skippedLockState = 0;
        let skippedMissing = 0;
        let skippedReadError = 0;
        let skippedImage = 0;
        for (const relativePath of files) {
            const filePath = join(this.baseDir, relativePath);
            try {
                // 1. Check if file exists
                if (!(await fsExists(filePath))) {
                    skippedMissing++;
                    continue;
                }
                // 2. Skip lock files, state files, and Yarn PnP files early
                if (isLockFile(relativePath) || /\.yarn/.test(relativePath)) {
                    skippedLockState++;
                    continue;
                }
                // 3. Skip common image files by extension
                if (isImageFile(relativePath)) {
                    skippedImage++;
                    continue;
                }
                // 4. Check if it's likely a text file (skip remaining binaries)
                // This check is still useful for non-image binaries missed by extension
                if (!(await isTextFile(filePath))) {
                    skippedBinary++;
                    continue;
                }
                // 5. Read content (assuming UTF-8)
                const content = await readFile(filePath, { encoding: "utf8" });
                // 6. Determine chunking strategy based on file extension/type
                const strategy = this.determineStrategy(filePath);
                // 7. Add to map of processable files
                processableFiles.set(relativePath, {
                    filePath,
                    relativePath,
                    content,
                    strategy
                });
            }
            catch (readError) {
                // Catch errors during fs operations or reading
                console.error(`Error processing file ${relativePath}: ${readError instanceof Error ? readError.message : readError}. Skipping.`);
                skippedReadError++;
            }
        }
        console.log(`Filtering complete: ${processableFiles.size} files loaded. Skipped: ${skippedMissing} (missing), ${skippedLockState} (lock/state), ${skippedImage} (image), ${skippedBinary} (other binary), ${skippedReadError} (read error).`);
        return processableFiles;
    }
    /**
     * Determines the appropriate chunking strategy based on the file path/extension.
     * @param filePath The absolute or relative path to the file.
     * @returns The determined ChunkStrategy.
     */
    determineStrategy(filePath) {
        // It's generally better to check based on the relative path if possible,
        // as it's less likely to contain irrelevant directory names.
        // However, using filePath is fine if baseDir structure is consistent.
        if (isCode(filePath))
            return "code";
        if (isHtml(filePath))
            return "html";
        if (isJson(filePath))
            return "json";
        if (isMarkdown(filePath))
            return "markdown";
        // Add other specific text types here if needed (e.g., XML, CSV)
        return "text"; // Default strategy for unrecognized text files
    }
    /**
     * Generates a deterministic SHA-256 hash for a given string input.
     * Useful for creating stable IDs based on file paths or content.
     * @param input The string to hash.
     * @returns The SHA-256 hash as a hexadecimal string.
     */
    generateHash(input) {
        return crypto.createHash('sha256').update(input).digest('hex');
    }
}
