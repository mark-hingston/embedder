import { Chunker } from "./chunker.js";
import { AnalysisService } from "./analysisService.js";
import { EmbeddingService } from "./embeddingService.js";
import { FileProcessor } from "./fileProcessor.js";
import { QdrantManager } from "./qdrantManager.js";
import { RepositoryManager } from "./repositoryManager.js";
import { StateManager } from "./stateManager.js";

/**
 * Defines the configuration and dependency injection options
 * required by the EmbeddingPipeline.
 */
export interface EmbeddingPipelineOptions {
    /** The root directory of the Git repository being processed. */
    baseDir: string;
    /** If true, only process files changed since the last run (based on state file). */
    diffOnly: boolean;
    /** Optional commit hash to diff against, overriding diffOnly and state file's last commit. */
    diffFromCommit?: string;
    /** Maximum number of files to chunk concurrently. */
    maxConcurrentChunking: number;

    // --- Injected Dependencies ---
    /** Manages interaction with the Git repository. */
    repositoryManager: RepositoryManager;
    /** Handles filtering and reading file content. */
    fileProcessor: FileProcessor;
    /** Performs LLM code analysis. */
    analysisService: AnalysisService;
    /** Chunks file content based on type and analysis. */
    chunker: Chunker;
    /** Generates text embeddings using an external model. */
    embeddingService: EmbeddingService;
    /** Manages interaction with the Qdrant vector database. */
    qdrantManager: QdrantManager;
    /** Manages loading and saving the processing state. */
    stateManager: StateManager;
}