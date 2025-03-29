import { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import { retry } from "./retry.js";
import { RetryOptions } from "./retryOptions.js";

// Type aliases for Qdrant schema types
export type QdrantPoint = Schemas["PointStruct"];
export type QdrantDistance = Schemas["Distance"];

/**
 * Manages interactions with a Qdrant vector database collection.
 * Handles collection creation (including payload indexing), point upsertion,
 * and point deletion with batching and retries.
 */
export class QdrantManager {
    /**
     * Creates an instance of QdrantManager.
     * @param qdrantClient An initialized Qdrant client instance.
     * @param collectionName The name of the Qdrant collection to manage.
     * @param vectorDimensions The dimensionality of the vectors to be stored.
     * @param distanceMetric The distance metric for vector comparison (default: Cosine).
     * @param deleteBatchSize Batch size for deleting points.
     * @param upsertBatchSize Batch size for upserting points.
     * @param retryOptions Configuration for retrying failed Qdrant operations.
     */
    constructor(
        private qdrantClient: QdrantClient,
        private collectionName: string,
        private vectorDimensions: number,
        private distanceMetric: QdrantDistance = "Cosine",
        private deleteBatchSize: number = 200,
        private upsertBatchSize: number = 100,
        private retryOptions: Partial<RetryOptions> = { maxRetries: 3, initialDelay: 500 }
    ) {}

    /**
     * Ensures the target Qdrant collection exists with the correct configuration
     * and necessary payload indices. Creates the collection and indices if they don't exist.
     * Throws an error if the collection exists but has incompatible vector dimensions.
     * Warns if the distance metric differs but proceeds.
     */
    async ensureCollectionExists(): Promise<void> {
        try {
            // Attempt to get existing collection info
            const collectionInfo = await this.qdrantClient.getCollection(this.collectionName);
            console.log(`Collection '${this.collectionName}' already exists.`);

            // Validate vector dimensions
            const existingSize = collectionInfo.config.params.vectors?.size;
            if (existingSize !== this.vectorDimensions) {
                throw new Error(
                    `FATAL: Existing collection '${this.collectionName}' has dimension ${existingSize}, but expected ${this.vectorDimensions}. Aborting.`
                );
            }

            // Warn about distance metric mismatch
            const existingDistance = collectionInfo.config.params.vectors?.distance;
             if (existingDistance !== this.distanceMetric) {
                console.warn(
                    `Warning: Existing collection '${this.collectionName}' uses distance metric ${existingDistance}, but configured metric is ${this.distanceMetric}. Proceeding with existing metric.`
                );
            }

            // Note: Checking for existing payload indices via the client library is complex.
            // We assume if the collection exists, indices *might* exist. The creation logic handles adding them if the collection is new.
            // If indices need to be added to an *existing* collection, manual intervention or a separate script might be needed.

        } catch (error: unknown) {
            // Check if the error indicates the collection was not found
            const isNotFoundError =
                (error && typeof error === 'object' && 'status' in error && error.status === 404) ||
                (error instanceof Error && /not found|doesn't exist/i.test(error.message));

            if (isNotFoundError) {
                // Collection not found, proceed with creation
                console.log(`Collection '${this.collectionName}' not found. Attempting creation...`);
                await this.createCollectionWithIndices();
            } else {
                // Unexpected error during collection check
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.error(`Error checking collection '${this.collectionName}':`, errorMessage);
                throw error; // Re-throw unexpected errors
            }
        }
    }

    /**
     * Creates the collection and the necessary payload indices.
     * Uses retry logic for robustness.
     */
    private async createCollectionWithIndices(): Promise<void> {
         console.log(`Creating collection '${this.collectionName}' (Dimensions: ${this.vectorDimensions}, Distance: ${this.distanceMetric})...`);
         await retry(async () => {
            // 1. Create the collection with vector parameters
            await this.qdrantClient.createCollection(this.collectionName, {
                vectors: { size: this.vectorDimensions, distance: this.distanceMetric },
                // Add other collection-level config here if needed (sharding, replication, etc.)
            });
            console.log(`Collection '${this.collectionName}' created.`);

            // 2. Create payload indices for filterable fields *after* collection creation
            console.log(`Creating payload indices for 'source', 'tags', and 'analysisError'...`);

            // Index 'source' (file path) as keyword for exact matching
            await this.qdrantClient.createPayloadIndex(this.collectionName, {
                field_name: "source",
                field_schema: "keyword",
                wait: true,
            });

            // Index 'tags' (array of strings) as keyword for filtering by tag
            await this.qdrantClient.createPayloadIndex(this.collectionName, {
                field_name: "tags",
                field_schema: "keyword",
                wait: true,
            });

             // Index 'analysisError' (boolean) for filtering chunks from files that failed analysis
             await this.qdrantClient.createPayloadIndex(this.collectionName, {
                field_name: "analysisError",
                field_schema: "bool",
                wait: true,
            });

            console.log(`Payload indices created successfully for collection '${this.collectionName}'.`);
         },
            {
                ...this.retryOptions,
                onRetry: (err, attempt) => console.warn(`Retry attempt ${attempt} creating collection/indices for '${this.collectionName}': ${err.message}`)
            }
        );
    }

    /**
     * Deletes points from the Qdrant collection in batches.
     * @param pointIds An array of point IDs to delete.
     */
    async deletePoints(pointIds: string[]): Promise<void> {
        if (pointIds.length === 0) {
            return; // Nothing to delete
        }

        console.log(`Attempting to delete ${pointIds.length} points from '${this.collectionName}' in batches of ${this.deleteBatchSize}...`);

        try {
            for (let i = 0; i < pointIds.length; i += this.deleteBatchSize) {
                const batchIds = pointIds.slice(i, i + this.deleteBatchSize);
                const batchNumber = Math.floor(i / this.deleteBatchSize) + 1;
                const totalBatches = Math.ceil(pointIds.length / this.deleteBatchSize);

                if (batchIds.length > 0) {
                    console.log(`Deleting batch ${batchNumber}/${totalBatches} (${batchIds.length} points)...`);
                    await retry(async () => {
                        const result = await this.qdrantClient.delete(this.collectionName, {
                            points: batchIds,
                            wait: true, // Wait for consistency
                        });
                        if (result.status !== 'completed') {
                            throw new Error(`Qdrant deletion batch status: ${result.status}. Points might remain.`);
                        }
                        return result;
                    }, {
                        ...this.retryOptions,
                        onRetry: (error, attempt) => {
                            console.warn(`Retry attempt ${attempt} for Qdrant delete batch ${batchNumber}/${totalBatches} (size ${batchIds.length}): ${error.message}`);
                        }
                    });
                }
            }
            console.log(`Successfully requested deletion of ${pointIds.length} points from Qdrant.`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`ERROR during Qdrant point deletion:`, errorMessage);
            console.error(`WARNING: Qdrant state may be inconsistent. Some points scheduled for deletion might still exist.`);
            throw error; // Re-throw to signal failure
        }
    }

    /**
     * Upserts (updates or inserts) points into the Qdrant collection in batches.
     * @param points An array of QdrantPoint objects to upsert.
     */
    async upsertPoints(points: QdrantPoint[]): Promise<void> {
        if (points.length === 0) {
            return; // Nothing to upsert
        }

        console.log(`Upserting ${points.length} points to '${this.collectionName}' in batches of ${this.upsertBatchSize}...`);

        try {
            for (let i = 0; i < points.length; i += this.upsertBatchSize) {
                const batch = points.slice(i, i + this.upsertBatchSize);
                const batchNumber = Math.floor(i / this.upsertBatchSize) + 1;
                const totalBatches = Math.ceil(points.length / this.upsertBatchSize);

                if (batch.length > 0) {
                    console.log(`Upserting batch ${batchNumber}/${totalBatches} (${batch.length} points)...`);
                    await retry(async () => {
                        const result = await this.qdrantClient.upsert(this.collectionName, {
                            points: batch,
                            wait: true, // Wait for consistency before updating state file
                        });
                        if (result.status !== 'completed') {
                            throw new Error(`Qdrant upsert batch status: ${result.status}. Some points might be missing.`);
                        }
                        return result;
                    }, {
                        ...this.retryOptions,
                        onRetry: (error, attempt) => {
                            console.warn(`Retry attempt ${attempt} for Qdrant upsert batch ${batchNumber}/${totalBatches} (size ${batch.length}): ${error.message}`);
                        }
                    });
                }
            }
            console.log("Successfully completed upserting all points.");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`ERROR during Qdrant batch upsert: ${errorMessage}`);
            console.error(`WARNING: Qdrant state may be inconsistent. Some points might be missing or incomplete.`);
            throw error; // Re-throw to signal failure
        }
    }
}