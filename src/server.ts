import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    Range,
    Position,
    Location,
    ReferenceParams
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';

// --- Tokenizer Types ---
enum TokenType {
    STATE_DECLARATION,
    EVENT,
    ACTION,
    TRANSITION,
    GUARD_START,
    GUARD_CONTENT,
    GUARD_END,
    ON_ENTRY,
    ON_EXIT,
    INITIAL_PSEUDO_STATE,
    INDENT,
    DEDENT,
    NEWLINE,
    UNKNOWN,
    EOF
}

interface Token {
    type: TokenType;
    text: string;
    range: Range;
    indentation: number;
}

// --- AST Types ---
export interface ActionNode {
    type: 'Action';
    name: string;
    range: Range;
}

export interface TransitionNode {
    type: 'Transition';
    targetStateName: string;
    range: Range;
}

export interface EventHandlerNode {
    type: 'EventHandler';
    event: string;
    guard?: string;
    range: Range;
    actions: ActionNode[];
    transition?: TransitionNode;
}

export interface StateNode {
    type: 'State';
    name: string;
    range: Range;
    fullRange: Range;
    onEntryActions: ActionNode[];
    onExitActions: ActionNode[];
    eventHandlers: EventHandlerNode[];
    subStates: StateNode[];
    parent?: StateNode;
    indentation: number;
    initialSubStateName?: string;
    initialTransitionRange?: Range;
}

export type StateMachineModel = StateNode[];

// --- Debugger Types (Matching Debugger Expectations) ---
interface StateTransition {
    target: string;
    action?: string;
    guard?: string;
}

interface StateData {
    name: string;
    onEntry?: string[];
    onExit?: string[];
    transitions: { [event: string]: StateTransition[] };
}

interface StateMachine {
    initialState: string;
    states: { [stateName: string]: StateData };
}

interface ExecuteActionResult {
    newState?: string;       // If a single, unambiguous transition occurred
    choices?: {             // If multiple guarded transitions are possible
        event: string;
        guard?: string;
        target: string;
        range: Range;
    }[];
    error?: string;         // If an error occurred
    warning?: string;       // If a non-critical issue occurred
    targetStateRange?: Range; // Add range for the target state definition
}

// --- Tokenizer Implementation ---
function tokenize(textDocument: TextDocument): Token[] {
    const text = textDocument.getText();
    const lines = text.split(/\r?\n/);
    const tokens: Token[] = [];
    let currentIndentation = 0;
    const indentationStack: number[] = [0];

    const onEntryRegex = /^(\s*)OnEntry/;
    const onExitRegex = /^(\s*)OnExit/;
    const initialRegex = /^(\s*)Initial/;
    const stateRegex = /^(\s*)(\w[\w\s]*)/;
    const eventRegex = /^(\s*)-\s*(\w[\w\s]*)(?:\s*(\[))?/;
    const actionRegex = /^(\s*)\/\s*(.*)/;
    const transitionRegex = /^(\s*)->\s*(\w[\w\s]*)/;
    const commentRegex = /^\s*\/\//;
    const emptyLineRegex = /^\s*$/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i;

        if (commentRegex.test(line) || emptyLineRegex.test(line)) {
            if (tokens.length > 0 && tokens[tokens.length - 1].type !== TokenType.NEWLINE) {
                tokens.push({ type: TokenType.NEWLINE, text: '\n', range: Range.create(lineNum, line.length, lineNum, line.length), indentation: currentIndentation });
            }
            continue;
        }

        const lineIndentationMatch = line.match(/^(\s*)/);
        const lineIndentation = lineIndentationMatch ? lineIndentationMatch[1].length : 0;

        if (lineIndentation > currentIndentation) {
            indentationStack.push(lineIndentation);
            tokens.push({ type: TokenType.INDENT, text: '', range: Range.create(lineNum, 0, lineNum, lineIndentation), indentation: lineIndentation });
            currentIndentation = lineIndentation;
        } else {
            while (lineIndentation < currentIndentation) {
                indentationStack.pop();
                const previousIndentation = indentationStack[indentationStack.length - 1];
                if (lineIndentation > previousIndentation) {
                    tokens.push({ type: TokenType.UNKNOWN, text: line.trim(), range: Range.create(lineNum, 0, lineNum, line.length), indentation: lineIndentation });
                    currentIndentation = lineIndentation;
                    break;
                }
                tokens.push({ type: TokenType.DEDENT, text: '', range: Range.create(lineNum, 0, lineNum, lineIndentation), indentation: lineIndentation });
                currentIndentation = previousIndentation;
            }
        }
        if (lineIndentation !== currentIndentation) {
            tokens.push({ type: TokenType.UNKNOWN, text: line.trim(), range: Range.create(lineNum, 0, lineNum, line.length), indentation: lineIndentation });
            continue;
        }

        const trimmedLine = line.trim();
        const startCol = lineIndentation;
        const endCol = startCol + trimmedLine.length;
        const range = Range.create(lineNum, startCol, lineNum, endCol);

        let match: RegExpMatchArray | null;

        if ((match = line.match(onEntryRegex)) && match[1].length === currentIndentation) {
            tokens.push({ type: TokenType.ON_ENTRY, text: 'OnEntry', range, indentation: currentIndentation });
        } else if ((match = line.match(onExitRegex)) && match[1].length === currentIndentation) {
            tokens.push({ type: TokenType.ON_EXIT, text: 'OnExit', range, indentation: currentIndentation });
        } else if ((match = line.match(initialRegex)) && match[1].length === currentIndentation) {
            tokens.push({ type: TokenType.INITIAL_PSEUDO_STATE, text: 'Initial', range, indentation: currentIndentation });
        } else if ((match = line.match(stateRegex)) && match[1].length === currentIndentation && !eventRegex.test(line) && !actionRegex.test(line) && !transitionRegex.test(line) && !onEntryRegex.test(line) && !onExitRegex.test(line) && !initialRegex.test(line)) {
            tokens.push({ type: TokenType.STATE_DECLARATION, text: match[2].trim(), range: Range.create(lineNum, startCol, lineNum, startCol + match[2].trim().length), indentation: currentIndentation });
        } else if ((match = line.match(eventRegex)) && match[1].length === currentIndentation) {
            const eventText = match[2].trim();
            const eventEndCol = line.indexOf(eventText, startCol) + eventText.length;
            tokens.push({ type: TokenType.EVENT, text: eventText, range: Range.create(lineNum, line.indexOf(eventText, startCol), lineNum, eventEndCol), indentation: currentIndentation });

            if (match[3]) {
                const guardStartCol = line.indexOf('[', eventEndCol);
                if (guardStartCol !== -1) {
                    tokens.push({ type: TokenType.GUARD_START, text: '[', range: Range.create(lineNum, guardStartCol, lineNum, guardStartCol + 1), indentation: currentIndentation });

                    let bracketLevel = 1;
                    let guardEndCol = -1;
                    let currentPos = guardStartCol + 1;

                    while (currentPos < line.length) {
                        if (line[currentPos] === '[') {
                            bracketLevel++;
                        } else if (line[currentPos] === ']') {
                            bracketLevel--;
                            if (bracketLevel === 0) {
                                guardEndCol = currentPos;
                                break;
                            }
                        }
                        currentPos++;
                    }

                    if (guardEndCol !== -1) {
                        const guardContent = line.substring(guardStartCol + 1, guardEndCol).trim();
                        const actualContentStart = line.indexOf(guardContent, guardStartCol + 1);
                        const actualContentEnd = actualContentStart + guardContent.length;
                        tokens.push({ type: TokenType.GUARD_CONTENT, text: guardContent, range: Range.create(lineNum, actualContentStart, lineNum, actualContentEnd), indentation: currentIndentation });
                        tokens.push({ type: TokenType.GUARD_END, text: ']', range: Range.create(lineNum, guardEndCol, lineNum, guardEndCol + 1), indentation: currentIndentation });
                    } else {
                        const remainingText = line.substring(guardStartCol + 1).trim();
                        if (remainingText) {
                            tokens.push({ type: TokenType.UNKNOWN, text: remainingText, range: Range.create(lineNum, guardStartCol + 1, lineNum, line.length), indentation: currentIndentation });
                        }
                    }
                } else {
                    const remainingText = line.substring(eventEndCol).trim();
                    if (remainingText) {
                        tokens.push({ type: TokenType.UNKNOWN, text: remainingText, range: Range.create(lineNum, eventEndCol, lineNum, line.length), indentation: currentIndentation });
                    }
                }
            }
        } else if ((match = line.match(actionRegex)) && match[1].length === currentIndentation) {
            tokens.push({ type: TokenType.ACTION, text: match[2].trim(), range: Range.create(lineNum, startCol + line.substring(startCol).indexOf('/') + 1, lineNum, endCol), indentation: currentIndentation });
        } else if ((match = line.match(transitionRegex)) && match[1].length === currentIndentation) {
            tokens.push({ type: TokenType.TRANSITION, text: match[2].trim(), range: Range.create(lineNum, startCol + line.substring(startCol).indexOf('>') + 1, lineNum, endCol), indentation: currentIndentation });
        } else {
            if (trimmedLine.length > 0) {
                tokens.push({ type: TokenType.UNKNOWN, text: trimmedLine, range, indentation: currentIndentation });
            }
        }
        if (!commentRegex.test(line) && !emptyLineRegex.test(line) && (tokens.length === 0 || tokens[tokens.length - 1].type !== TokenType.NEWLINE)) {
            tokens.push({ type: TokenType.NEWLINE, text: '\n', range: Range.create(lineNum, line.length, lineNum, line.length), indentation: currentIndentation });
        }
    }

    while (currentIndentation > 0) {
        indentationStack.pop();
        const previousIndentation = indentationStack[indentationStack.length - 1];
        tokens.push({ type: TokenType.DEDENT, text: '', range: Range.create(lines.length, 0, lines.length, 0), indentation: previousIndentation });
        currentIndentation = previousIndentation;
    }

    tokens.push({ type: TokenType.EOF, text: '', range: Range.create(lines.length > 0 ? lines.length : 0, 0, lines.length > 0 ? lines.length : 0, 0), indentation: 0 });
    return tokens;
}

