import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import * as CSharp from 'tree-sitter-c-sharp';
import JavaScript from 'tree-sitter-javascript';
import JSONLang from 'tree-sitter-json';
import { Vocabulary } from "./vocabularyBuilder.js";

const extensionToLanguageName: Record<string, string> = {
    '.ts': 'typescript',
    '.js': 'javascript',
    '.tsx': 'typescript',
    '.jsx': 'typescript',
    '.cs': 'csharp',
    '.json': 'json',
};

const languages: Map<string, any> = new Map();

/**
 * Initialises the Tree-sitter library and loads required language parsers.
 * This should be called once at the start of the application.
 */
export async function initializeCodeTokenizer(): Promise<void> {
    languages.set('typescript', TypeScript.typescript);
    languages.set('csharp', CSharp.default);
    languages.set('javascript', JavaScript);
    languages.set('json', JSONLang);
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
    const baseIdentifierTypes = ['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'];
    if (baseIdentifierTypes.includes(type)) {
        return true;
    }
    if (languageName === 'typescript') {
        if (type === 'this' || type === 'super') return true;
    }
    return false;
}

function isKeywordOrOperatorOrPunctuation(node: any, languageName?: string): boolean {
    if (!node.isNamed) {
        return true;
    }

    const type = node.type;
    if (type.endsWith('_keyword')) return true;

    const keywordLikeStatementTypes = [
        'if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement',
        'return_statement', 'try_statement', 'throw_statement',
        'class_declaration', 'function_declaration', 'lexical_declaration', 'variable_declaration',
        'import_statement', 'export_statement',
        'interface_declaration', 'enum_declaration', 'type_alias_declaration', 'module', 'namespace',
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
    if (node.type === 'string_literal' || node.type === 'string' || node.type.includes('string_fragment')) {
        const stringContent = (node.type.includes('string_fragment') || node.type === 'string') ? node.text : node.text.slice(1, -1);
        const stringTokens = stringContent.split(/\s+/).filter((token: string) => token.trim().length > 0);
        for (const strToken of stringTokens) {
            const normalizedStrToken = strToken.toLowerCase().trim();
            if (normalizedStrToken.length >= 2) {
                if (!vocabulary || vocabulary[normalizedStrToken]) {
                    tokens.push(normalizedStrToken);
                }
            }
        }
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
    }
    // 4. Specifically extract known identifier types
    else if (isConsideredIdentifier(node, languageName)) {
        let tokenText = node.text.trim();
        if (tokenText.length > 0) {
            // No vocabulary check here. Let VocabularyBuilder do all filtering after compound splitting and stemming.
            tokens.push(tokenText);
        }
    }
    // 5. Optionally SKIP language keywords, operators, punctuation
    else if (isKeywordOrOperatorOrPunctuation(node, languageName)) {
        // Do nothing with this node's text, but recurse to its children
    }
    // 6. Fallback: No generic splitting. If a node type is not handled above,
    // its text is not directly added. Only recursion to children might find tokens.

    // 7. Recursively visit children
    for (const child of node.children) {
        extractTokensFromNode(child, tokens, vocabulary, languageName);
    }
}

/**
 * Tokenizes code text using Tree-sitter based on the file extension.
 * Extracts meaningful tokens like identifiers, keywords, and literals.
 * @param text The code text to tokenize.
 * @param fileExtension The extension of the file (e.g., '.ts', '.cs').
 * @param vocabulary Optional vocabulary to filter tokens.
 * @returns An array of extracted and normalized tokens.
 */
export function tokenizeCode(text: string, fileExtension: string, vocabulary?: Vocabulary): string[] {
    const languageName = extensionToLanguageName[fileExtension.toLowerCase()];
    const parser = getParserForLanguage(languageName);

    const fallbackTokenization = (inputText: string, vocab?: Vocabulary): string[] => {
        // Pass raw words to VocabularyBuilder for consistent cleaning/splitting/stemming.
        const rawWords = inputText.split(/\s+/).filter(w => w.trim().length > 1); // Min length 2 for raw words
        
        if (vocab) {
            return rawWords.filter(word => {
                const normalized = word.toLowerCase();
                return vocab[normalized];
            });
        }
        return rawWords;
    };

    if (!parser) {
        console.warn(`Unsupported language for extension: ${fileExtension}. Using basic tokenization.`);
        return fallbackTokenization(text, vocabulary);
    }

    try {
        const tree = parser.parse(text);
        const tokens: string[] = [];
        // Pass undefined for vocabulary; filtering is best done in VocabularyBuilder after compound splitting etc.
        extractTokensFromNode(tree.rootNode, tokens, undefined, languageName);
        return tokens;
    } catch (error) {
        console.error(`Error parsing code with Tree-sitter for extension ${fileExtension}:`, error);
        return fallbackTokenization(text, vocabulary);
    }
}

// Note: initializeCodeTokenizer must be called before using tokenizeCode