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
import { StateManager } from "./stateManager.js";
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

    // Required environment variables
    const requiredEnvVars = [
      "EMBEDDING_PROVIDER_NAME",
      "EMBEDDING_PROVIDER_BASE_URL",
      "EMBEDDING_MODEL",
      "EMBEDDING_DIMENSIONS",
      "SUMMARY_RESOURCE_NAME",
      "SUMMARY_DEPLOYMENT",
      "SUMMARY_API_KEY",
      "QDRANT_URL",
      "QDRANT_COLLECTION_NAME",
    ];
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
    const summaryApiDelayMs = parseInt(process.env.SUMMARY_API_DELAY_MS ?? "1000"); // <-- Load summary delay

    // Validate numeric optional config
    if (isNaN(vectorDimensions) || vectorDimensions <= 0) throw new Error("EMBEDDING_DIMENSIONS must be a positive integer.");
    if (isNaN(deleteBatchSize) || deleteBatchSize <= 0) throw new Error("DELETE_BATCH_SIZE must be a positive integer.");
    if (isNaN(upsertBatchSize) || upsertBatchSize <= 0) throw new Error("UPSERT_BATCH_SIZE must be a positive integer.");
    if (isNaN(defaultChunkSize) || defaultChunkSize <= 0) throw new Error("DEFAULT_CHUNK_SIZE must be a positive integer.");
    if (isNaN(defaultChunkOverlap) || defaultChunkOverlap < 0) throw new Error("DEFAULT_CHUNK_OVERLAP must be a non-negative integer.");
    if (isNaN(maxConcurrentChunking) || maxConcurrentChunking <= 0) throw new Error("MAX_CONCURRENT_CHUNKING must be a positive integer.");
    if (isNaN(embeddingBatchSize) || embeddingBatchSize <= 0) throw new Error("EMBEDDING_BATCH_SIZE must be a positive integer.");
    if (isNaN(embeddingApiDelayMs) || embeddingApiDelayMs < 0) throw new Error("EMBEDDING_API_DELAY_MS must be a non-negative integer.");
    if (isNaN(summaryApiDelayMs) || summaryApiDelayMs < 0) throw new Error("SUMMARY_API_DELAY_MS must be a non-negative integer."); // <-- Validate summary delay
    if (!["Cosine", "Euclid", "Dot"].includes(distanceMetric)) throw new Error("DISTANCE_METRIC must be one of 'Cosine', 'Euclid', 'Dot'.");

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
      apiKey: process.env.SUMMARY_API_KEY
    });
    const summaryModel = summaryProvider(process.env.SUMMARY_DEPLOYMENT!);

    const qdrantClient = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY,
      https: process.env.QDRANT_USE_HTTPS === "true",
    });

    // Instantiate components/managers
    const stateManager = new StateManager(baseDir);
    const repositoryManager = new RepositoryManager(baseDir);
    const fileProcessor = new FileProcessor(baseDir);
    const analysisService = new AnalysisService(summaryModel);
    // Pass the summaryApiDelayMs to the Chunker constructor
    const chunker = new Chunker(
        analysisService,
        summaryApiDelayMs, // <-- Pass delay here
        customChunkingOptions,
        defaultChunkSize,
        defaultChunkOverlap
    );
    const embeddingService = new EmbeddingService(embeddingModel, embeddingBatchSize, embeddingApiDelayMs);
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
        maxConcurrentChunking,
        repositoryManager,
        fileProcessor,
        analysisService, // analysisService is still needed by the pipeline if used elsewhere, or could be removed if only used by Chunker
        chunker,         // The configured chunker (with delay) is passed
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