// --- Parser Implementation ---
class Parser {
    private tokens: Token[];
    private current = 0;
    private diagnostics: Diagnostic[] = [];
    private textDocument: TextDocument;

    constructor(tokens: Token[], textDocument: TextDocument) {
        this.tokens = tokens.filter(token => token.type !== TokenType.NEWLINE);
        this.textDocument = textDocument;
    }

    parse(): { model: StateMachineModel, diagnostics: Diagnostic[] } {
        const states: StateNode[] = [];
        while (!this.isAtEnd()) {
            if (this.match(TokenType.STATE_DECLARATION)) {
                const state = this.parseState(null, this.previous().indentation);
                if (state) {
                    states.push(state);
                }
            } else if (this.match(TokenType.INDENT, TokenType.DEDENT)) {
                this.advance();
            } else if (!this.isAtEnd()) {
                this.addDiagnostic('Expected state declaration at the top level.', this.peek().range);
                this.advance();
            }
        }
        return { model: states, diagnostics: this.diagnostics };
    }

    private parseActionBlock(parentIndentationLevel: number): ActionNode[] {
        const actions: ActionNode[] = [];

        if (!this.match(TokenType.INDENT)) {
            this.addDiagnostic('Expected indent for action block.', this.peek().range);
            return actions;
        }

        while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
            if (this.match(TokenType.ACTION)) {
                actions.push({ type: 'Action', name: this.previous().text, range: this.previous().range });
            } else {
                this.addDiagnostic('Expected action (starting with /) within the action block.', this.peek().range);
                this.advance();
            }
        }

        if (this.isAtEnd()) {
            const errorRange = actions.length > 0 ? actions[actions.length - 1].range : this.previous().range;
            this.addDiagnostic('Reached end of file unexpectedly. Missing dedent for action block?', errorRange);
        } else if (!this.match(TokenType.DEDENT)) {
            this.addDiagnostic('Expected dedent to close action block.', this.peek().range);
        }

