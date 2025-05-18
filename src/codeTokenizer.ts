import Parser from 'tree-sitter';
import * as TreeSitter from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import * as CSharp from 'tree-sitter-c-sharp';
import JavaScript from 'tree-sitter-javascript'; // Import JavaScript parser
import JSONLang from 'tree-sitter-json'; // Import JSON parser
import { Vocabulary } from "./vocabularyBuilder.js"; // Added import

// Map file extensions to Tree-sitter language names
const extensionToLanguageName: Record<string, string> = {
    '.ts': 'typescript',
    '.js': 'javascript', // Map .js to 'javascript'
    '.tsx': 'typescript',
    '.jsx': 'typescript',
    '.cs': 'csharp',
    '.json': 'json', // Map .json to 'json'
};

// Store loaded language parsers
const languages: Map<string, any> = new Map(); // Use 'any' as a workaround for type definition issues

/**
 * Initialises the Tree-sitter library and loads required language parsers.
 * This should be called once at the start of the application.
 */
export async function initializeCodeTokenizer(): Promise<void> {
    languages.set('typescript', TypeScript.typescript);
    languages.set('csharp', CSharp.default); // Use .default for CJS default export
    languages.set('javascript', JavaScript); // Add JavaScript parser
    languages.set('json', JSONLang); // Add JSON parser
}

/**
 * Retrieves a configured Tree-sitter parser for the given language name.
 * @param languageName The name of the language (e.g., 'typescript', 'csharp').
 * @returns A Parser instance or undefined if the language is not supported.
 */
function getParserForLanguage(languageName: string): any | undefined {
    const language = languages.get(languageName);
    if (!language) {
        return undefined;
    }
    // Use type assertion to create a new Parser instance
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
}

/**
 * Recursively traverses the Tree-sitter syntax tree and extracts tokens.
 * @param node The current node to traverse.
 * @param tokens The array to accumulate extracted tokens.
 * @param vocabulary Optional vocabulary to filter tokens.
 */
function isConsideredIdentifier(node: any, languageName?: string): boolean {
    const type = node.type;
    // These are generally leaf nodes or nodes whose text is a single identifier.
    const baseIdentifierTypes = ['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'];
    if (baseIdentifierTypes.includes(type)) {
        return true;
    }
    if (languageName === 'typescript') {
        // 'this' and 'super' can be considered identifiers in this context.
        if (type === 'this' || type === 'super') return true;
    }
    // Add C# specific checks if needed, e.g. for specific keyword-like identifiers.
    return false;
}

function isKeywordOrOperatorOrPunctuation(node: any, languageName?: string): boolean {
    // Unnamed nodes are typically punctuation, operators, etc. Tree-sitter marks them as `node.isNamed === false`.
    if (!node.isNamed) {
        return true;
    }

    const type = node.type;
    // Named nodes that are language keywords.
    if (type.endsWith('_keyword')) return true; // e.g., 'public_keyword', 'static_keyword', 'void_keyword'

    // Consider common statement types whose main text is a keyword and shouldn't be a token itself.
    // This list can be expanded based on specific language grammars from Tree-sitter.
    const keywordLikeStatementTypes = [
        'if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement',
        'return_statement', 'try_statement', 'throw_statement',
        'class_declaration', 'function_declaration', 'lexical_declaration', 'variable_declaration',
        'import_statement', 'export_statement',
        // TypeScript specific
        'interface_declaration', 'enum_declaration', 'type_alias_declaration', 'module', 'namespace',
        // C# specific (examples)
        'namespace_declaration', 'using_directive', 'lock_statement', 'fixed_statement',
        'checked_statement', 'unchecked_statement', 'unsafe_statement', 'yield_statement',
    ];

    if (keywordLikeStatementTypes.includes(type)) {
        return true;
    }
    return false;
}

