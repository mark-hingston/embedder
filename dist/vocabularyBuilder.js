import { processTextToFinalTokens } from "./tokenProcessor.js";
import { tokenizeCode, initializeCodeTokenizer } from "./codeTokenizer.js";
export class VocabularyBuilder {
    stateManager;
    termStats = new Map();
    documentCount = 0;
    constructor(stateManager) {
        this.stateManager = stateManager;
        // Stop words and stemming are now handled within the shared processTextToFinalTokens function
        // The stemmer instance is also managed internally by the shared function.
    }
    async buildVocabulary(chunks, minDf, maxDf, targetSize) {
        console.log("Starting vocabulary building...");
        await initializeCodeTokenizer();
        this.documentCount = chunks.length;
        this.termStats.clear();
        for (const chunk of chunks) {
            if (chunk.text) {
                try {
                    const rawTokensFromCodeTokenizer = tokenizeCode(chunk.text, chunk.metadata.fileExtension || "");
                    // Use the shared token processing function
                    const processedTokensFinal = processTextToFinalTokens(chunk.text);
                    const uniqueTokensInDocument = new Set(processedTokensFinal);
                    for (const token of processedTokensFinal) {
                        if (!this.termStats.has(token)) {
                            this.termStats.set(token, {
                                termFrequency: 0,
                                documentFrequency: 0,
                            });
                        }
                        this.termStats.get(token).termFrequency++;
                    }
                    for (const uniqueToken of uniqueTokensInDocument) {
                        // Ensure the token exists in termStats before incrementing documentFrequency
                        // It should always exist if it was in processedTokensFinal, but this is a safe check.
                        if (this.termStats.has(uniqueToken)) {
                            this.termStats.get(uniqueToken).documentFrequency++;
                        }
                    }
                }
                catch (error) {
                    console.error(`Error tokenizing or processing chunk from ${chunk.metadata.source}:`, error);
                }
            }
        }
        console.log(`Collected stats for ${this.termStats.size} unique (filtered, stemmed, split) terms across ${this.documentCount} documents.`);
        const vocabulary = {};
        if (this.documentCount === 0) {
            console.warn("No documents processed, vocabulary will be empty.");
            await this.stateManager.saveVocabulary(vocabulary);
            return vocabulary;
        }
        const sortedTerms = Array.from(this.termStats.entries())
            .filter(([term, stats]) => {
            const docFreqFraction = this.documentCount > 0 // Avoid division by zero
                ? stats.documentFrequency / this.documentCount
                : 0;
            // Term must appear in at least minDf documents
            // Term must appear in no more than maxDf fraction of documents
            return stats.documentFrequency >= minDf && docFreqFraction <= maxDf;
        })
            .sort(([termA, statsA], [termB, statsB]) => {
            // Primary sort: higher term frequency first
            if (statsB.termFrequency !== statsA.termFrequency) {
                return statsB.termFrequency - statsA.termFrequency;
            }
            // Secondary sort: shorter terms first (can be useful for more "atomic" terms)
            if (termA.length !== termB.length) {
                return termA.length - termB.length;
            }
            // Tertiary sort: alphabetical for tie-breaking
            return termA.localeCompare(termB);
        });
        for (let i = 0; i < Math.min(sortedTerms.length, targetSize); i++) {
            vocabulary[sortedTerms[i][0]] = i;
        }
        console.log(`Built vocabulary with ${Object.keys(vocabulary).length} terms (target: ${targetSize}, minDf: ${minDf}, maxDf: ${maxDf}).`);
        await this.stateManager.saveVocabulary(vocabulary);
        console.log("Vocabulary saved.");
        return vocabulary;
    }
}
