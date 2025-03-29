import { EmbeddingModel, embedMany } from "ai";
import { retry } from "./retry.js";
import { RetryOptions } from "./retryOptions.js";

/**
 * Service responsible for generating text embeddings using a specified AI model.
 * Handles batching, delays, and retries for API calls.
 */
export class EmbeddingService {
    /**
     * Creates an instance of EmbeddingService.
     * @param embeddingModel The AI SDK embedding model instance.
     * @param batchSize The number of texts to embed in a single API call.
     * @param apiDelayMs Delay in milliseconds between consecutive batch API calls.
     * @param retryOptions Configuration for retrying failed API calls.
     */
    constructor(
        private embeddingModel: EmbeddingModel<string>,
        private batchSize: number = 96,
        private apiDelayMs: number = 1000,
        private retryOptions: Partial<RetryOptions> = { maxRetries: 3, initialDelay: 1000 }
    ) {}

    /**
     * Generates embeddings for an array of text strings.
     * @param texts The array of texts to embed.
     * @returns A promise resolving to an array of embedding vectors (number[][]).
     */
    async embedTexts(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        console.log(`Embedding ${texts.length} texts in batches of ${this.batchSize} (Delay: ${this.apiDelayMs}ms)...`);
        const allEmbeddings: number[][] = [];

        for (let i = 0; i < texts.length; i += this.batchSize) {
            const batchTexts = texts.slice(i, i + this.batchSize);

            if (batchTexts.length === 0) continue; // Should not happen with correct loop logic, but safe check

            const batchNumber = Math.floor(i / this.batchSize) + 1;
            const totalBatches = Math.ceil(texts.length / this.batchSize);
            console.log(`Embedding batch ${batchNumber}/${totalBatches} (${batchTexts.length} texts)...`);

            try {
                // Retry the embedMany call for robustness
                const batchEmbeddings = await retry(async () => {
                    const { embeddings } = await embedMany({
                        model: this.embeddingModel,
                        values: batchTexts,
                    });

                    // Validate response consistency
                    if (embeddings.length !== batchTexts.length) {
                        throw new Error(`Embedding count mismatch in batch: expected ${batchTexts.length}, got ${embeddings.length}`);
                    }
                    return embeddings;
                }, {
                    ...this.retryOptions,
                    onRetry: (error, attempt) => {
                        console.warn(`Retry attempt ${attempt} for embedMany batch ${batchNumber}/${totalBatches} (size ${batchTexts.length}): ${error.message}`);
                    }
                });

                allEmbeddings.push(...batchEmbeddings);

                // Apply delay between batches if configured and not the last batch
                if (this.apiDelayMs > 0 && i + this.batchSize < texts.length) {
                    await new Promise(resolve => setTimeout(resolve, this.apiDelayMs));
                }
            } catch (error) {
                // If a batch fails even after retries, abort the entire process
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`FATAL ERROR during embedding batch ${batchNumber}/${totalBatches} (index ${i}): ${errorMessage}. Aborting embedding process.`);
                throw error; // Re-throw to stop the pipeline
            }
        }

        console.log(`Successfully generated ${allEmbeddings.length} embeddings.`);

        // Final validation: Ensure the total number of embeddings matches the input texts
        if (allEmbeddings.length !== texts.length) {
            const errMsg = `FATAL MISMATCH after embedding: Expected ${texts.length} embeddings, but received ${allEmbeddings.length}.`;
            console.error(errMsg);
            throw new Error(errMsg); // Should ideally not happen if batch validation works
        }

        return allEmbeddings;
    }
}