import { stat, readFile } from "fs/promises";
// Dynamically import istextorbinary as it's likely an ESM module
const { isText } = await import("istextorbinary");

// --- File Type Checks ---

/** Checks if a filename likely represents source code based on extension. */
export const isCode = (fileName: string): boolean =>
    /\.(?:mjs|cjs|js|jsx|ts|tsx|c|cpp|h|hpp|cs|java|py|rb|go|rs|swift|kt|php|sh|ps1|bat|lua|sql|pl|pm|r|dart|fs|fsx|fsi|scala|groovy|gradle|kts|yaml|yml|jsonc|tf|tfvars|hcl|dockerfile|Makefile|cmake|vue|svelte|astro|css|scss|sass|less)$/i.test(fileName);
    // Added: mjs, cjs, jsonc, hcl, dockerfile, Makefile, cmake, vue, svelte, astro
    // Added: pl, pm, r, dart, fs, fsx, fsi, scala, groovy, gradle, kts
    // Added: css, scss, sass, less (often relevant in code context)

/** Checks if a filename is a common lock file. */
export const isLockFile = (fileName: string): boolean =>
    /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.terraform\.lock\.hcl|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|mix\.lock|.*\.lock)$/i.test(fileName);

/** Checks if a filename has an HTML extension. */
export const isHtml = (fileName:string): boolean => /\.html?$/i.test(fileName);

/** Checks if a filename has a JSON extension (excluding jsonc). */
export const isJson = (fileName: string): boolean => /(?<!c)\.json$/i.test(fileName); // Use negative lookbehind to exclude .jsonc

/** Checks if a filename has a Markdown extension. */
export const isMarkdown = (fileName: string): boolean => /\.mdx?$/i.test(fileName);


// --- Filesystem Utilities ---

/**
 * Checks if a file or directory exists at the given path.
 * @param filePath The path to check.
 * @returns True if the path exists, false otherwise. Logs warnings for errors other than ENOENT.
 */
export const fsExists = async (filePath: string): Promise<boolean> => {
    try {
      await stat(filePath); // Check existence and access
      return true;
    } catch (error: unknown) {
      // Specifically handle "Not Found" error
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      // Log other potential errors (permissions, etc.) but treat as non-existent for processing purposes
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: Error checking existence of ${filePath}: ${errorMessage}`);
      return false;
    }
  };

/**
 * Checks if a file is likely a text file (not binary).
 * Reads a portion of the file to perform the check.
 * @param filePath The path to the file.
 * @returns True if the file is determined to be text, false otherwise (including read errors).
 */
export const isTextFile = async (filePath: string): Promise<boolean> => {
    try {
        // Reading the buffer first can be more reliable for isText
        const fileBuffer = await readFile(filePath);
        // isText can accept buffer or path; buffer avoids a second read if path is used.
        // Explicit cast to boolean as the library's types might be slightly off.
        return isText(filePath, fileBuffer) as boolean;
    } catch (error) {
        // Treat files that cannot be read as non-text for safety
        console.warn(`Warning: Could not read file ${filePath} to check if text: ${error instanceof Error ? error.message : error}`);
        return false;
    }
};