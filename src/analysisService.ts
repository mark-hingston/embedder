import { LanguageModel, generateObject } from "ai";
import { z } from "zod";
import { retry } from "./retry.js";
import { CodeFileAnalysisSchema, CodeFileAnalysis } from "./codeFileAnalysisSchema.js";

/**
 * Service responsible for analyzing code files using a Language Model (LLM).
 * It sends the code content to the LLM with specific instructions
 * and expects a structured JSON response conforming to the CodeFileAnalysisSchema.
 */
export class AnalysisService {
    constructor(private llm: LanguageModel) {}

    /**
     * Analyzes the content of a code file using the configured LLM.
     * @param content The source code content of the file.
     * @param filePath The relative path of the file being analyzed.
     * @returns A promise that resolves to the analysis results conforming to CodeFileAnalysisSchema,
     *          or an object indicating an analysis error.
     */
    async analyseCode(content: string, filePath: string, currentIndex?: number, totalFiles?: number): Promise<CodeFileAnalysis | { source: string, analysisError: boolean }> {
        const progressInfo = currentIndex !== undefined && totalFiles !== undefined ? ` (File ${currentIndex} of ${totalFiles})` : '';
        console.log(`Requesting LLM analysis for: ${filePath}${progressInfo}`);

        const fileExtension = filePath.split('.').pop()?.toLowerCase();

        try {
            const result = await retry(async () => {
                // Prompt designed to guide the LLM in extracting structured information from code.
                const prompt = `
Analyse the following source code file.
File Path: ${filePath}

**Instructions:**

1.  **Overall Summary:** Provide a concise summary explaining the file's primary purpose, its main components (classes, functions, etc.), and its role within a larger project if discernible.
2.  **Tags:** Identify relevant keywords, concepts, design patterns, or frameworks used (e.g., 'React Component', 'API Client', 'Data Model', 'Configuration', 'Utility Functions', 'Middleware').
4.  **Structure Extraction:** Extract the following structural elements accurately:
    *   **Imports:** List the names of imported modules, namespaces, or files.
    *   **Exports:** (For JS/TS) List the names of explicitly exported variables, functions, or classes.
    *   **Top-Level Functions/Variables:** List any significant functions or variables defined outside of classes/interfaces. Include their names and optionally signatures/types.
    *   **Classes:** For each class:
        *   Extract its name, signature (declaration line), direct superclass (if any), and implemented interfaces.
        *   Provide a brief summary of the class's purpose.
        *   List its public methods and properties (names and optionally signatures). Note if methods are async or if the class is abstract.
    *   **Interfaces:** (For C#/TS) For each interface:
        *   Extract its name, signature, and any interfaces it extends.
        *   Provide a brief summary of the interface's contract.
        *   List its method and property signatures.
5.  **Focus:** Concentrate on elements defined *within this file*. Do not deeply analyse imported code.
6.  **Output Format:** Respond *only* with a valid JSON object matching the provided schema.

**Source Code:**
\`\`\`${fileExtension }
${content}
\`\`\`
`;

                const { object } = await generateObject({
                    model: this.llm,
                    schema: CodeFileAnalysisSchema, // Use the detailed schema for structured output
                    prompt: prompt,
                    // Optional: Add mode: 'json' if generateObject doesn't default or has issues
                });

                // Validate the LLM output against the schema and ensure the source path is correctly set.
                // The LLM might hallucinate the path, so we overwrite it with the known value.
                const validatedObject = CodeFileAnalysisSchema.parse({
                    ...object,
                    source: filePath, // Ensure filePath is set from our known context
                });

                return validatedObject; // Return the Zod-validated object
            }, {
                maxRetries: 3,
                initialDelay: 1500, // Slightly longer delay for potentially complex LLM analysis
                onRetry: (error, attempt) => console.warn(`LLM analysis retry ${attempt} for ${filePath}: ${error.message}`)
            });

            console.log(`LLM analysis successful for: ${filePath}`);
            return result;

        } catch (error) {
            // Catch both API/retry errors and Zod validation errors
            if (error instanceof z.ZodError) {
                 console.error(`LLM output validation failed for ${filePath}:`, error.errors);
            } else {
                console.error(`LLM analysis failed for ${filePath}: ${error}`);
            }
            // Return a specific error object if analysis fails
            return { source: filePath, analysisError: true };
        }
    }
}