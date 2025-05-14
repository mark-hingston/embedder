// File: src/vocabularyBuilder.ts
import natural from 'natural';
const PorterStemmer = natural.PorterStemmer; // Instance
import { tokenizeCode, initializeCodeTokenizer } from "./codeTokenizer.js";
// Define a default set of stop words
const DEFAULT_STOP_WORDS = new Set([
    // Common English stop words
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "its", "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with", "about", "after", "all", "also", "am", "any", "because", "been", "before", "being", "can", "could", "did", "do", "does", "doing", "from", "further", "had", "has", "have", "he", "her", "here", "him", "his", "how", "however", "i", "just", "let", "me", "my", "myself", "nor", "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should", "so", "some", "than", "thats", "them", "themselves", "those", "though", "through", "thus", "too", "us", "very", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "would", "you", "your", "yours", "yourself", "yourselves", "yet",
    "test", "month", // Added as per review
    // Common programming keywords
    "abstract", "arguments", "async", "await", "boolean", "break", "case", "catch", "class", "const", "constructor", "continue", "debugger", "default", "delete", "else", "enum", "export", "extends", "false", "finally", "for", "function", "get", "implements", "import", "instanceof", "interface", "internal", "module", "new", "null", "object", "override", "package", "private", "protected", "public", "readonly", "record", "return", "sealed", "set", "static", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "true", "try", "type", "typeof", "undefined", "var", "virtual", "void", "volatile", "while", "yield", "using", "namespace", "task", "int", "bool",
    // Logging & Console
    "console", "log", "warn", "error", "debug", "info",
    // Operators & Symbols (many might be filtered by TreeSitter node types or length) - keep minimal
    // "==", "===", "!=", "!==", ">", "<", ">=", "<=", "&&", "||", "!", "++", "--", "+", "-", "*", "/", "%", "+=", "-=", "*=", "/=", "%=", "?", "??", "?.", ":", "=>", "=",
    // Punctuation - mostly handled by cleaning, but some explicit ones if they form tokens
    // ".", ",", ";", "(", ")", "{", "}", "[", "]", "///", "//", "/*", "*/",
    // XML-like tags (if they become tokens despite TreeSitter)
    "summary", "param", "inheritdoc", "remarks", "returns", "exception", "typeparam", "see", "cref",
    // Common build/config/file terms (if not desired)
    "commit", "file", "path", "line", "index", "src", "dist", "ref", "refs", "head", "github", "workspace", "version", "name", "value", "target", "property", "itemgroup", "project", "sdk", "framework", "dependency", "echo", "bash", "run", "uses", "env", "steps", "script", "args", "output", "input", "displayname", "workingdirectory", "parameters", "variables", "http", "https", "api", "status", "message", "header", "content", "body", "docker", "image", "container", "deployment", "service", "ingress", "configmap", "secret", "volume", "mountpath", "replicas", "metadata", "labels", "spec", "kind", "apiversion",
    // Specific terms identified as noise from previous vocabularies
    "string", "context", "form", "number", "action", "text", "button", "label", "option", "json", "model", "config", "logger", "list", "item", "brand", "url", "view", "post", "host", "base", // Added view, post, host, base
    // Generic/Common Programming Terms and Project Acronyms (add more if they are noisy)
    "obj", "cpu", "commo", "utilitie", "client", "server", "user", "system", "data", "code", "key",
    "trin", "pguk", "eac", "pgsa",
    // JSON Keys (if they become separate tokens and are noisy)
    "term_plural", "fuzzy",
    // Test-Specific Terms and Common Low-Signal Words (many should be filtered by length or are actual stop words)
    "tobeinthedocument", "tohavebeencalled", "tobevisible", "tobehidden", "userevent", "expect", "div", "span", "id",
    "includeassets", "buildtransitive", "runtime", "screen", "page", "locator", "purchasepage", "valid_card_details", "styledth", "styledtd",
]);
// Helper function to split camelCase and snake_case words
function splitCompoundIdentifier(token) {
    if (token.includes('-') || token.includes('_')) { // Handle snake_case and kebab-case
        return token.split(/[-_]/).filter(t => t.length > 0);
    }
    // Split camelCase: Credit to https://stackoverflow.com/a/76279304/1089576
    const words = token.match(/([A-Z_]?([a-z0-9]+)|[A-Z_]+)/g);
    return words ? words.map(w => w.replace(/^_/, '')) : [token];
}
export class VocabularyBuilder {
    stateManager;
    termStats = new Map();
    documentCount = 0;
    stopWords;
    stemmer;
    constructor(stateManager, stopWords) {
        this.stateManager = stateManager;
        this.stopWords = stopWords || DEFAULT_STOP_WORDS;
        this.stemmer = PorterStemmer;
        // --- DEBUG STOP WORDS (Uncomment to verify stop word set) ---
        console.log('--- VOCABULARY BUILDER CONSTRUCTOR ---');
        console.log('Using stop words set with size:', this.stopWords.size);
        const crucialStopWords = ["string", "context", "form", "number", "json", "action", "text", "button", "label", "option", "view", "post", "list", "host", "base", "key", "value", "type", "api", "url", "data", "code", "system", "test", "month"];
        let missingCount = 0;
        for (const sw of crucialStopWords) {
            if (this.stopWords.has(sw)) {
                // console.log(`DEBUG: constructor: "${sw}" IS in this.stopWords`);
            }
            else {
                console.error(`DEBUG: constructor: "${sw}" IS NOT in this.stopWords - THIS IS A PROBLEM`);
                missingCount++;
            }
        }
        if (missingCount > 0) {
            console.error(`CRITICAL: ${missingCount} crucial stop words are missing from the active set!`);
        }
        console.log('------------------------------------');
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
                    const tokensToProcessInitially = [];
                    for (const token of rawTokensFromCodeTokenizer) {
                        const subTokens = token
                            .replace(/[\r\n]+/g, " ; ") // Normalize newlines to a consistent separator
                            .split(/\s*;\s*/) // Split by the separator, allowing for surrounding whitespace
                            .map((t) => t.trim())
                            .filter((t) => t.length > 0);
                        tokensToProcessInitially.push(...subTokens);
                    }
                    const processedTokensFinal = [];
                    for (const originalToken of tokensToProcessInitially) {
                        let tokensForCompoundSplitting;
                        // Only apply compound splitting to tokens that look like identifiers and are reasonably long
                        if (/^[a-zA-Z0-9]+([-_][a-zA-Z0-9]+)*$|^[a-z]+([A-Z][a-zA-Z0-9]*)+[a-zA-Z0-9]*$/.test(originalToken) && originalToken.length > 4) {
                            tokensForCompoundSplitting = splitCompoundIdentifier(originalToken);
                        }
                        else {
                            tokensForCompoundSplitting = [originalToken];
                        }
                        for (let tokenPartFromCompound of tokensForCompoundSplitting) {
                            const dotParts = tokenPartFromCompound.split('.'); // Split by dot
                            for (const dotPart of dotParts) {
                                if (dotPart.length === 0)
                                    continue;
                                let cleanedSubToken = dotPart.toLowerCase();
                                // Decode unicode escape sequences like \\uXXXX
                                try {
                                    cleanedSubToken = cleanedSubToken.replace(/\\\\u([0-9a-fA-F]{4})/g, (match, grp) => String.fromCharCode(parseInt(grp, 16)));
                                }
                                catch (e) { /* ignore encoding errors */ }
                                // Normalize newlines within the token (again, just in case) and trim
                                cleanedSubToken = cleanedSubToken.replace(/[\r\n]+/g, " ").trim();
                                // General cleaning of leading/trailing non-alphanumeric (but keep @#$_ internally for things like CSS vars or specific identifiers)
                                cleanedSubToken = cleanedSubToken.replace(/^[^a-z0-9@#$_]+|[^a-z0-9@#$_]+$/g, "");
                                // Remove any leading underscores that might remain or be part of the original token
                                cleanedSubToken = cleanedSubToken.replace(/^_+/, "");
                                // --- SPECIALIZED FILTERS (Applied after basic cleaning, before general stop word/length checks) ---
                                // Filter for attribute-like tokens, e.g. name="value", name=\"value\"
                                // or fragments like name="value (if trailing quote was stripped by previous cleaning)
                                if (cleanedSubToken.includes('="') || cleanedSubToken.includes('=\\"')) {
                                    // console.log(`DEBUG: VocabBuilder: Filtering attribute-like token: ${cleanedSubToken}`);
                                    continue;
                                }
                                // Filter for <tag> style tokens (simple complete ones like <summary> or <br/>)
                                if (/^<[a-zA-Z0-9_:\-\.\/]+>$/.test(cleanedSubToken)) {
                                    // console.log(`DEBUG: VocabBuilder: Filtering simple complete tag: ${cleanedSubToken}`);
                                    continue;
                                }
                                // Filter for tokens containing markup characters (<, >) mixed with other content or partial tags
                                // Examples: "includeassets>runtim", "buildtransitive</includeasset", "foo<bar"
                                if (/[<>]/.test(cleanedSubToken)) {
                                    const knownOperatorsWithMarkup = /^(?:=>|<=|>=|->)$/; // Add others if necessary
                                    if (this.stopWords.has(cleanedSubToken) || knownOperatorsWithMarkup.test(cleanedSubToken)) {
                                        // It's a stop word (like "=>") or a known operator.
                                        // Let it pass this specific filter; it will be handled by the main stop word/length filters later.
                                    }
                                    else {
                                        // It contains < or > and is not a recognized operator/stopword.
                                        // This is likely an undesirable fragment.
                                        // console.log(`DEBUG: VocabBuilder: Filtering token with unhandled/partial markup: ${cleanedSubToken}`);
                                        continue;
                                    }
                                }
                                // Filter tokens with internal brackets/braces/parentheses if they don't fully enclose the token
                                // (e.g. "func(tion" but not "(param)")
                                if (/[()\[\]{}]/.test(cleanedSubToken) && !cleanedSubToken.startsWith("(") && !cleanedSubToken.endsWith(")")) {
                                    // console.log(`DEBUG: VocabBuilder: Filtering token with internal punctuation: ${cleanedSubToken}`);
                                    continue;
                                }
                                // Filter relative paths like ../../file.txt or ./src
                                if (/^(?:\.\.\/|\.\/)+[\w\-\/\.]+$/.test(cleanedSubToken)) {
                                    // console.log(`DEBUG: VocabBuilder: Filtering relative path: ${cleanedSubToken}`);
                                    continue;
                                }
                                // Filter numbers ending with punctuation like "123," or "456;"
                                if (/^[0-9]+[;,]$/.test(cleanedSubToken)) {
                                    // console.log(`DEBUG: VocabBuilder: Filtering number with trailing punctuation: ${cleanedSubToken}`);
                                    continue;
                                }
                                // Filter for specific JSON-like fragments (this was quite specific, review if still needed after other changes)
                                if (cleanedSubToken.includes('":"') &&
                                    cleanedSubToken.includes('","') &&
                                    (cleanedSubToken.includes(":0") || cleanedSubToken.includes(":1"))) {
                                    if (cleanedSubToken.length > 30 ||
                                        cleanedSubToken.includes("term_plural") || // These are also stop words
                                        cleanedSubToken.includes("fuzzy") || // These are also stop words
                                        cleanedSubToken.includes('context":""')) {
                                        // console.log(`DEBUG: VocabBuilder: Filtering specific JSON-like fragment: ${cleanedSubToken}`);
                                        continue;
                                    }
                                }
                                // --- PRIMARY FILTERING (Stop words, pure numbers, very short tokens on *cleaned* token) ---
                                if (this.stopWords.has(cleanedSubToken) ||
                                    /^\d+(\.\d+)?$/.test(cleanedSubToken) || // Is purely numeric (e.g., "123", "4.56")
                                    cleanedSubToken.length <= 1 // Filter single characters (e.g., "x", "_")
                                ) {
                                    //   if (this.stopWords.has(cleanedSubToken)) console.log(`DEBUG: VocabBuilder: Filtered '${cleanedSubToken}' as stop word (pre-stem).`);
                                    //   if (/^\d+(\.\d+)?$/.test(cleanedSubToken)) console.log(`DEBUG: VocabBuilder: Filtered '${cleanedSubToken}' as number (pre-stem).`);
                                    //   if (cleanedSubToken.length <= 1) console.log(`DEBUG: VocabBuilder: Filtered '${cleanedSubToken}' by length (pre-stem).`);
                                    continue;
                                }
                                let stemmedToken = cleanedSubToken;
                                // Only stem if the token is reasonably long to avoid weird stemming of short words
                                if (this.stemmer && stemmedToken.length > 2) {
                                    try {
                                        stemmedToken = this.stemmer.stem(stemmedToken);
                                    }
                                    catch (e) {
                                        console.warn(`Stemming failed for token '${cleanedSubToken}' (original) -> '${stemmedToken}': ${e}`);
                                    }
                                }
                                // --- FINAL FILTERING (Stop words on *stemmed* token, length) ---
                                if (this.stopWords.has(stemmedToken) ||
                                    stemmedToken.length <= 2 // Filter 1 and 2 letter words (e.g., "pi", "da"). Consider stemmedToken.length <= 3 for more aggressive filtering.
                                ) {
                                    //   if (this.stopWords.has(stemmedToken)) console.log(`DEBUG: VocabBuilder: Filtered '${stemmedToken}' as stop word (post-stem).`);
                                    //   if (stemmedToken.length <= 2) console.log(`DEBUG: VocabBuilder: Filtered '${stemmedToken}' by length (post-stem).`);
                                    continue;
                                }
                                processedTokensFinal.push(stemmedToken);
                            } // Closes for (const dotPart of dotParts)
                        } // end loop over tokenPartFromCompound
                    } // end loop over originalToken
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
            vocabulary[sortedTerms[i][0]] = i; // Assign index based on sorted order
        }
        console.log(`Built vocabulary with ${Object.keys(vocabulary).length} terms (target: ${targetSize}, minDf: ${minDf}, maxDf: ${maxDf}).`);
        await this.stateManager.saveVocabulary(vocabulary);
        console.log("Vocabulary saved.");
        return vocabulary;
    }
}
