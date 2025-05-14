import dotenv from "dotenv";
import { createAzure } from '@ai-sdk/azure';
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingPipeline } from "./embeddingPipeline.js";
import { RepositoryManager } from "./repositoryManager.js";
import { FileProcessor } from "./fileProcessor.js";
import { Chunker } from "./chunker.js";
import { EmbeddingService } from "./embeddingService.js";
import { QdrantManager } from "./qdrantManager.js";
import { BlobStateManager } from "./blobStateManager.js";
import { FileStateManager } from "./fileStateManager.js"; // + Import FileStateManager
import { EMPTY_STATE } from "./stateManager.js"; // Import EMPTY_STATE
import { DEFAULT_CHUNKING_OPTIONS } from "./fileTypeChunkingOptions.js";
import { AnalysisService } from "./analysisService.js";
import { VocabularyBuilder } from "./vocabularyBuilder.js"; // Import VocabularyBuilder
import { initializeCodeTokenizer } from './codeTokenizer.js'; // + Add this import
dotenv.config();
/**
 * Main application entry point.
 * Sets up configuration, initializes services, creates the pipeline, and runs it.
 */
async function main() {
    try {
        // --- Command Parsing ---
        dotenv.config();
        console.log("Initializing code tokenizer...");
        await initializeCodeTokenizer(); // Call this once globally
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
            requiredEnvVars.push("AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER_NAME");
        }
        else if (stateManagerType === "file") {
            requiredEnvVars.push("STATE_FILE_PATH");
        }
        else {
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
        const collectionName = process.env.QDRANT_COLLECTION_NAME;
        const vectorDimensions = parseInt(process.env.EMBEDDING_DIMENSIONS);
        const deleteBatchSize = parseInt(process.env.DELETE_BATCH_SIZE ?? "200");
        const upsertBatchSize = parseInt(process.env.UPSERT_BATCH_SIZE ?? "100");
        const defaultChunkSize = parseInt(process.env.DEFAULT_CHUNK_SIZE ?? "512");
        const defaultChunkOverlap = parseInt(process.env.DEFAULT_CHUNK_OVERLAP ?? "50");
        const distanceMetric = (process.env.DISTANCE_METRIC ?? "Cosine");
        const maxConcurrentChunking = parseInt(process.env.MAX_CONCURRENT_CHUNKING ?? "5");
        const embeddingBatchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE ?? "96");
        const embeddingApiDelayMs = parseInt(process.env.EMBEDDING_API_DELAY_MS ?? "1000");
        const summaryApiDelayMs = parseInt(process.env.SUMMARY_API_DELAY_MS ?? "1000");
        const qdrantPort = parseInt(process.env.QDRANT_PORT ?? "6333");
        const diffFromCommit = process.env.DIFF_FROM_COMMIT; // Read the new optional variable
        const customChunkingOptions = DEFAULT_CHUNKING_OPTIONS;
        // Vocabulary building parameters (now part of the main run)
        const vocabMinDf = parseInt(process.env.VOCAB_MIN_DF ?? "5");
        const vocabMaxDf = parseFloat(process.env.VOCAB_MAX_DF ?? "0.95");
        const vocabTargetSize = parseInt(process.env.VOCAB_TARGET_SIZE ?? "20000");
        // Basic validation for commit hash format (optional, logs warning)
        if (diffFromCommit && !/^[a-f0-9]{7,40}$/i.test(diffFromCommit)) {
            console.warn(`WARNING: DIFF_FROM_COMMIT value "${diffFromCommit}" does not look like a valid commit hash. Proceeding, but git operations might fail.`);
        }
        // Validate numeric optional config
        if (isNaN(vectorDimensions) || vectorDimensions <= 0)
            throw new Error("EMBEDDING_DIMENSIONS must be a positive integer.");
        if (isNaN(deleteBatchSize) || deleteBatchSize <= 0)
            throw new Error("DELETE_BATCH_SIZE must be a positive integer.");
        if (isNaN(upsertBatchSize) || upsertBatchSize <= 0)
            throw new Error("UPSERT_BATCH_SIZE must be a positive integer.");
        if (isNaN(defaultChunkSize) || defaultChunkSize <= 0)
            throw new Error("DEFAULT_CHUNK_SIZE must be a positive integer.");
        if (isNaN(defaultChunkOverlap) || defaultChunkOverlap < 0)
            throw new Error("DEFAULT_CHUNK_OVERLAP must be a non-negative integer.");
        if (isNaN(maxConcurrentChunking) || maxConcurrentChunking <= 0)
            throw new Error("MAX_CONCURRENT_CHUNKING must be a positive integer.");
        if (isNaN(embeddingBatchSize) || embeddingBatchSize <= 0)
            throw new Error("EMBEDDING_BATCH_SIZE must be a positive integer.");
        if (isNaN(embeddingApiDelayMs) || embeddingApiDelayMs < 0)
            throw new Error("EMBEDDING_API_DELAY_MS must be a non-negative integer.");
        if (isNaN(summaryApiDelayMs) || summaryApiDelayMs < 0)
            throw new Error("SUMMARY_API_DELAY_MS must be a non-negative integer.");
        if (!["Cosine", "Euclid", "Dot"].includes(distanceMetric))
            throw new Error("DISTANCE_METRIC must be one of 'Cosine', 'Euclid', 'Dot'.");
        if (isNaN(qdrantPort) || qdrantPort <= 0)
            throw new Error("QDRANT_PORT must be a positive integer.");
        // Validate vocabulary building parameters
        if (isNaN(vocabMinDf) || vocabMinDf < 1)
            throw new Error("VOCAB_MIN_DF must be a positive integer.");
        if (isNaN(vocabMaxDf) || vocabMaxDf <= 0 || vocabMaxDf > 1)
            throw new Error("VOCAB_MAX_DF must be a number between 0 and 1.");
        if (isNaN(vocabTargetSize) || vocabTargetSize < 1)
            throw new Error("VOCAB_TARGET_SIZE must be a positive integer.");
        // Load State Manager Config based on type
        let stateManager;
        if (stateManagerType === "blob") {
            stateManager = new BlobStateManager(process.env.AZURE_STORAGE_CONNECTION_STRING, process.env.AZURE_STORAGE_CONTAINER_NAME);
        }
        else { // stateManagerType === "file"
            stateManager = new FileStateManager(process.env.STATE_FILE_PATH);
        }
        // Initialise common services
        console.log("Initialising common services...");
        const repositoryManager = new RepositoryManager(baseDir);
        const fileProcessor = new FileProcessor(baseDir);
        console.log("Running embedding pipeline...");
        console.log("Configuration loaded successfully.");
        // --- Service Initialization ---
        console.log("Initializing services...");
        const embeddingProvider = createOpenAICompatible({
            name: process.env.EMBEDDING_PROVIDER_NAME,
            baseURL: process.env.EMBEDDING_PROVIDER_BASE_URL,
            apiKey: process.env.EMBEDDING_PROVIDER_API_KEY,
        });
        const embeddingModel = embeddingProvider.textEmbeddingModel(process.env.EMBEDDING_MODEL);
        // Initialize AnalysisService (needed by Chunker)
        const summaryProvider = createAzure({
            resourceName: process.env.SUMMARY_RESOURCE_NAME,
            apiKey: process.env.SUMMARY_API_KEY,
            apiVersion: process.env.SUMMARY_API_VERSION
        });
        const summaryModel = summaryProvider(process.env.SUMMARY_DEPLOYMENT);
        const analysisService = new AnalysisService(summaryModel);
        // --- Vocabulary Building (Integrated) ---
        console.log("Starting integrated vocabulary building...");
        // Get files to process for vocabulary (always full scan)
        const vocabFileChanges = await repositoryManager.listFiles(undefined, EMPTY_STATE);
        const vocabFilesToProcess = vocabFileChanges.filesToProcess;
        // Filter and load file content for vocabulary building
        const vocabProcessableFilesMap = await fileProcessor.filterAndLoadFiles(vocabFilesToProcess);
        // Initialize a temporary Chunker instance for vocabulary building (skip analysis)
        const vocabChunker = new Chunker(analysisService, // Still needs analysisService instance, but analysis is skipped
        0, // No delay needed for vocab chunking
        customChunkingOptions, defaultChunkSize, defaultChunkOverlap, undefined, // vocabulary is not needed for chunking during vocab build
        true // Skip analysis for vocabulary building
        );
        // Chunk files for vocabulary building
        const vocabFileChunksMap = await vocabChunker.chunkFiles(vocabProcessableFilesMap, maxConcurrentChunking);
        // Flatten chunks for vocabulary building
        const vocabChunks = Array.from(vocabFileChunksMap.values()).flat();
        console.log(`Generated ${vocabChunks.length} chunks for vocabulary building from ${vocabFileChunksMap.size} files.`);
        // Initialize VocabularyBuilder and build/save the vocabulary
        const vocabularyBuilder = new VocabularyBuilder(stateManager);
        await vocabularyBuilder.buildVocabulary(vocabChunks, vocabMinDf, vocabMaxDf, vocabTargetSize);
        console.log("Integrated vocabulary building finished.");
        // --- End Vocabulary Building ---
        // Initialize Chunker for the main pipeline (analysis is needed here)
        const chunker = new Chunker(analysisService, summaryApiDelayMs, customChunkingOptions, defaultChunkSize, defaultChunkOverlap
        // vocabulary is loaded and passed to chunker by the pipeline itself
        );
        const qdrantClient = new QdrantClient({
            host: process.env.QDRANT_HOST,
            port: qdrantPort,
            apiKey: process.env.QDRANT_API_KEY,
            https: process.env.QDRANT_USE_HTTPS === "true",
        });
        // --- Initialize State Manager Specifics ---
        if (stateManager instanceof BlobStateManager) {
            console.log("Using BlobStateManager. Ensuring container exists...");
            await stateManager.ensureContainerExists();
        } // FileStateManager ensures directory existence during load/save
        const embeddingService = new EmbeddingService(embeddingModel, embeddingBatchSize, embeddingApiDelayMs);
        const qdrantManager = new QdrantManager(qdrantClient, collectionName, vectorDimensions, distanceMetric, deleteBatchSize, upsertBatchSize);
        console.log("Services initialized.");
        // --- Pipeline Setup ---
        const pipelineOptions = {
            baseDir,
            diffOnly,
            diffFromCommit, // Pass the new option
            maxConcurrentChunking,
            repositoryManager, // Initialized before command block
            fileProcessor, // Initialized before command block
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
    }
    catch (error) {
        console.error("FATAL ERROR:", error); // Generic error message for both commands
        process.exit(1);
    }
}
await main();