        return actions;
    }

    private parseEventHandler(expectedHandlerIndentation: number): EventHandlerNode | null {
        if (this.previous().type !== TokenType.EVENT) return null;

        const eventToken = this.previous();
        let guardContent: string | undefined = undefined;
        let guardRange: Range | undefined = undefined;
        let guardContentRange: Range | undefined = undefined;

        if (this.match(TokenType.GUARD_START)) {
            const guardStartToken = this.previous();
            guardRange = guardStartToken.range;
            if (this.match(TokenType.GUARD_CONTENT)) {
                const guardContentToken = this.previous();
                guardContent = guardContentToken.text;
                guardContentRange = guardContentToken.range;
                guardRange = Range.create(guardRange.start, guardContentToken.range.end);
            } else {
                guardContent = "";
                guardContentRange = Range.create(guardStartToken.range.end, guardStartToken.range.end);
                guardRange = Range.create(guardRange.start, guardStartToken.range.end);
            }
            if (this.match(TokenType.GUARD_END)) {
                guardRange = Range.create(guardRange.start, this.previous().range.end);
            } else {
                this.addDiagnostic('Expected closing "]" for guard condition.', this.peek().range);
                guardRange = guardContentRange ? Range.create(guardStartToken.range.start, guardContentRange.end) : guardStartToken.range;
            }
        }

        const handlerNode: EventHandlerNode = {
            type: 'EventHandler',
            event: eventToken.text,
            guard: guardContent,
            range: guardRange ? Range.create(eventToken.range.start, guardRange.end) : eventToken.range,
            actions: [],
            transition: undefined
        };

        if (this.match(TokenType.INDENT)) {
            while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
                if (this.match(TokenType.ACTION)) {
                    handlerNode.actions.push({ type: 'Action', name: this.previous().text, range: this.previous().range });
                } else if (this.match(TokenType.TRANSITION)) {
                    if (handlerNode.transition) {
                        this.addDiagnostic('Multiple transitions defined for the same event handler.', this.previous().range);
                    }
                    handlerNode.transition = { type: 'Transition', targetStateName: this.previous().text, range: this.previous().range };
                } else {
                    this.addDiagnostic('Expected action (/) or transition (->).', this.peek().range);
                    this.advance();
                }
            }

            if (this.isAtEnd()) {
                this.addDiagnostic('Reached end of file unexpectedly. Missing dedent for event handler block?', handlerNode.range);
            } else if (!this.match(TokenType.DEDENT)) {
                this.addDiagnostic('Expected dedent to close event handler block.', this.peek().range);
            }
        }

        return handlerNode;
    }

    private parseState(parent: StateNode | null, expectedIndentation: number): StateNode | null {
        if (this.previous().type !== TokenType.STATE_DECLARATION) {
            this.addDiagnostic('Expected state declaration.', this.previous().range);
            return null;
        }

        const stateToken = this.previous();
        const stateNode: StateNode = {
            type: 'State',
            name: stateToken.text,
            range: stateToken.range,
            fullRange: stateToken.range,
            onEntryActions: [],
            onExitActions: [],
            eventHandlers: [],
            subStates: [],
            parent: parent ?? undefined,
            indentation: stateToken.indentation,
        };

        if (this.check(TokenType.INDENT)) {
            this.advance();
            let initialFound = false;

            while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
                if (this.match(TokenType.ON_ENTRY)) {
                    stateNode.onEntryActions.push(...this.parseActionBlock(stateNode.indentation));
                } else if (this.match(TokenType.ON_EXIT)) {
                    stateNode.onExitActions.push(...this.parseActionBlock(stateNode.indentation));
                } else if (this.match(TokenType.INITIAL_PSEUDO_STATE)) {
                    if (initialFound) {
                        this.addDiagnostic('Multiple Initial pseudo-states defined within the same composite state.', this.previous().range);
                    }
                    initialFound = true;
                    if (this.match(TokenType.INDENT)) {
                        if (this.match(TokenType.TRANSITION)) {
                            if (stateNode.initialSubStateName) {
                                this.addDiagnostic('Multiple transitions defined for the Initial pseudo-state.', this.previous().range);
                            }
                            stateNode.initialSubStateName = this.previous().text;
                            stateNode.initialTransitionRange = this.previous().range;
                        } else {
                            this.addDiagnostic('Expected transition (->) following Initial pseudo-state.', this.peek().range);
                            while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) this.advance();
                        }
                        if (!this.match(TokenType.DEDENT)) {
                            this.addDiagnostic('Expected dedent to close Initial pseudo-state block.', this.peek().range);
                        }
                    } else {
                        this.addDiagnostic('Expected indent for Initial pseudo-state transition.', this.peek().range);
                    }
                } else if (this.match(TokenType.EVENT)) {
                    const handler = this.parseEventHandler(stateNode.indentation);
                    if (handler) stateNode.eventHandlers.push(handler);
                } else if (this.match(TokenType.STATE_DECLARATION)) {
                    const subStateToken = this.previous();
                    if (subStateToken.indentation !== this.peek().indentation && this.peek().type === TokenType.INDENT) {
                        const subState = this.parseState(stateNode, this.peek().indentation);
                        if (subState) stateNode.subStates.push(subState);
                    } else if (subStateToken.indentation === expectedIndentation + 1) {
                        const subState = this.parseState(stateNode, subStateToken.indentation);
                        if (subState) stateNode.subStates.push(subState);
                    } else {
                        const simpleSubState: StateNode = {
                            type: 'State',
                            name: subStateToken.text,
                            range: subStateToken.range,
                            fullRange: subStateToken.range,
                            onEntryActions: [],
                            onExitActions: [],
                            eventHandlers: [],
                            subStates: [],
                            parent: stateNode,
                            indentation: subStateToken.indentation,
                        };
                        stateNode.subStates.push(simpleSubState);
                    }
                } else if (this.match(TokenType.INDENT, TokenType.DEDENT)) {
                    this.addDiagnostic('Unexpected indent/dedent inside state body.', this.previous().range);
                } else if (this.check(TokenType.EOF)) {
                    break;
                } else {
                    if (!this.check(TokenType.DEDENT)) {
                        this.addDiagnostic('Expected OnEntry, OnExit, Initial, Event, or nested State.', this.peek().range);
                        this.advance();
                    }
                }
            }

            if (this.isAtEnd()) {
                this.addDiagnostic('Reached end of file unexpectedly. Missing dedent?', stateNode.range);
            } else {
                this.consume(TokenType.DEDENT, 'Expected dedent to close state block.');
                stateNode.fullRange = Range.create(stateNode.range.start, this.previous().range.end);
            }
        } else {
            stateNode.fullRange = stateNode.range;
        }

        return stateNode;
    }

    private match(...types: TokenType[]): boolean {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    private consume(type: TokenType, message: string): Token | null {
        if (this.check(type)) return this.advance();
        this.addDiagnostic(message, this.peek().range);
        return null;
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek().type === type;
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.current++;
        return this.previous();
    }

    private isAtEnd(): boolean {
        return this.peek().type === TokenType.EOF;
    }

    private peek(): Token {
        return this.tokens[this.current];
    }

    private previous(): Token {
        return this.tokens[this.current - 1];
    }

    private addDiagnostic(message: string, range: Range, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
        if (!range || !Number.isFinite(range.start?.line) || !Number.isFinite(range.start?.character) ||
            !Number.isFinite(range.end?.line) || !Number.isFinite(range.end?.character)) {
            range = Range.create(0, 0, 0, 0);
        }

        const startLine = Math.max(0, Math.floor(range.start.line));
        const startChar = Math.max(0, Math.floor(range.start.character));
        const endLine = Math.max(0, Math.floor(range.end.line));
        const endChar = Math.max(0, Math.floor(range.end.character));

        const docLineCount = this.textDocument.lineCount;
        if (docLineCount === 0) return;
        const clampedStartLine = Math.min(startLine, docLineCount - 1);
        const clampedEndLine = Math.min(endLine, docLineCount - 1);

        let startLineLength = 0;
        try {
            const startOffset = this.textDocument.offsetAt(Position.create(clampedStartLine, 0));
            const endOffset = this.textDocument.offsetAt(Position.create(clampedStartLine + 1, 0));
            const lineTextWithNewline = this.textDocument.getText().substring(startOffset, endOffset);
            startLineLength = lineTextWithNewline.replace(/\r?\n$/, '').length;
        } catch (e) {}

        let endLineLength = 0;
        if (clampedStartLine === clampedEndLine) {
            endLineLength = startLineLength;
        } else {
            try {
                const startOffset = this.textDocument.offsetAt(Position.create(clampedEndLine, 0));
                const endOffset = this.textDocument.offsetAt(Position.create(clampedEndLine + 1, 0));
                const lineTextWithNewline = this.textDocument.getText().substring(startOffset, endOffset);
                endLineLength = lineTextWithNewline.replace(/\r?\n$/, '').length;
            } catch (e) {}
        }

        const clampedStartChar = Math.min(startChar, startLineLength);
        const clampedEndChar = clampedStartLine === clampedEndLine
            ? Math.min(Math.max(clampedStartChar, endChar), endLineLength)
            : Math.min(endChar, endLineLength);

        const finalStartLine = Math.min(clampedStartLine, clampedEndLine);
        const finalEndLine = Math.max(clampedStartLine, clampedEndLine);
        const finalStartChar = finalStartLine === finalEndLine ? Math.min(clampedStartChar, clampedEndChar) : clampedStartChar;
        const finalEndChar = finalStartLine === finalEndLine ? Math.max(clampedStartChar, clampedEndChar) : clampedEndChar;

        if (!Number.isFinite(finalStartLine) || !Number.isFinite(finalStartChar) || !Number.isFinite(finalEndLine) || !Number.isFinite(finalEndChar)) {
            return;
        }

        const validRange = Range.create(finalStartLine, finalStartChar, finalEndLine, finalEndChar);

        const diagnostic: Diagnostic = {
            severity,
            range: validRange,
            message,
            source: 'stdl-parser'
        };
        this.diagnostics.push(diagnostic);
    }
}

