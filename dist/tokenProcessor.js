import natural from 'natural';
const PorterStemmer = natural.PorterStemmer; // Instance
// Define a default set of stop words (Copied exactly from embedder/src/vocabularyBuilder.ts)
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
// Helper function to split camelCase and snake_case words (Copied exactly from embedder/src/vocabularyBuilder.ts)
function splitCompoundIdentifier(token) {
    if (token.includes('-') || token.includes('_')) { // Handle snake_case and kebab-case
        return token.split(/[-_]/).filter(t => t.length > 0);
    }
    // Split camelCase: Credit to https://stackoverflow.com/a/76279304/1089576
    const words = token.match(/([A-Z_]?([a-z0-9]+)|[A-Z_]+)/g);
    return words ? words.map(w => w.replace(/^_/, '')) : [token];
}
/**
 * Processes raw text through the full tokenization, cleaning, filtering, and stemming pipeline.
 * This function encapsulates the logic previously found in embedder/src/vocabularyBuilder.ts.
 * @param text The raw input text (e.g., code chunk or query string).
 * @returns An array of processed, stemmed, and filtered tokens.
 */
export function processTextToFinalTokens(text) {
    const stemmer = PorterStemmer; // Use the same stemmer instance
    // Replicate the initial splitting logic from vocabularyBuilder, adapted for a raw string input
    const initialTokens = text
        .replace(/[\r\n]+/g, " ; ") // Normalize newlines to a consistent separator
        .split(/\s*;\s*/) // Split by the separator, allowing for surrounding whitespace
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    const processedTokensFinal = [];
    for (const originalToken of initialTokens) {
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
                    continue;
                }
                // Filter for <tag> style tokens (simple complete ones like <summary> or <br/>)
                if (/^<[a-zA-Z0-9_:\-\.\/]+>$/.test(cleanedSubToken)) {
                    continue;
                }
                // Filter for tokens containing markup characters (<, >) mixed with other content or partial tags
                // Examples: "includeassets>runtim", "buildtransitive</includeasset", "foo<bar"
                if (/[<>]/.test(cleanedSubToken)) {
                    const knownOperatorsWithMarkup = /^(?:=>|<=|>=|->)$/; // Add others if necessary
                    if (DEFAULT_STOP_WORDS.has(cleanedSubToken) || knownOperatorsWithMarkup.test(cleanedSubToken)) {
                        // It's a stop word (like "=>") or a known operator.
                        // Let it pass this specific filter; it will be handled by the main stop word/length filters later.
                    }
                    else {
                        // It contains < or > and is not a recognized operator/stopword.
                        // This is likely an undesirable fragment.
                        continue;
                    }
                }
                // Filter tokens with internal brackets/braces/parentheses if they don't fully enclose the token
                // (e.g. "func(tion" but not "(param)")
                if (/[()\[\]{}]/.test(cleanedSubToken) && !cleanedSubToken.startsWith("(") && !cleanedSubToken.endsWith(")")) {
                    continue;
                }
                // Filter relative paths like ../../file.txt or ./src
                if (/^(?:\.\.\/|\.\/)+[\w\-\/\.]+$/.test(cleanedSubToken)) {
                    continue;
                }
                // Filter numbers ending with punctuation like "123," or "456;"
                if (/^[0-9]+[;,]$/.test(cleanedSubToken)) {
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
                        continue;
                    }
                }
                // --- PRIMARY FILTERING (Stop words, pure numbers, very short tokens on *cleaned* token) ---
                if (DEFAULT_STOP_WORDS.has(cleanedSubToken) ||
                    /^\d+(\.\d+)?$/.test(cleanedSubToken) || // Is purely numeric (e.g., "123", "4.56")
                    cleanedSubToken.length <= 1 // Filter single characters (e.g., "x", "_")
                ) {
                    continue;
                }
                let stemmedToken = cleanedSubToken;
                // Only stem if the token is reasonably long to avoid weird stemming of short words
                if (stemmer && stemmedToken.length > 2) {
                    try {
                        stemmedToken = stemmer.stem(stemmedToken);
                    }
                    catch (e) {
                        console.warn(`Stemming failed for token '${cleanedSubToken}' (original) -> '${stemmedToken}': ${e}`);
                    }
                }
                // --- FINAL FILTERING (Stop words on *stemmed* token, length) ---
                if (DEFAULT_STOP_WORDS.has(stemmedToken) ||
                    stemmedToken.length <= 2 // Filter 1 and 2 letter words (e.g., "pi", "da"). Consider stemmedToken.length <= 3 for more aggressive filtering.
                ) {
                    continue;
                }
                processedTokensFinal.push(stemmedToken);
            } // Closes for (const dotPart of dotParts)
        } // end loop over tokenPartFromCompound
    } // end loop over originalToken
    return processedTokensFinal;
}
// Export the stop words set as well, in case it's needed elsewhere (e.g., for debugging or visualization)
export { DEFAULT_STOP_WORDS };
