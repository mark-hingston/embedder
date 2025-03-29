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

```mermaid
graph TD
    %% Define Styles
    classDef init fill:#D5E8D4,stroke:#82B366,stroke-width:2px,color:#000;       %% Light Green BG
    classDef orchestrator fill:#DAE8FC,stroke:#6C8EBF,stroke-width:2px,color:#000; %% Light Blue BG
    classDef component fill:#FFF2CC,stroke:#D6B656,stroke-width:2px,color:#000;    %% Light Yellow BG
    classDef external fill:#F5F5F5,stroke:#666666,stroke-width:2px,color:#000;     %% Light Grey BG
    classDef data fill:#FFE6CC,stroke:#D79B00,stroke-width:1px,color:#000;         %% Light Orange BG

    subgraph "Init & Config"
      direction LR
      env([.env Configuration]):::external
      main(main.ts Entry Point):::init
    end

    subgraph "Pipeline Orchestrator"
       pipeline(EmbeddingPipeline):::orchestrator
    end

    subgraph "Core Components (src/)"
        direction TB
        repoMgr(RepositoryManager):::component
        stateMgr(StateManager):::component
        fileProc(FileProcessor):::component
        chunker(Chunker):::component
        analysisSvc(AnalysisService):::component
        embedSvc(EmbeddingService):::component
        qdrantMgr(QdrantManager):::component
    end

    subgraph "External Systems & Data"
        direction LR
        gitRepo[(Git Repository)]:::external
        fs[(File System)]:::external
        stateFile[/".file-points.json"/]:::data
        embedApi{{Embedding API}}:::external
        llmApi{{Analysis LLM API}}:::external
        qdrantDb[(Qdrant Vector DB)]:::external
        %% Removed mastraLib node
    end

    %% Initialization
    env -- "Loads Config" --> main
    main -- "Creates & Runs" --> pipeline

    %% Component Usage (Pipeline uses components)
    pipeline -- "Uses" --> repoMgr
    pipeline -- "Uses" --> stateMgr
    pipeline -- "Uses" --> fileProc
    pipeline -- "Uses" --> chunker
    pipeline -- "Uses" --> embedSvc
    pipeline -- "Uses" --> qdrantMgr
    chunker -- "Uses" --> analysisSvc
    %% Specific dependency for analysis within chunking

    %% External Interactions (Components interact with external systems)
    repoMgr -- "Interacts" --> gitRepo
    stateMgr -- "Reads/Writes" --> stateFile
    fileProc -- "Reads" --> fs
    analysisSvc -- "Calls" --> llmApi
    %% Removed chunker -> mastraLib connection
    embedSvc -- "Calls" --> embedApi
    qdrantMgr -- "Interacts" --> qdrantDb

    %% Pipeline Step Flow (Grouped by Component, referencing code comments)
    pipeline -- "Steps 1, 4, 11 (Repo Check, List Files, Get Commit)" --> repoMgr
    pipeline -- "Steps 3, 5, 12, 13 (Load/Save State, Get Points)" --> stateMgr
    pipeline -- "Step 7 (Filter/Load Files)" --> fileProc
    pipeline -- "Step 8 (Chunk Files w/ Analysis)" --> chunker
    pipeline -- "Step 9 (Embed Chunks)" --> embedSvc
    pipeline -- "Steps 2, 6, 10 (Collection Mgmt, Delete, Upsert)" --> qdrantMgr

    pipeline -- "Ends" --> main
```

The `EmbeddingPipeline` orchestrates the entire process by executing a sequence of steps, coordinating different components. The diagram above visually represents this flow. The steps correspond directly to the numbered comments within the `EmbeddingPipeline.run()` method:

1.  **Check Repository:** The `RepositoryManager` verifies that the target directory is a valid Git repository root. *(Initial check)*
2.  **Ensure Qdrant Collection:** The `QdrantManager` checks if the target collection exists in Qdrant. If not, it creates the collection along with necessary payload indices (`source`, `tags`, `analysisError`). It also validates vector dimensions and distance metric compatibility if the collection already exists.
3.  **Load State:** The `StateManager` reads the `.file-points.json` file (if it exists) to load the last processed Git commit hash and the mapping of previously processed files to their Qdrant point IDs.
4.  **List Files:** The `RepositoryManager` determines which files need processing. Based on the `DIFF_ONLY` setting and the loaded state, it either performs a `git diff` against the last commit or lists all tracked files (`git ls-files`). It outputs sets of `filesToProcess` and `filesToDeletePointsFor`.
5.  **Identify Points for Deletion:** The `StateManager` uses the loaded state and the `filesToDeletePointsFor` set to compile a list of specific Qdrant point IDs that correspond to outdated file versions or deleted files.
6.  **Delete Outdated Points:** The `QdrantManager` sends a request to Qdrant to delete the points identified in the previous step. This cleanup happens before adding new data.
7.  **Filter & Load Files:** The `FileProcessor` takes the `filesToProcess` set, filters out non-text files (binaries, lock files), reads the content of valid text files, and determines the appropriate chunking strategy (`code`, `html`, etc.) for each.
8.  **Analyze & Chunk Files:** The `Chunker` processes the valid files concurrently. For each file, it uses the `AnalysisService` to get LLM-generated metadata and then chunks the content using the appropriate strategy (`@mastra/rag`), embedding the analysis results into the chunk metadata. Configured delays (`SUMMARY_API_DELAY_MS`) are applied between analysis calls.
9.  **Generate Embeddings:** The `EmbeddingService` takes all the text chunks, batches them, and calls the configured Embedding API (with delays `EMBEDDING_API_DELAY_MS` and retries) to generate vector embeddings for each chunk.
10. **Upsert New Points:** The `QdrantManager` prepares Qdrant point objects (ID, vector, payload) for the new chunks and upserts them into the Qdrant collection in batches, waiting for completion.
11. **Get Current Commit:** The `RepositoryManager` retrieves the current `HEAD` commit hash from the Git repository.
12. **Calculate Next State:** The `StateManager` computes the new state by removing entries for deleted/modified files, adding entries for newly processed files (mapping them to their new point IDs), and including the current commit hash obtained in Step 11.
13. **Save State:** The `StateManager` saves the calculated next state atomically to the `.file-points.json` file.

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