// --- Server Setup (Single Instance) ---
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument?.publishDiagnostics?.relatedInformation);

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            referencesProvider: true
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = { workspaceFolders: { supported: true } };
    }
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }

    connection.onRequest('stdl/getStateMachineModel', async (params: { uri: string }): Promise<StateMachine | null> => {
        try {
            const document = documents.get(params.uri);
            if (!document) {
                connection.console.error(`Document not found for URI: ${params.uri}`);
                return null;
            }
            connection.console.log(`Received request for state machine model: ${params.uri}`);
            const tokens = tokenize(document);
            const parser = new Parser(tokens, document);
            const { model: parsedModel } = parser.parse();
            const stateMachine = transformModelForDebugger(parsedModel);
            if (!stateMachine) {
                connection.console.log(`Transformation resulted in null or empty state machine for ${params.uri}`);
                return null;
            }
            connection.console.log(`Transformation complete for ${params.uri}. Initial state: ${stateMachine.initialState}`);
            return stateMachine;
        } catch (error) {
            connection.console.error(`Error providing state machine model: ${error}`);
            return null;
        }
    });

    connection.onRequest('stdl/executeAction', (params: { uri: string; currentState: string; action: string; guard?: string }): ExecuteActionResult => {
        const { uri, currentState, action, guard } = params;
        console.log(`[Server] Received executeAction request: state='${currentState}', action='${action}', guard='${guard || 'none'}'`);
        const document = documents.get(uri);
        if (!document) {
            console.error(`[Server] Document not found for URI: ${uri}`);
            return { error: 'Document not found' };
        }

        // Use tokenize, Parser, and transformModelForDebugger
        const tokens = tokenize(document);
        const parser = new Parser(tokens, document);
        const { model: parsedModel } = parser.parse();
        const stateMachine = transformModelForDebugger(parsedModel); // This populates localDefinedStatesDebug internally

        if (!stateMachine || !stateMachine.states) {
            console.error(`[Server] Failed to parse or transform state machine for URI: ${uri}`);
            return { error: 'Failed to parse or transform state machine' };
        }

        // Need access to the node map created during transformation
        const localDefinedStatesDebug = new Map<string, { node: StateNode }>();
        function collectAllStatesForAction(nodes: StateNode[], prefix: string = ''): void {
            for (const node of nodes) {
                const qualifiedName = prefix ? `${prefix}.${node.name}` : node.name;
                localDefinedStatesDebug.set(qualifiedName, { node });
                if (node.subStates.length > 0) {
                    collectAllStatesForAction(node.subStates, qualifiedName);
                }
            }
        }
        collectAllStatesForAction(parsedModel); // Populate the map for this request

        const stateData = stateMachine.states[currentState];
        if (!stateData) {
            console.error(`[Server] Current state '${currentState}' not found in transformed machine.`);
            return { error: `State '${currentState}' not found` };
        }

        console.log(`[Server ExecuteAction] State '${currentState}' Data:`, JSON.stringify(stateData, null, 2)); // Log state data

        const possibleTransitions = stateData.transitions[action];
        if (!possibleTransitions || possibleTransitions.length === 0) {
            console.log(`[Server ExecuteAction] No transitions found for action '${action}' in state '${currentState}'.`);
            return { warning: `No transition defined for action '${action}' in state '${currentState}'` };
        }

        console.log(`[Server ExecuteAction] Received Action: '${action}', Guard: '${guard}'`); // Log received guard
        console.log(`[Server ExecuteAction] Possible Transitions for '${action}':`, JSON.stringify(possibleTransitions, null, 2)); // Log possible transitions with their guards

        // Filter transitions based on the provided guard text
        const matchingTransitions = possibleTransitions.filter((t: StateTransition) => { // Add type annotation
            const transitionGuard = t.guard || ''; // Normalize undefined/null/empty guards
            const requestedGuard = guard || ''; // Normalize undefined/null/empty guards
            console.log(`[Server ExecuteAction] Comparing Request Guard '${requestedGuard}' with Transition Guard '${transitionGuard}' -> Match: ${transitionGuard === requestedGuard}`); // Log comparison
            return transitionGuard === requestedGuard; // Exact string comparison
        });

        console.log(`[Server ExecuteAction] Found ${matchingTransitions.length} matching transitions.`); // Log match count

        if (matchingTransitions.length === 1) {
            const targetState = matchingTransitions[0].target;
            console.log(`[Server] Unique transition found: '${currentState}' --(${action}${guard ? ` [${guard}]` : ''})--> '${targetState}'`);
            // Find the range of the target state definition
            const targetStateInfo = localDefinedStatesDebug.get(targetState);
            const targetRange = targetStateInfo?.node.range;
            if (!targetRange) {
                 console.warn(`[Server] Could not find range for target state: ${targetState}`);
            }
            return { newState: targetState, targetStateRange: targetRange }; // Include the range
        } else if (matchingTransitions.length > 1) {
            console.warn(`[Server] Multiple transitions match action '${action}' and guard '${guard || 'none'}' in state '${currentState}'. Returning choices.`);
            // Revert to previous behavior of returning choices if multiple match (though ideally guards are unique)
            const choices = possibleTransitions.map((t: StateTransition) => { // Add type annotation
                // Find the original handler range from the parsed model for better accuracy
                let originalRange: Range = Range.create(0, 0, 0, 0); // Default range
                const sourceNode = findNodeByQualifiedName(parsedModel, currentState);
                if (sourceNode) {
                    const handler = sourceNode.eventHandlers.find(h => h.event === action && (h.guard || '') === (t.guard || ''));
                    if (handler) {
                        originalRange = handler.range;
                    }
                }
                return {
                    event: action,
                    guard: t.guard,
                    target: t.target,
                    range: originalRange
                };
            });
            return { choices: choices, warning: 'Multiple transitions matched the provided guard.' };
        } else {
            console.log(`[Server] No transitions found for action '${action}' with guard '${guard || 'none'}' in state '${currentState}'.`);
            return { warning: `No transition defined for action '${action}' with guard '${guard || 'none'}' in state '${currentState}'` };
        }
    });

    connection.onRequest('stdl/resolveChoice', async (params: { uri: string; currentState: string; chosenTarget: string }): Promise<{ newState?: string; error?: string }> => {
        connection.console.log(`[Server] Received resolveChoice request: state=${params.currentState}, chosenTarget=${params.chosenTarget}, uri=${params.uri}`);
        const document = documents.get(params.uri);
        if (!document) return { error: 'Document not found.' };
        try {
            const tokens = tokenize(document);
            const parser = new Parser(tokens, document);
            const { model: parsedModel } = parser.parse();
            const stateMachine = transformModelForDebugger(parsedModel);
            if (!stateMachine) return { error: 'Failed to parse state machine.' };

            if (!stateMachine.states[params.chosenTarget]) {
                connection.console.error(`[Server] resolveChoice: Chosen target state '${params.chosenTarget}' does not exist.`);
                return { error: `Chosen target state '${params.chosenTarget}' not found.` };
            }
            connection.console.log(`[Server] resolveChoice: Transitioning from '${params.currentState}' to chosen target '${params.chosenTarget}'.`);
            return { newState: params.chosenTarget };
        } catch (error) {
            connection.console.error(`[Server] Error during resolveChoice: ${error}`);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { error: `Internal server error during choice resolution: ${errorMessage}` };
        }
    });

    connection.onRequest('stdl/getActionInfo', async (params: { uri: string; stateName: string; eventName: string; guard?: string }): Promise<{ actions: string[] }[] | null> => {
        const { uri, stateName, eventName, guard } = params;
        connection.console.log(`[Server] Received getActionInfo request: state=${stateName}, event=${eventName}, guard=${guard || 'none'}, uri=${uri}`);
        
        const document = documents.get(uri);
        if (!document) {
            connection.console.error(`[Server] Document not found for URI: ${uri}`);
            return null;
        }
        
        try {
            // Parse the document to get the AST
            const tokens = tokenize(document);
            const parser = new Parser(tokens, document);
            const { model: parsedModel } = parser.parse();
            
            // Find the specific state node
            const stateNode = findNodeByQualifiedName(parsedModel, stateName);
            if (!stateNode) {
                connection.console.warn(`[Server] State '${stateName}' not found in the model.`);
                return null;
            }
            
            // Find event handlers that match the criteria
            const matchingHandlers: { actions: string[] }[] = [];
            for (const handler of stateNode.eventHandlers) {
                if (handler.event === eventName && (handler.guard || '') === (guard || '')) {
                    // Found a matching event handler
                    const actions = handler.actions.map(a => a.name);
                    if (actions.length > 0) {
                        matchingHandlers.push({ actions });
                        connection.console.log(`[Server] Found matching handler with ${actions.length} actions: ${actions.join(', ')}`);
                    }
                }
            }
            
            if (matchingHandlers.length > 0) {
                return matchingHandlers;
            }
            
            connection.console.warn(`[Server] No matching event handlers found for state=${stateName}, event=${eventName}, guard=${guard || 'none'}`);
            return null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            connection.console.error(`[Server] Error processing getActionInfo: ${errorMessage}`);
            return null;
        }
    });
});

