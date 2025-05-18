import { LanguageModel, generateText } from "ai";
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { retry } from "./retry.js";
import { RateLimiter } from "./rateLimiter.js";

const CACHE_DIR = '.analysis_cache';

/**
 * Service responsible for analysing code files using a Language Model (LLM).
 * It sends content to the LLM with specific instructions.
 */
export class AnalysisService {
    private rateLimiter: RateLimiter;

    constructor(private llm: LanguageModel) {
        this.rateLimiter = new RateLimiter();
    }

    /**
     * Analyses the content of a code file using the configured LLM to generate a summary.
     * @param content The source code content of the file.
     * @param filePath The relative path of the file being analysed.
     * @returns A promise that resolves to a string summary of the file,
     *          or an object indicating an analysis error.
     */
    async analyseCode(content: string, filePath: string, currentIndex?: number, totalFiles?: number): Promise<string | { source: string, analysisError: boolean }> {
        const progressInfo = currentIndex !== undefined && totalFiles !== undefined ? ` (File ${currentIndex} of ${totalFiles})` : '';

        // --- Caching Logic Start ---
        const currentContentHash = crypto.createHash('sha256').update(content).digest('hex');
        const cacheDir = path.resolve(CACHE_DIR);
        const filePathHash = crypto.createHash('sha256').update(filePath).digest('hex');
        const cacheFilePath = path.join(cacheDir, `${filePathHash}.txt`); // Change extension to .txt for plain text

        try {
            const cachedContent = await fs.readFile(cacheFilePath, 'utf-8');
            const cachedData = JSON.parse(cachedContent);

            if (cachedData && typeof cachedData === 'object' && cachedData.sourceContentHash === currentContentHash && typeof cachedData.summary === 'string') {
                console.log(`Cache hit (Content Hash Match) for: ${filePath}${progressInfo}. Reading from cache...`);
                return cachedData.summary;
            } else if (cachedData && cachedData.sourceContentHash !== currentContentHash) {
                console.log(`Cache stale (Content Hash Mismatch) for: ${filePath}${progressInfo}. Re-analysing...`);
            } else {
                 console.warn(`Invalid cache data structure for ${filePath}${progressInfo}. Re-analysing...`);
            }
        } catch (cacheError: any) {
            if (cacheError.code !== 'ENOENT') { // ENOENT = file not found (expected cache miss)
                console.warn(`Cache read error for ${filePath}${progressInfo} (${cacheFilePath}): ${cacheError.message}. Proceeding with LLM analysis.`);
            }
            // If file doesn't exist, hashes mismatch, parse error, or other read error, proceed to LLM analysis
        }
        // --- Caching Logic End ---

        console.log(`Requesting LLM analysis for: ${filePath}${progressInfo}`);
        const fileExtension = filePath.split('.').pop()?.toLowerCase();

        try {
            const result = await retry<string>(async () => { // Expecting a string result
                await this.rateLimiter.waitForPermit();
                const prompt = `
 Provide a concise summary of the following source code file.
 File Path: ${filePath}

 **Instructions:**

 1.  **Summary:** Provide a concise summary explaining the file's primary purpose, its main components (classes, functions, etc.), and its role within a larger project if discernible.
 2.  **Output Format:** Respond *only* with the plain text summary. Do not include any JSON formatting or extra information.

 **Source Code:**
 \`\`\`${fileExtension }
 ${content}
 \`\`\`
 `;

                const response = await generateText({ // Use generateText for plain text output
                    model: this.llm,
                    prompt: prompt,
                });

                const summary = response.text;


                // --- Cache Write Logic Start ---
                try {
                    await fs.mkdir(cacheDir, { recursive: true }); // Ensure cache directory exists
                    const cacheData = {
                        sourceContentHash: currentContentHash,
                        source: filePath,
                        summary
                    };
                    await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2));
                    console.log(`Successfully cached analysis for: ${filePath}`);
                } catch (writeError: any) {
                    console.warn(`Cache write error for ${filePath} (${cacheFilePath}): ${writeError.message}`);
                    // Don't fail the overall analysis if caching fails
                }
                // --- Cache Write Logic End ---

                return summary;
            }, {
                maxRetries: 5,
                initialDelay: 1500,
                onRetry: (error, attempt) => {
                    console.warn(`LLM analysis retry ${attempt} for ${filePath}${progressInfo}: ${error.message}`);

                    const response = (error as any)?.response;
                    const status = response?.status;
                    const headers = response?.headers;
                    const message = error.message || '';
                    let retryAfterSeconds: number | null = null;
                    let detectedVia: string | null = null; // Track detection method

                    if (status === 429) {
                        const retryAfterHeader = headers?.['retry-after'];
                        if (retryAfterHeader && typeof retryAfterHeader === 'string') {
                            const parsedSeconds = parseInt(retryAfterHeader, 10);
                            if (!isNaN(parsedSeconds)) {
                                retryAfterSeconds = parsedSeconds;
                                detectedVia = 'HTTP Header';
                            }
                        }
                        // If status is 429 but header is missing/invalid, we still know it's a rate limit
                        if (!detectedVia) {
                        }
                    }

                    if (!detectedVia && (/rate limit/i.test(message) || /exceeded token rate limit/i.test(message))) {
                         const retryAfterMatch = message.match(/retry after (\d+)/i);
                         if (retryAfterMatch) {
                             const parsedSeconds = parseInt(retryAfterMatch[1], 10);
                             if (!isNaN(parsedSeconds)) {
                                 retryAfterSeconds = parsedSeconds;
                             }
                         }
                    }

                    if (detectedVia) {
                        if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
                            console.log(`Rate limit detected for ${filePath} via ${detectedVia}. Waiting ${retryAfterSeconds} seconds.`);
                            this.rateLimiter.notifyRateLimit(retryAfterSeconds);
                        } else {
                            const defaultCooldown = 60;
                            console.warn(`Rate limit detected for ${filePath} via ${detectedVia}, but couldn't determine Retry-After duration. Applying default cooldown: ${defaultCooldown} seconds.`);
                            this.rateLimiter.notifyRateLimit(defaultCooldown);
                        }
                    }
                }
            });

            console.log(`LLM analysis successful for: ${filePath}${progressInfo}`);
            return result;
        } catch (error) {
            console.error(`LLM analysis failed for ${filePath}${progressInfo}: ${error}`);
            return { source: filePath, analysisError: true };
        }
    }
}