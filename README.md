# Embedder

This project provides a configurable pipeline to process files within a Git repository, analyse code using a Language Model (LLM), chunk the content intelligently, generate text embeddings, and store them in a Qdrant vector database. It keeps track of processed files and Git commits to efficiently update the embeddings when the repository changes.

## Features

*   **Git Integration:** Operates on files tracked within a Git repository.
*   **Differential Updates:** Optionally processes only files that have changed (`A`dded, `M`odified, `D`eleted, `R`enamed, `C`opied) since the last run by comparing against the last known commit hash (requires `DIFF_ONLY=true`). Falls back to a full scan if needed.
*   **State Management:** Persists the mapping between files and their corresponding Qdrant point IDs, along with the last processed commit hash, in a `.file-points.json` file in the repository root.
*   **LLM-Powered Code Analysis:** Uses a configurable LLM (e.g., Azure OpenAI) via the AI SDK to analyse code files, extracting:
    *   Overall summary
    *   Relevant tags (keywords, concepts, frameworks)
    *   Structural elements (imports, exports, classes, functions, interfaces)
    *   This analysis is added as metadata to the generated chunks.
*   **Intelligent Chunking:** Employs file-type specific chunking strategies using the `@mastra/rag` library:
    *   Recognizes Code, HTML, JSON, Markdown, and generic Text files.
    *   Uses appropriate strategies (e.g., recursive for code, HTML-aware for HTML).
    *   Chunking parameters (size, overlap) are configurable via environment variables (defaults provided).
    *   Includes LLM analysis results in the metadata of each chunk.
*   **Embedding Generation:** Uses a configurable embedding model via the AI SDK (`@ai-sdk/openai-compatible` or others) to generate vector embeddings for each text chunk. Supports batching, configurable delays, and retries.
*   **Vector Storage (Qdrant):**
    *   Connects to a Qdrant instance.
    *   Ensures the specified collection exists with the correct vector dimensions and distance metric.
    *   **On collection creation, automatically creates payload indices** for key metadata fields (`source`, `tags`, `analysisError`) to enable efficient filtering during queries.
    *   Upserts new embeddings and metadata in batches.
    *   Deletes points associated with changed or deleted files before upserting new ones.
    *   Includes retry logic for Qdrant operations.
*   **Concurrency Control:** Uses `p-limit` to manage concurrency during the file chunking phase.
*   **Configuration:** Primarily configured via environment variables (`.env` file).
*   **Robust Error Handling:** Includes retries for network operations (LLM analysis, embedding, Qdrant) and detailed logging.

## Architecture / Workflow

The pipeline follows these general steps:

1.  **Initialization:** Load config, initialize services (Git, Qdrant, AI Models, etc.).
2.  **State Loading:** Load `.file-points.json` to get the last processed commit and file->point mappings.
3.  **File Discovery (RepositoryManager):**
    *   Check if `DIFF_ONLY` is enabled and `lastProcessedCommit` exists.
    *   If yes: Run `git diff --name-status <lastCommit> HEAD` to find changed files.
    *   If no (or diff fails): Run `git ls-files` to get all tracked files.
    *   Determine `filesToProcess` (new/modified/renamed-new) and `filesToDeletePointsFor` (modified/deleted/renamed-old).
4.  **Point Deletion (QdrantManager):** Delete points from Qdrant corresponding to `filesToDeletePointsFor`.
5.  **File Filtering & Loading (FileProcessor):** Filter `filesToProcess` (remove binaries, lock files), load content, determine chunking strategy (code, html, etc.).
6.  **Analysis & Chunking (AnalysisService, Chunker):**
    *   For each processable file:
        *   Send content to the analysis LLM (`AnalysisService`).
        *   Chunk the content using the determined strategy (`Chunker`).
        *   Combine analysis results and chunker metadata.
    *   Uses `p-limit` for concurrent chunking.
7.  **Embedding Generation (EmbeddingService):** Generate embeddings for all collected chunks in batches, with retries.
8.  **Point Preparation:** Create Qdrant point objects (ID, vector, payload including text and metadata) for each chunk. Track the mapping of `file -> [new_point_ids]`.
9.  **Point Upsertion (QdrantManager):** Upsert the new points into Qdrant in batches, with retries.
10. **State Update (StateManager):**
    *   Get the current `HEAD` commit hash.
    *   Calculate the next state by removing deleted file entries and adding/updating entries with `new_point_ids`.
    *   Save the updated state (including the new `lastProcessedCommit`) back to `.file-points.json`.

## Setup