// --- Go to Definition Provider (Single Instance) ---
connection.onDefinition(async (params: TextDocumentPositionParams): Promise<Location | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const position = params.position;
    try {
        const tokens = tokenize(document);
        const parser = new Parser(tokens, document);
        const { model } = parser.parse();

        function findTokenAtPosition(pos: Position): Token | null {
            for (const token of tokens) {
                if (pos.line === token.range.start.line &&
                    pos.character >= token.range.start.character &&
                    pos.character <= token.range.end.character &&
                    token.type === TokenType.TRANSITION) {
                    return token;
                }
            }
            return null;
        }

        const clickedToken = findTokenAtPosition(position);
        if (!clickedToken) return null;

        const targetStateName = clickedToken.text;
        connection.console.log(`[Definition] Clicked on transition target: ${targetStateName}`);

        let sourceStateNode: StateNode | null = null;
        let sourceQualifiedName: string | null = null;

        function findSourceState(nodes: StateNode[], parentQualified: string | null): boolean {
            for (const node of nodes) {
                const currentQualified = parentQualified ? `${parentQualified}.${node.name}` : node.name;
                if (position.line >= node.range.start.line && position.line <= node.fullRange.end.line) {
                    for (const handler of node.eventHandlers) {
                        if (handler.transition && handler.transition.range.start.line === clickedToken!.range.start.line && handler.transition.targetStateName === targetStateName) {
                            sourceStateNode = node;
                            sourceQualifiedName = currentQualified;
                            return true;
                        }
                    }
                    if (node.subStates.length > 0 && findSourceState(node.subStates, currentQualified)) {
                        return true;
                    }
                }
            }
            return false;
        }

        findSourceState(model, null);

        if (!sourceStateNode || !sourceQualifiedName) {
            connection.console.log(`[Definition] Could not determine source state for transition at ${position.line}:${position.character}`);
            return null;
        }
        const confirmedSourceNode = sourceStateNode as StateNode;
        const confirmedSourceQualifiedName = sourceQualifiedName;
        connection.console.log(`[Definition] Source state identified: ${confirmedSourceQualifiedName}`);

        // Create and populate a local map for this request
        const localDefinedStates = new Map<string, { node: StateNode }>();
        function collectStatesForDef(states: StateNode[], parentNode: StateNode | null, parentQualifiedName: string | null) {
            for (const state of states) {
                state.parent = parentNode ?? undefined;
                const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${state.name}` : state.name;
                if (!localDefinedStates.has(qualifiedName)) {
                    localDefinedStates.set(qualifiedName, { node: state });
                }
                if (state.subStates.length > 0) {
                    collectStatesForDef(state.subStates, state, qualifiedName);
                }
            }
        }
        collectStatesForDef(model, null, null);

        let resolvedTargetQualifiedName: string | null = null;

        // Check if target is a direct substate
        if (confirmedSourceNode.subStates.some((sub: StateNode) => sub.name === targetStateName)) {
            resolvedTargetQualifiedName = `${confirmedSourceQualifiedName}.${targetStateName}`;
        }
        // Check if target is a sibling (substate of the parent)
        else {
            const parentNode = confirmedSourceNode.parent;
            if (parentNode) {
                // Find the parent's qualified name from the rebuilt definedStates map
                const parentEntry = Array.from(localDefinedStates.entries()).find(([_, value]) => value.node === parentNode);
                const parentQualifiedName = parentEntry ? parentEntry[0] : null;
                if (parentQualifiedName && parentNode.subStates.some((sub: StateNode) => sub.name === targetStateName)) {
                    resolvedTargetQualifiedName = `${parentQualifiedName}.${targetStateName}`;
                }
            }
        }

        // Check if target is a top-level state
        if (!resolvedTargetQualifiedName && localDefinedStates.has(targetStateName)) {
            resolvedTargetQualifiedName = targetStateName;
        }

        connection.console.log(`[Definition] Resolved target: ${resolvedTargetQualifiedName}`);

        if (resolvedTargetQualifiedName && localDefinedStates.has(resolvedTargetQualifiedName)) {
            const targetStateInfo = localDefinedStates.get(resolvedTargetQualifiedName);
            if (targetStateInfo) {
                connection.console.log(`[Definition] Found definition for ${resolvedTargetQualifiedName} at range: ${JSON.stringify(targetStateInfo.node.range)}`);
                return Location.create(params.textDocument.uri, targetStateInfo.node.range);
            }
        }

        connection.console.log(`[Definition] Could not find definition for resolved target: ${resolvedTargetQualifiedName}`);
        return null;
    } catch (error) {
        connection.console.error(`[Definition] Error: ${error instanceof Error ? error.stack : String(error)}`);
        return null;
    }
});

// --- Find References Provider ---
connection.onReferences(async (params: ReferenceParams): Promise<Location[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }
    const position = params.position;
    const locations: Location[] = [];

    try {
        const tokens = tokenize(document);
        const parser = new Parser(tokens, document);
        const { model } = parser.parse();

        let clickedToken: Token | null = null;
        for (const token of tokens) {
            if (position.line === token.range.start.line &&
                position.character >= token.range.start.character &&
                position.character <= token.range.end.character) {
                clickedToken = token;
                break;
            }
        }

        if (!clickedToken || clickedToken.type !== TokenType.STATE_DECLARATION) {
            connection.console.log(`[References] Not clicking on a state declaration token.`);
            return null;
        }

        const clickedStateName = clickedToken.text;
        connection.console.log(`[References] Clicked on state declaration: ${clickedStateName}`);

        let clickedStateQualifiedName: string | null = null;

        // Create and populate a local map for this request
        const localDefinedStatesRef = new Map<string, { node: StateNode }>();
        function collectStatesForRef(states: StateNode[], parentNode: StateNode | null, parentQualifiedName: string | null) {
            for (const state of states) {
                state.parent = parentNode ?? undefined;
                const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${state.name}` : state.name;
                if (!localDefinedStatesRef.has(qualifiedName)) {
                    localDefinedStatesRef.set(qualifiedName, { node: state });
                }
                if (state.range.start.line === clickedToken!.range.start.line &&
                    state.range.start.character === clickedToken!.range.start.character &&
                    state.name === clickedStateName) {
                    clickedStateQualifiedName = qualifiedName;
                }
                if (state.subStates.length > 0) {
                    collectStatesForRef(state.subStates, state, qualifiedName);
                }
            }
        }
        collectStatesForRef(model, null, null);

        if (!clickedStateQualifiedName) {
            connection.console.log(`[References] Could not determine qualified name for clicked state at ${position.line}:${position.character}`);
            return null;
        }
        connection.console.log(`[References] Qualified name of clicked state: ${clickedStateQualifiedName}`);

        const allTransitions: { sourceNode: StateNode, sourceQualifiedName: string, targetStateName: string, handlerRange: Range }[] = [];
        function collectTransitions(states: StateNode[], parentQualifiedName: string | null) {
            for (const state of states) {
                const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${state.name}` : state.name;
                for (const handler of state.eventHandlers) {
                    if (handler.transition) {
                        allTransitions.push({
                            sourceNode: state,
                            sourceQualifiedName: qualifiedName,
                            targetStateName: handler.transition.targetStateName,
                            handlerRange: handler.range
                        });
                    }
                }
                if (state.subStates.length > 0) {
                    collectTransitions(state.subStates, qualifiedName);
                }
            }
        }
        collectTransitions(model, null);

        for (const transition of allTransitions) {
            let resolvedTargetName: string | null = null;
            const targetName = transition.targetStateName;
            const sourceNode = transition.sourceNode;
            const sourceQualifiedName = transition.sourceQualifiedName;

            if (sourceNode.subStates.some((sub: StateNode) => sub.name === targetName)) {
                resolvedTargetName = `${sourceQualifiedName}.${targetName}`;
            } else if (sourceNode.parent) {
                const parentEntry = Array.from(localDefinedStatesRef.entries()).find(([_, val]) => val.node === sourceNode.parent);
                const parentQualifiedName = parentEntry ? parentEntry[0] : null;
                if (parentQualifiedName && sourceNode.parent.subStates.some((sub: StateNode) => sub.name === targetName)) {
                    resolvedTargetName = `${parentQualifiedName}.${targetName}`;
                }
            }
            if (!resolvedTargetName && localDefinedStatesRef.has(targetName)) {
                resolvedTargetName = targetName;
            }

            if (resolvedTargetName === clickedStateQualifiedName) {
                connection.console.log(`[References] Found reference in state '${transition.sourceQualifiedName}' transition -> ${transition.targetStateName}`);
                locations.push(Location.create(params.textDocument.uri, transition.handlerRange));
            }
        }

        connection.console.log(`[References] Found ${locations.length} references for ${clickedStateQualifiedName}`);
        return locations;

    } catch (error) {
        connection.console.error(`[References] Error: ${error instanceof Error ? error.stack : String(error)}`);
        return null;
    }
});

// --- Debugger Model Transformation (Single Instance) ---
function transformModelForDebugger(model: StateNode[]): StateMachine | null {
    if (!model || model.length === 0) {
        return null;
    }

    const stateMachine: StateMachine = {
        initialState: '',
        states: {}
    };

    // Create and populate a local map for this transformation
    const localDefinedStatesDebug = new Map<string, { node: StateNode }>(); // Keep this map local to the function call
    function collectAllStates(nodes: StateNode[], prefix: string = ''): void {
        for (const node of nodes) {
            const qualifiedName = prefix ? `${prefix}.${node.name}` : node.name;
            localDefinedStatesDebug.set(qualifiedName, { node }); // Populate local map
            if (node.subStates.length > 0) {
                collectAllStates(node.subStates, qualifiedName);
            }
        }
    }
    collectAllStates(model); // Populate the map when transforming

    function processStateNode(node: StateNode, prefix: string = ''): void {
        const qualifiedName = prefix ? `${prefix}.${node.name}` : node.name;

        if (!prefix && !stateMachine.initialState) {
            stateMachine.initialState = qualifiedName;
        }

        const stateData: StateData = {
            name: qualifiedName,
            onEntry: node.onEntryActions.map(a => a.name),
            onExit: node.onExitActions.map(a => a.name),
            transitions: {}
        };

        // Process regular event handlers
        node.eventHandlers.forEach(handler => {
            const transitionsForEvent: StateTransition[] = [];
            
            // Important: extract the actions first - they should always be included
            // whether there's a transition to another state or not
            const hasActions = handler.actions.length > 0;
            const actionsList = handler.actions.map(a => a.name);
            const actionsString = actionsList.join(', ');
            
            if (handler.transition) {
                // Case 1: We have a transition to another state
                let resolvedTargetName = handler.transition.targetStateName;
                const sourceNode = node;
                const sourceQualifiedName = qualifiedName;

                if (sourceNode.subStates.some((sub: StateNode) => sub.name === resolvedTargetName)) {
                    resolvedTargetName = `${sourceQualifiedName}.${resolvedTargetName}`;
                } else if (sourceNode.parent) {
                    const parentEntry = Array.from(localDefinedStatesDebug.entries()).find(([_, val]) => val.node === sourceNode.parent);
                    const parentQualifiedName = parentEntry ? parentEntry[0] : null;
                    if (parentQualifiedName && sourceNode.parent.subStates.some((sub: StateNode) => sub.name === resolvedTargetName)) {
                        resolvedTargetName = `${parentQualifiedName}.${resolvedTargetName}`;
                    }
                }
                if (!localDefinedStatesDebug.has(resolvedTargetName) && localDefinedStatesDebug.has(handler.transition.targetStateName)) {
                    resolvedTargetName = handler.transition.targetStateName;
                }

                // Always include the actions with the transition
                transitionsForEvent.push({
                    target: resolvedTargetName,
                    guard: handler.guard,
                    action: hasActions ? actionsString : undefined
                });
            } else if (hasActions) {
                // Case 2: We only have actions but no transition to another state
                // These are internal transitions that stay in the same state
                transitionsForEvent.push({
                    target: qualifiedName,
                    action: actionsString,
                    guard: handler.guard
                });
            }

            if (transitionsForEvent.length > 0) {
                if (!stateData.transitions[handler.event]) {
                    stateData.transitions[handler.event] = [];
                }
                stateData.transitions[handler.event].push(...transitionsForEvent);
            }
        });

        // Handle Initial pseudo-state after OnEntry is processed
        if (node.initialSubStateName && node.subStates.length > 0) {
            const initialSubState = node.subStates.find(s => s.name === node.initialSubStateName);
            if (initialSubState) {
                const initialTargetQualifiedName = `${qualifiedName}.${node.initialSubStateName}`;
                
                // Create a special internal event that happens automatically after OnEntry
                if (!stateData.transitions['__initialTransition']) {
                    stateData.transitions['__initialTransition'] = [];
                }
                
                stateData.transitions['__initialTransition'].push({
                    target: initialTargetQualifiedName,
                });
                
                connection.console.log(`[Transform] Added automatic initial transition from ${qualifiedName} to ${initialTargetQualifiedName}`);
            }
        }

        stateMachine.states[qualifiedName] = stateData;

        node.subStates.forEach(subState => processStateNode(subState, qualifiedName));
    }

    model.forEach(stateNode => processStateNode(stateNode));
    
    // After processing all states, determine the initial state
    const firstTopLevelState = model[0]?.name || '';
    if (firstTopLevelState) {
        stateMachine.initialState = firstTopLevelState;
        
        // Follow the chain of initial transitions to find the "leaf" initial state
        let currentStateName = firstTopLevelState;
        let depth = 0;  // Safety mechanism to prevent infinite loops
        const maxDepth = 20;
        
        while (depth < maxDepth) {
            const currentState = stateMachine.states[currentStateName];
            if (!currentState) break;
            
            const initialTransitions = currentState.transitions['__initialTransition'];
            if (initialTransitions && initialTransitions.length > 0) {
                currentStateName = initialTransitions[0].target;
                stateMachine.initialState = currentStateName;
                connection.console.log(`[Transform] Following initial transition chain to: ${currentStateName}`);
                depth++;
            } else {
                break;  // No more initial transitions to follow
            }
        }
    }

    if (!stateMachine.initialState || !stateMachine.states[stateMachine.initialState]) {
        console.error(`[Server Transform] Initial state "${stateMachine.initialState}" is invalid or not found after processing.`);
        const firstStateName = Object.keys(stateMachine.states)[0];
        if (firstStateName) {
            console.warn(`[Server Transform] Setting initial state to first available state: "${firstStateName}"`);
            stateMachine.initialState = firstStateName;
        } else {
            console.error("[Server Transform] No states found in the machine. Returning null.");
            return null;
        }
    }

    if (Object.keys(stateMachine.states).length === 0) {
        console.warn("[Server Transform] No states found after processing. Returning null.");
        return null;
    }

    // Log all transitions with their actions for debugging
    for (const stateName of Object.keys(stateMachine.states)) {
        const state = stateMachine.states[stateName];
        for (const eventName of Object.keys(state.transitions)) {
            const transitions = state.transitions[eventName];
            for (const transition of transitions) {
                connection.console.log(`[Transform] Transition: ${stateName} -- ${eventName}${transition.guard ? ` [${transition.guard}]` : ''} --> ${transition.target}${transition.action ? ` (Actions: ${transition.action})` : ''}`);
            }
        }
    }

    return stateMachine;
}

// Helper function to find a StateNode by its qualified name
function findNodeByQualifiedName(model: StateMachineModel, qualifiedName: string): StateNode | null {
    const parts = qualifiedName.split('.');
    let currentNode: StateNode | undefined;
    let currentModel = model;

    for (const part of parts) {
        currentNode = currentModel.find(node => node.name === part);
        if (!currentNode) return null;
        currentModel = currentNode.subStates;
    }
    return currentNode || null;
}

// --- Settings Handling (Single Instance) ---
interface ExampleSettings { maxNumberOfProblems: number; }
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 100 };
let globalSettings: ExampleSettings = defaultSettings;
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    } else {
        globalSettings = <ExampleSettings>(change.settings.stdlLanguageServer || defaultSettings);
    }
    documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
    if (!hasConfigurationCapability) return Promise.resolve(globalSettings);
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({ scopeUri: resource, section: 'stdlLanguageServer' });
        documentSettings.set(resource, result);
    }
    return result;
}

// --- Document Event Handlers (Single Instance) ---
documents.onDidClose(e => { documentSettings.delete(e.document.uri); });

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

// --- Validation Logic (Single Instance) ---
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const settings = await getDocumentSettings(textDocument.uri) || defaultSettings;
    const allDiagnostics: Diagnostic[] = [];

    // Clear definedStates map BEFORE parsing and semantic validation
    const definedStates = new Map<string, { node: StateNode }>();
    console.log("[Validation] Cleared definedStates map.");

    const tokens = tokenize(textDocument);
    tokens.forEach(token => {
        if (token.type === TokenType.UNKNOWN) {
            allDiagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: token.range,
                message: `Unrecognized STDL syntax: "${token.text}"`,
                source: 'stdl-tokenizer'
            });
        }
    });

    const parser = new Parser(tokens, textDocument);
    const { model, diagnostics: parserDiagnostics } = parser.parse();
    allDiagnostics.push(...parserDiagnostics);

    // Pass the cleared map to semantic validation
    const semanticDiagnostics = performSemanticValidation(model, textDocument, definedStates);
    allDiagnostics.push(...semanticDiagnostics);

    const diagnosticsToSend = allDiagnostics.slice(0, settings.maxNumberOfProblems);

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: diagnosticsToSend });
}

// Modify performSemanticValidation to accept and use the map
function performSemanticValidation(model: StateMachineModel, textDocument: TextDocument, statesMap: Map<string, { node: StateNode }>): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const allTransitions: { sourceNode: StateNode, sourceQualifiedName: string, targetStateName: string, range: Range }[] = [];
    // Ensure the map passed in is used and cleared (redundant clear, but safe)
    statesMap.clear();
    console.log("[SemanticValidation] Cleared statesMap at start.");

    function collectStatesAndInitialChecks(states: StateNode[], parentNode: StateNode | null, parentQualifiedName: string | null) {
        for (const state of states) {
            state.parent = parentNode ?? undefined;
            const qualifiedName = parentQualifiedName ? `${parentQualifiedName}.${state.name}` : state.name;

            // Log before checking/adding
            console.log(`[SemanticValidation] Checking state: ${qualifiedName}`);

            if (statesMap.has(qualifiedName)) {
                // Log the duplicate detection
                console.log(`[SemanticValidation] Duplicate detected: ${qualifiedName}`);
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: state.range,
                    message: `Duplicate state definition: "${qualifiedName}"`,
                    source: 'stdl-semantic'
                });
                // Continue checking substates even if parent is duplicate to find all errors
            } else {
                // Log adding the state
                console.log(`[SemanticValidation] Adding state to map: ${qualifiedName}`);
                statesMap.set(qualifiedName, { node: state });
            }

            for (const handler of state.eventHandlers) {
                if (handler.transition) {
                    allTransitions.push({
                        sourceNode: state,
                        sourceQualifiedName: qualifiedName,
                        targetStateName: handler.transition.targetStateName,
                        range: handler.transition.range
                    });
                }
            }

            if (state.initialSubStateName) {
                if (state.subStates.length === 0) {
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: state.initialTransitionRange || state.range,
                        message: `State "${qualifiedName}" defines an 'Initial' pseudo-state but has no substates.`,
                        source: 'stdl-semantic'
                    });
                } else {
                    const targetIsDirectSubstate = state.subStates.some(sub => sub.name === state.initialSubStateName);
                    if (!targetIsDirectSubstate) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Error,
                            range: state.initialTransitionRange || state.range,
                            message: `Initial transition target "${state.initialSubStateName}" is not a direct substate of "${qualifiedName}".`,
                            source: 'stdl-semantic'
                        });
                    }
                }
            }

            if (state.subStates.length > 0) {
                collectStatesAndInitialChecks(state.subStates, state, qualifiedName);
            }
        }
    }

    // Pass the map to the recursive function
    collectStatesAndInitialChecks(model, null, null);

    for (const transition of allTransitions) {
        let resolvedTargetName: string | null = null;
        const targetName = transition.targetStateName;
        const sourceNode = transition.sourceNode;
        const sourceQualifiedName = transition.sourceQualifiedName;

        if (sourceNode.subStates.some((sub: StateNode) => sub.name === targetName)) {
            resolvedTargetName = `${sourceQualifiedName}.${targetName}`;
        } else if (sourceNode.parent) {
            const parentEntry = Array.from(statesMap.entries()).find(([_, val]) => val.node === sourceNode.parent);
            const parentQualifiedName = parentEntry ? parentEntry[0] : null;
            if (parentQualifiedName && sourceNode.parent.subStates.some((sub: StateNode) => sub.name === targetName)) {
                resolvedTargetName = `${parentQualifiedName}.${targetName}`;
            }
        }
        if (!resolvedTargetName && statesMap.has(targetName)) {
            resolvedTargetName = targetName;
        }

        if (!resolvedTargetName || !statesMap.has(resolvedTargetName)) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: transition.range,
                message: `Transition target state "${targetName}" cannot be resolved from state "${sourceQualifiedName}". Looked for ${sourceQualifiedName}.${targetName}, siblings, and top-level states.`,
                source: 'stdl-semantic'
            });
        }
    }

    statesMap.forEach((stateInfo, qualifiedName) => {
        const hasOutgoingTransitions = allTransitions.some(t => t.sourceQualifiedName === qualifiedName);
        const isComposite = stateInfo.node.subStates.length > 0;
        const hasInitial = !!stateInfo.node.initialSubStateName;
        const hasImplicitInitial = isComposite && !hasInitial;

        if (!isComposite && !hasOutgoingTransitions) {
            diagnostics.push({
                severity: DiagnosticSeverity.Hint,
                range: stateInfo.node.range,
                message: `State "${qualifiedName}" is terminal (no outgoing transitions).`,
                source: 'stdl-semantic'
            });
        } else if (hasImplicitInitial && !hasOutgoingTransitions) {
            diagnostics.push({
                severity: DiagnosticSeverity.Information,
                range: stateInfo.node.range,
                message: `Composite state "${qualifiedName}" has no 'Initial' pseudo-state and no direct outgoing transitions, making it terminal at this level.`,
                source: 'stdl-semantic'
            });
        }
    });

    return diagnostics;
}

// --- File Watch (Single Instance) ---
connection.onDidChangeWatchedFiles(_change => {
    connection.console.log('We received a file change event');
});

// --- Start Listening (Single Instance) ---
documents.listen(connection);
connection.listen();