function extractTokensFromNode(node: any, tokens: string[], vocabulary?: Vocabulary, languageName?: string): void {
    // 1. Skip non-documentation comments entirely
    if (node.type === 'comment' && !node.type.includes('documentation')) {
        return;
    }

    // 2. Handle string literals (extract content, split by whitespace)
    // Includes regular strings and template string fragments
    if (node.type === 'string_literal' || node.type === 'string' || node.type.includes('string_fragment')) {
        // For template string fragments (e.g., `some text ${expr} more text`), node.text is just the fragment.
        // For regular string literals, node.text includes quotes.
        const stringContent = (node.type.includes('string_fragment') || node.type === 'string') ? node.text : node.text.slice(1, -1);
        const stringTokens = stringContent.split(/\s+/).filter((token: string) => token.trim().length > 0);
        for (const strToken of stringTokens) {
            const normalizedStrToken = strToken.toLowerCase().trim();
            if (normalizedStrToken.length >= 2) {
                // Vocabulary check here is for the scenario where this function might be called with a vocab.
                // The main tokenizeCode will pass undefined for vocab.
                if (!vocabulary || vocabulary[normalizedStrToken]) {
                    tokens.push(normalizedStrToken);
                }
            }
        }
        // Do not return here if it's a template string, as children (expressions within ${}) need processing.
        // For simple string literals, returning early was the old behavior.
        // Let's allow recursion for all string types to be safe with template strings.
    }
    // 3. Handle XML specific nodes (retaining and adapting current logic)
    else if (node.type === 'xml_tag_name') {
        const tagName = node.text.toLowerCase().trim();
        if (tagName.length >= 2) {
            if (!vocabulary || vocabulary[tagName]) {
                tokens.push(tagName);
            }
        }
    } else if (node.type === 'xml_text') {
        const textContent = node.text.trim();
        const parts = textContent.split(/[<>\s]+/).filter((part: string) => part.trim().length > 0);
        for (const part of parts) {
            let normalizedPart = part.toLowerCase().trim();
            normalizedPart = normalizedPart.replace(/^\/+|\/+$/g, '');
            if (normalizedPart.length >= 2) {
                if (!vocabulary || vocabulary[normalizedPart]) {
                    tokens.push(normalizedPart);
                }
            }
        }
    } else if (node.type === 'xml_attribute') {
        // Current logic: We don't process node.text of 'xml_attribute' directly, but recurse. This is fine.
        // Children of xml_attribute (like attribute name and value) will be processed by recursion.
    }
    // 4. Specifically extract known identifier types
    else if (isConsideredIdentifier(node, languageName)) {
        let tokenText = node.text.trim();
        if (tokenText.length > 0) {
            // No vocabulary check here. Let VocabularyBuilder do all filtering after compound splitting and stemming.
            tokens.push(tokenText); // Add the raw identifier text
        }
        // Identifiers are usually terminal for their own text, but their children might be other identifiers
        // (e.g., in a qualified access `a.b`, `a` is an identifier, and `b` is a child identifier if the grammar nests them).
        // So, we *don't* return; we let recursion handle children.
    }
    // 5. Optionally SKIP language keywords, operators, punctuation
    else if (isKeywordOrOperatorOrPunctuation(node, languageName)) {
        // Do nothing with this node's text, but recurse to its children
        // as they might contain identifiers (e.g., an 'if_statement' node contains condition expressions).
    }
    // 6. Fallback: No generic splitting. If a node type is not handled above,
    // its text is not directly added. Only recursion to children might find tokens.
    // This replaces the old generic `else if (node.type !== 'comment')` block.

    // 7. Recursively visit children (current logic is essential)
    for (const child of node.children) {
        extractTokensFromNode(child, tokens, vocabulary, languageName); // Pass languageName down
    }
}

/**
 * Tokenizes code text using Tree-sitter based on the file extension.
 * Extracts meaningful tokens like identifiers, keywords, and literals.
 * @param text The code text to tokenize.
 * @param fileExtension The extension of the file (e.g., '.ts', '.cs').
 * @param vocabulary Optional vocabulary to filter tokens. (Intended to be unused here; filtering in VocabBuilder)
 * @returns An array of extracted and normalized tokens.
 */
export function tokenizeCode(text: string, fileExtension: string, vocabulary?: Vocabulary): string[] {
    const languageName = extensionToLanguageName[fileExtension.toLowerCase()];
    const parser = getParserForLanguage(languageName);

    const fallbackTokenization = (inputText: string, vocab?: Vocabulary): string[] => {
        // Pass raw words to VocabularyBuilder for consistent cleaning/splitting/stemming.
        const rawWords = inputText.split(/\s+/).filter(w => w.trim().length > 1); // Min length 2 for raw words
        
        // If vocabulary is provided (legacy or direct call), filter here.
        // Otherwise, VocabularyBuilder will handle it.
        if (vocab) {
            return rawWords.filter(word => {
                const normalized = word.toLowerCase(); // Basic normalization for vocab check
                return vocab[normalized];
            });
        }
        return rawWords;
    };

    if (!parser) {
        console.warn(`Unsupported language for extension: ${fileExtension}. Using basic tokenization.`);
        return fallbackTokenization(text, vocabulary); // Pass vocabulary for fallback
    }

    try {
        const tree = parser.parse(text);
        const tokens: string[] = [];
        // Pass undefined for vocabulary; filtering is best done in VocabularyBuilder after compound splitting etc.
        // Pass languageName for language-specific logic within extractTokensFromNode.
        extractTokensFromNode(tree.rootNode, tokens, undefined, languageName);
        return tokens; // These are "raw-ish" tokens (whole identifiers, string contents, etc.)
    } catch (error) {
        console.error(`Error parsing code with Tree-sitter for extension ${fileExtension}:`, error);
        return fallbackTokenization(text, vocabulary); // Pass vocabulary for fallback
    }
    // The 'finally' block for deleting parser was removed as it's not needed for JS bindings.
}

// Note: initializeCodeTokenizer must be called before using tokenizeCode