1.  **Prerequisites:**
    *   Node.js (v18 or later recommended)
    *   Git
    *   Access to a running Qdrant instance.
    *   Access to an OpenAI-compatible Embedding API endpoint (e.g., OpenAI API, LM Studio, Ollama with OpenAI compatibility).
    *   Access to an Azure OpenAI endpoint for the Code Analysis LLM.

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Create `.env` file:**
    Copy `.env.example` to `.env` and fill in the required values:

    ```dotenv
    # --- Target Repository ---
    # Base directory of the Git repository to process (optional, defaults to current dir)
    # BASE_DIR=/path/to/your/project

    # --- Processing Mode ---
    # Set to true to only process files changed since the last run (based on .file-points.json)
    # Set to false or omit to process all tracked files on every run.
    DIFF_ONLY=true

    # --- Embedding Model Configuration (OpenAI-Compatible) ---
    EMBEDDING_PROVIDER_NAME=openai # Or 'lmstudio', 'ollama', etc.
    EMBEDDING_PROVIDER_BASE_URL=https://api.openai.com/v1 # Or http://localhost:1234/v1 etc.
    EMBEDDING_PROVIDER_API_KEY=sk-your_openai_key # Optional, needed for cloud providers
    EMBEDDING_MODEL=text-embedding-3-small # Model name compatible with the provider
    EMBEDDING_DIMENSIONS=1536 # MUST match the output dimension of the embedding model
    EMBEDDING_BATCH_SIZE=96 # Number of texts to embed per API call (optional, default 96)
    EMBEDDING_API_DELAY_MS=50 # Delay between embedding API batches (ms) (optional, default 1000ms)

    # --- Code Analysis LLM Configuration (Azure OpenAI) ---
    SUMMARY_RESOURCE_NAME=your_azure_resource_name # Azure OpenAI resource name
    SUMMARY_DEPLOYMENT=your_gpt4_deployment_id # Deployment ID (e.g., gpt-4o)
    SUMMARY_API_KEY=your_azure_api_key # Azure OpenAI API Key
    SUMMARY_API_DELAY_MS=1000 # Delay after each analysis call (ms) - useful for rate limiting (optional, default 1000ms)

    # --- Qdrant Configuration ---
    QDRANT_URL=http://localhost:6333 # URL of your Qdrant instance
    QDRANT_API_KEY= # Optional Qdrant API Key if authentication is enabled
    QDRANT_COLLECTION_NAME=my_code_embeddings # Name for the Qdrant collection
    # QDRANT_USE_HTTPS=false # Set to true if Qdrant uses HTTPS (optional, default false)
    DISTANCE_METRIC=Cosine # Or Euclid, Dot (optional, default Cosine) - Must match collection if it exists
    UPSERT_BATCH_SIZE=100 # Points per Qdrant upsert batch (optional, default 100)
    DELETE_BATCH_SIZE=200 # Points per Qdrant delete batch (optional, default 200)

    # --- Chunking & Concurrency Configuration ---
    DEFAULT_CHUNK_SIZE=512 # Fallback chunk size for recursive strategy (optional, default 512)
    DEFAULT_CHUNK_OVERLAP=50 # Fallback chunk overlap for recursive strategy (optional, default 50)
    MAX_CONCURRENT_CHUNKING=5 # Max files to chunk simultaneously (optional, default 5)

    # Add custom chunking options here if needed (see TODO in main.ts)
    # e.g., CHUNK_OPTIONS_TEXT_SIZE=1000
    ```

## Usage

1.  **Build the project (optional but recommended):**
    ```bash
    npm run build
    ```

2.  **Run the pipeline:**

    *   Using the compiled JavaScript (after `npm run build`):
        ```bash
        node dist/main.js
        ```
    *   Or run directly using `tsx`:
        ```bash
        npx tsx src/main.ts
        ```

3.  **Output:**
    *   The script logs progress messages to the console.
    *   Upon successful completion, the Qdrant collection (`QDRANT_COLLECTION_NAME`) will contain embeddings for the processed files.
    *   A `.file-points.json` file will be created or updated in the `BASE_DIR` containing the state information.

## Code Structure (`src/`)

*   **`main.ts`**: Entry point, configuration loading, service initialization, pipeline execution.
*   **`embeddingPipeline.ts`**: Orchestrates the overall workflow, coordinating different managers and services.
*   **`embeddingPipelineOptions.ts`**: Defines the configuration and dependencies needed by the pipeline.
*   **`repositoryManager.ts`**: Handles Git interactions (checking repo, getting commit, listing changed/all files).
*   **`stateManager.ts`**: Manages loading and saving the `.file-points.json` state file.
*   **`fileProcessor.ts`**: Filters candidate files, reads content, determines chunking strategy.
*   **`analysisService.ts`**: Interacts with the LLM to perform code analysis.
*   **`codeFileAnalysisSchema.ts`**: Defines the Zod schema for the expected LLM analysis output.
*   **`chunker.ts`**: Chunks file content using `@mastra/rag`, incorporating analysis results.
*   **`chunkOptions.ts` / `fileTypeChunkingOptions.ts` / `chunkStrategy.ts`**: Define types and defaults for chunking configuration.
*   **`embeddingService.ts`**: Generates text embeddings using the configured AI model (batching, retries).
*   **`qdrantManager.ts`**: Handles all interactions with the Qdrant vector database (collection management, upserts, deletes, retries).
*   **`retry.ts` / `retryOptions.ts`**: Provides a generic async retry mechanism with exponential backoff.
*   **`utilities.ts`**: Helper functions for file system checks and type detection.
*   **`chunk.ts`**: Defines the structure of a text chunk with metadata.