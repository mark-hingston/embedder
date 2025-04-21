import dotenv from "dotenv";
import { createAzure } from '@ai-sdk/azure';
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingPipeline } from "./embeddingPipeline.js";
import { RepositoryManager } from "./repositoryManager.js";
import { FileProcessor } from "./fileProcessor.js";
import { Chunker } from "./chunker.js";
import { EmbeddingService } from "./embeddingService.js";
import { QdrantManager, QdrantDistance } from "./qdrantManager.js";
import { BlobStateManager } from "./blobStateManager.js";
import { FileStateManager } from "./fileStateManager.js"; // + Import FileStateManager
import { StateManager, FilePointsState } from "./stateManager.js";
import { FileTypeChunkingOptions } from "./fileTypeChunkingOptions.js";
import { EmbeddingPipelineOptions } from "./embeddingPipelineOptions.js";
import { AnalysisService } from "./analysisService.js";

dotenv.config();

/**
 * Main application entry point.
 * Sets up configuration, initializes services, creates the pipeline, and runs it.
 */
async function main() {
  try {
    // --- Configuration Loading & Validation ---
    console.log("Loading configuration from environment variables...");

    const stateManagerType = process.env.STATE_MANAGER_TYPE ?? "blob"; // Default to blob
    // Required environment variables (base set)
    const requiredEnvVars = [
      "EMBEDDING_PROVIDER_NAME",
      "EMBEDDING_PROVIDER_BASE_URL",
      "EMBEDDING_MODEL",
      "EMBEDDING_DIMENSIONS",
      "SUMMARY_RESOURCE_NAME",
      "SUMMARY_DEPLOYMENT",
      "SUMMARY_API_VERSION",
      "SUMMARY_API_KEY",
      "QDRANT_HOST",
      "QDRANT_PORT",
      "QDRANT_COLLECTION_NAME",
    ];

    // Add state-manager specific required variables
    if (stateManagerType === "blob") {
       requiredEnvVars.push(
           "AZURE_STORAGE_CONNECTION_STRING",
           "AZURE_STORAGE_CONTAINER_NAME",
           "AZURE_STORAGE_BLOB_NAME"
       );
    } else if (stateManagerType === "file") {
       requiredEnvVars.push("STATE_FILE_PATH");
    } else {
       throw new Error(`Invalid STATE_MANAGER_TYPE: ${stateManagerType}. Must be 'blob' or 'file'.`);
    }

    for (const varName of requiredEnvVars) {
      if (!process.env[varName]) {
        throw new Error(`Missing required environment variable: ${varName}`);
      }
    }

    // Optional environment variables with defaults
    const baseDir = process.env.BASE_DIR ?? process.cwd();
    const diffOnly = process.env.DIFF_ONLY === "true";
    const collectionName = process.env.QDRANT_COLLECTION_NAME!;
    const vectorDimensions = parseInt(process.env.EMBEDDING_DIMENSIONS!);
    const deleteBatchSize = parseInt(process.env.DELETE_BATCH_SIZE ?? "200");
    const upsertBatchSize = parseInt(process.env.UPSERT_BATCH_SIZE ?? "100");
    const defaultChunkSize = parseInt(process.env.DEFAULT_CHUNK_SIZE ?? "512");
    const defaultChunkOverlap = parseInt(process.env.DEFAULT_CHUNK_OVERLAP ?? "50");
    const distanceMetric = (process.env.DISTANCE_METRIC ?? "Cosine") as QdrantDistance;
    const maxConcurrentChunking = parseInt(process.env.MAX_CONCURRENT_CHUNKING ?? "5");
    const embeddingBatchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE ?? "96");
    const embeddingApiDelayMs = parseInt(process.env.EMBEDDING_API_DELAY_MS ?? "1000");
    const summaryApiDelayMs = parseInt(process.env.SUMMARY_API_DELAY_MS ?? "1000");
    const qdrantPort = parseInt(process.env.QDRANT_PORT ?? "6333");
    const diffFromCommit = process.env.DIFF_FROM_COMMIT; // Read the new optional variable

    // Basic validation for commit hash format (optional, logs warning)
    if (diffFromCommit && !/^[a-f0-9]{7,40}$/i.test(diffFromCommit)) {
        console.warn(`WARNING: DIFF_FROM_COMMIT value "${diffFromCommit}" does not look like a valid commit hash. Proceeding, but git operations might fail.`);
    }

    // Load State Manager Config based on type
    let stateManager: StateManager;
    if (stateManagerType === "blob") {
       stateManager = new BlobStateManager(
           process.env.AZURE_STORAGE_CONNECTION_STRING!,
           process.env.AZURE_STORAGE_CONTAINER_NAME!,
           process.env.AZURE_STORAGE_BLOB_NAME!
       );
    } else { // stateManagerType === "file"
       stateManager = new FileStateManager(process.env.STATE_FILE_PATH!);
    }

    // Validate numeric optional config
    if (isNaN(vectorDimensions) || vectorDimensions <= 0) throw new Error("EMBEDDING_DIMENSIONS must be a positive integer.");
    if (isNaN(deleteBatchSize) || deleteBatchSize <= 0) throw new Error("DELETE_BATCH_SIZE must be a positive integer.");
    if (isNaN(upsertBatchSize) || upsertBatchSize <= 0) throw new Error("UPSERT_BATCH_SIZE must be a positive integer.");
    if (isNaN(defaultChunkSize) || defaultChunkSize <= 0) throw new Error("DEFAULT_CHUNK_SIZE must be a positive integer.");
    if (isNaN(defaultChunkOverlap) || defaultChunkOverlap < 0) throw new Error("DEFAULT_CHUNK_OVERLAP must be a non-negative integer.");
    if (isNaN(maxConcurrentChunking) || maxConcurrentChunking <= 0) throw new Error("MAX_CONCURRENT_CHUNKING must be a positive integer.");
    if (isNaN(embeddingBatchSize) || embeddingBatchSize <= 0) throw new Error("EMBEDDING_BATCH_SIZE must be a positive integer.");
    if (isNaN(embeddingApiDelayMs) || embeddingApiDelayMs < 0) throw new Error("EMBEDDING_API_DELAY_MS must be a non-negative integer.");
    if (isNaN(summaryApiDelayMs) || summaryApiDelayMs < 0) throw new Error("SUMMARY_API_DELAY_MS must be a non-negative integer.");
    if (!["Cosine", "Euclid", "Dot"].includes(distanceMetric)) throw new Error("DISTANCE_METRIC must be one of 'Cosine', 'Euclid', 'Dot'.");
    if (isNaN(qdrantPort) || qdrantPort <= 0) throw new Error("QDRANT_PORT must be a positive integer.");

    const customChunkingOptions: Partial<FileTypeChunkingOptions> = {};
    console.log("Configuration loaded successfully.");

    // --- Service Initialization ---
    console.log("Initializing services...");

    const embeddingProvider = createOpenAICompatible({
      name: process.env.EMBEDDING_PROVIDER_NAME!,
      baseURL: process.env.EMBEDDING_PROVIDER_BASE_URL!,
      apiKey: process.env.EMBEDDING_PROVIDER_API_KEY,
    });
    const embeddingModel = embeddingProvider.textEmbeddingModel(process.env.EMBEDDING_MODEL!);

    const summaryProvider = createAzure({
      resourceName: process.env.SUMMARY_RESOURCE_NAME,
      apiKey: process.env.SUMMARY_API_KEY,
      apiVersion: process.env.SUMMARY_API_VERSION
    });
    const summaryModel = summaryProvider(process.env.SUMMARY_DEPLOYMENT!);

    const qdrantClient = new QdrantClient({
      host: process.env.QDRANT_HOST!,
      port: qdrantPort,
      apiKey: process.env.QDRANT_API_KEY,
      https: process.env.QDRANT_USE_HTTPS === "true",
    });

    // --- Initialize State Manager Specifics ---
    if (stateManager instanceof BlobStateManager) {
       console.log("Using BlobStateManager. Ensuring container exists...");
       await stateManager.ensureContainerExists();
    } // FileStateManager ensures directory existence during load/save
    const fileProcessor = new FileProcessor(baseDir);
    const analysisService = new AnalysisService(summaryModel);
    
    const chunker = new Chunker(
        analysisService,
        summaryApiDelayMs,
        customChunkingOptions,
        defaultChunkSize,
        defaultChunkOverlap
    );
    const embeddingService = new EmbeddingService(embeddingModel, embeddingBatchSize, embeddingApiDelayMs);
    const repositoryManager = new RepositoryManager(baseDir); // Moved after state manager init
    const qdrantManager = new QdrantManager(
        qdrantClient,
        collectionName,
        vectorDimensions,
        distanceMetric,
        deleteBatchSize,
        upsertBatchSize
    );
    console.log("Services initialized.");

    // --- Pipeline Setup ---
    const pipelineOptions: EmbeddingPipelineOptions = {
        baseDir,
        diffOnly,
        diffFromCommit, // Pass the new option
        maxConcurrentChunking,
        repositoryManager,
        fileProcessor,
        analysisService,
        chunker,
        embeddingService,
        qdrantManager,
        stateManager,
    };

    const pipeline = new EmbeddingPipeline(pipelineOptions);
    console.log("Embedding pipeline created.");

    // --- Run Pipeline ---
    await pipeline.run();

    console.log("Application finished successfully.");

  } catch (error) {
    console.error("FATAL ERROR during embedding process:", error);
    process.exit(1);
  }
}

await main();