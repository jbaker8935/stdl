import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { DebugProtocol } from '@vscode/debugprotocol';
import { TerminatedEvent, InitializedEvent, OutputEvent, StoppedEvent, Event, Response } from '@vscode/debugadapter';
import * as path from 'path';
import { Range as LspRange } from 'vscode-languageserver-types'; // Import LSP Range type

// Define interfaces for the data structures
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

interface ActionResponse {
    newState?: string;
    error?: string;
}

interface ExecuteActionResult {
    newState?: string;
    choices?: {
        event: string;
        guard?: string;
        target: string;
        range: LspRange;
    }[];
    error?: string;
    warning?: string;
    targetStateRange?: LspRange; // Ensure this matches the server's definition
}

interface SessionLogEntry {
    timestamp: string;
    type: 'state' | 'event' | 'action' | 'entry' | 'exit' | 'info' | 'error';
    message: string;
    sequence: number; // Add sequence number
}

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let currentStateMachine: StateMachine | null = null;
let currentState: string | null = null;
let client: LanguageClient | null = null;
let sessionLog: SessionLogEntry[] = []; // Array to store all session log entries

// Function to add an entry to the session log
function addLogEntry(type: 'state' | 'event' | 'action' | 'entry' | 'exit' | 'info' | 'error', message: string) {
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);
    const sequence = sessionLog.length; // Get sequence number before adding
    const newEntry: SessionLogEntry = { timestamp, type, message, sequence };
    sessionLog.push(newEntry);

    if (currentPanel) {
        currentPanel.webview.postMessage({
            command: 'addLogEntry',
            entry: newEntry // Send the full entry object including sequence
        });
    }
}

// Function to clear the session log
function clearSessionLog() {
    sessionLog = [];
    if (currentPanel) {
        currentPanel.webview.postMessage({
            command: 'clearLog'
        });
    }
}

export function activateDebugger(context: vscode.ExtensionContext, languageClient: LanguageClient) {
    client = languageClient;

    context.subscriptions.push(
        vscode.commands.registerCommand('stdl.debugStateMachine', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'stdl') {
                vscode.window.showErrorMessage('Open an stdl file first to debug the state machine.');
                return;
            }

            const documentUri = editor.document.uri.toString();
            console.log(`[Debugger] Requesting state machine for: ${documentUri}`);
            
            // Clear the session log when starting a new debug session
            clearSessionLog();
            addLogEntry('info', 'Starting debug session');

            client?.sendRequest<StateMachine>('stdl/getStateMachineModel', { uri: documentUri })
                .then(stateMachine => {
                    console.log('[Debugger] Received state machine:', stateMachine);
                    if (!stateMachine || !stateMachine.states || Object.keys(stateMachine.states).length === 0) {
                        vscode.window.showErrorMessage('Failed to parse the state machine or it is empty.');
                        currentStateMachine = null;
                        currentState = null;
                        addLogEntry('error', 'Failed to parse state machine or it is empty');
                        return;
                    }
                    currentStateMachine = stateMachine;
                    currentState = stateMachine.initialState;
                    console.log(`[Debugger] Initial state set to: ${currentState}`);
                    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Started. Initial state: '${currentState}'`);
                    
                    addLogEntry('info', `Debugger started with initial state: ${currentState}`);
                    addLogEntry('state', `Entered state: ${currentState}`);
                    
                    // Add entry actions for initial state
                    const initialStateData = currentStateMachine.states[currentState];
                    if (initialStateData && initialStateData.onEntry && initialStateData.onEntry.length > 0) {
                        initialStateData.onEntry.forEach(action => {
                            addLogEntry('entry', `OnEntry action: ${action}`);
                        });
                    }

                    createOrShowWebview(context.extensionUri, documentUri);
                    updateWebviewContent();
                })
                .catch(error => {
                    console.error('[Debugger] Error getting state machine:', error);
                    vscode.window.showErrorMessage(`Error getting state machine: ${error.message}`);
                    currentStateMachine = null;
                    currentState = null;
                    addLogEntry('error', `Error loading state machine: ${error.message}`);
                });
        })
    );

    if (currentPanel) {
        currentPanel.onDidDispose(
            () => {
                currentPanel = undefined;
                currentStateMachine = null;
                currentState = null;
                console.log('[Debugger] Webview panel disposed.');
            },
            null,
            context.subscriptions
        );
    }
}

function createOrShowWebview(extensionUri: vscode.Uri, documentUri: string) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'stdlDebugger',
        'stdl State Machine Debugger',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
        }
    );

    currentPanel.webview.onDidReceiveMessage(
        message => {
            console.log('[Extension Host] Received message from webview:', message);
            switch (message.command) {
                case 'actionSelected':
                    const actionName = message.action;
                    const guardText = message.guard; // Get the guard text from the message
                    const currentActionState = currentState;
                    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Action selected: '${actionName}'${guardText ? ` [${guardText}]` : ''} in state '${currentActionState}'`);
                    
                    // Log the event in our session log
                    addLogEntry('event', `Event triggered: ${actionName}${guardText ? ` [${guardText}]` : ''}`);

                    console.log(`[Debugger] Action selected: ${actionName}, Guard: ${guardText}`);
                    if (currentActionState && actionName && client && documentUri) {
                        console.log(`[Debugger] Sending action '${actionName}' with guard '${guardText || 'none'}' for state '${currentActionState}' to server.`);
                        // Include the guard property in the request parameters
                        client.sendRequest<ExecuteActionResult>('stdl/executeAction', {
                            uri: documentUri,
                            currentState: currentActionState,
                            action: actionName,
                            guard: guardText // Pass the guard text to the server
                        })
                        .then(response => {
                            console.log('[Debugger] Received response from server:', response);
                            // The server should now ideally return newState directly if the guard matches
                            if (response && response.newState) {
                                vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Transition: '${currentActionState}' --(${actionName}${guardText ? ` [${guardText}]` : ''})--> '${response.newState}'`);
                                console.log(`[Debugger] Transitioning to new state: ${response.newState}`);
                                
                                // Get the old state data before transitioning
                                const oldStateData = currentStateMachine?.states[currentActionState || ''];
                                
                                // Execute transition actions FIRST, before OnExit actions
                                const transitionsForEvent = oldStateData?.transitions[actionName] || [];
                                let actionLogged = false;
                                
                                // Get actions from the matching transition (with the correct guard condition)
                                transitionsForEvent.forEach((transition) => {
                                    const transitionGuard = transition.guard || '';
                                    const requestedGuard = guardText || '';
                                    
                                    // Log all actions from matching transitions first
                                    if (transitionGuard === requestedGuard) {
                                        actionLogged = true;
                                        
                                        if (transition.action) {
                                            // Split actions by comma and trim each one
                                            const actionNames = transition.action.split(',').map(a => a.trim());
                                            actionNames.forEach(actionName => {
                                                addLogEntry('action', `Action: ${actionName}`);
                                                vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing action: ${actionName}`);
                                            });
                                        }
                                    }
                                });
                                
                                // Only if no actions were logged from transitions (which is unlikely now), try the AST
                                if (!actionLogged) {
                                    findEventHandlersInAST(currentActionState, actionName, guardText || '')
                                        .then(eventHandlers => {
                                            if (eventHandlers && eventHandlers.length > 0) {
                                                eventHandlers.forEach(handler => {
                                                    if (handler && handler.actions) {
                                                        handler.actions.forEach((action: string) => {
                                                            addLogEntry('action', `Action: ${action}`);
                                                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing action: ${action}`);
                                                        });
                                                    }
                                                });
                                            }
                                            
                                            // After actions are logged, handle the OnExit and state transition
                                            continueStateTransition(response.targetStateRange); // Pass range here
                                        })
                                        .catch(error => {
                                            console.error('[Debugger] Error handling event handlers:', error);
                                            // Even if there's an error, continue the state transition
                                            continueStateTransition(response.targetStateRange); // Pass range here
                                        });
                                } else {
                                    // If actions were logged, continue with the state transition immediately
                                    continueStateTransition(response.targetStateRange); // Pass range here
                                }
                                
                                // This function continues the state transition after actions have been processed
                                function continueStateTransition(targetRange?: LspRange) { // Accept range
                                    // THEN log OnExit actions from the current state
                                    if (oldStateData && oldStateData.onExit && oldStateData.onExit.length > 0) {
                                        oldStateData.onExit.forEach((exitAction: string) => {
                                            addLogEntry('exit', `OnExit action: ${exitAction}`);
                                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing OnExit action: ${exitAction}`);
                                        });
                                    }
                                    
                                    // Update state and log state transition - ensure newState is treated as non-null since we checked above
                                    const newState = response.newState as string;
                                    currentState = newState;
                                    addLogEntry('state', `Transitioned to state: ${newState}`);

                                    // Reveal and highlight the new state in the editor
                                    if (targetRange) { // Check if the range was provided
                                        revealStateInEditor(documentUri, targetRange); // Call reveal here
                                    }
                                    
                                    // Log OnEntry actions for the new state
                                    const newStateData = currentStateMachine?.states[newState];
                                    if (newStateData && newStateData.onEntry && newStateData.onEntry.length > 0) {
                                        newStateData.onEntry.forEach((action: string) => {
                                            addLogEntry('entry', `OnEntry action: ${action}`);
                                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing OnEntry action: ${action}`);
                                        });
                                    }

                                    // Check for automatic Initial transition after OnEntry actions
                                    if (newStateData && newStateData.transitions && newStateData.transitions['__initialTransition']) {
                                        const initialTransitions = newStateData.transitions['__initialTransition'];
                                        if (initialTransitions && initialTransitions.length > 0) {
                                            const initialTarget = initialTransitions[0].target;
                                            console.log(`[Debugger] Automatic initial transition from ${newState} to ${initialTarget}`);
                                            
                                            // Automatically apply the initial transition after entering the composite state
                                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Initial transition: '${newState}' --> '${initialTarget}'`);
                                            
                                            // Log the automatic initial transition
                                            addLogEntry('state', `Initial transition to: ${initialTarget}`);
                                            
                                            // Update state to the target of the initial transition
                                            currentState = initialTarget;
                                            
                                            // Log OnEntry actions for the initial state
                                            const initialStateData = currentStateMachine?.states[initialTarget];
                                            if (initialStateData && initialStateData.onEntry && initialStateData.onEntry.length > 0) {
                                                initialStateData.onEntry.forEach((action: string) => {
                                                    addLogEntry('entry', `OnEntry action: ${action}`);
                                                    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing OnEntry action in initial state: ${action}`);
                                                });
                                            }
                                            // TODO: Optionally reveal the initial state as well? Needs its range.
                                        }
                                    }
                                    
                                    updateWebviewContent();
                                }
                            } else if (response && response.choices && response.choices.length > 0) {
                                vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Action '${actionName}' in state '${currentActionState}' resulted in choices (unexpected with guard).`);
                                console.warn('[Debugger] Server returned choices even with guard:', response.choices);
                                vscode.window.showWarningMessage('Action resulted in multiple choices unexpectedly.');
                                addLogEntry('error', 'Action resulted in multiple choices unexpectedly');
                                updateWebviewContent(); // Stay in the same state
                            } else if (response && response.error) {
                                vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Error executing action '${actionName}' in state '${currentActionState}': ${response.error}`);
                                console.error(`[Debugger] Server returned error: ${response.error}`);
                                vscode.window.showErrorMessage(`Error executing action: ${response.error}`);
                                addLogEntry('error', `Error executing action: ${response.error}`);
                            } else {
                                vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Action '${actionName}' in state '${currentActionState}' resulted in no state change.`);
                                console.log('[Debugger] No state change returned from server.');
                                
                                // For actions that don't cause state transitions, log any associated actions
                                const stateData = currentStateMachine?.states[currentActionState];
                                const transitionsForEvent = stateData?.transitions[actionName] || [];
                                let actionFound = false;
                                
                                transitionsForEvent.forEach(transition => {
                                    const transitionGuard = transition.guard || '';
                                    const requestedGuard = guardText || '';
                                    if (transitionGuard === requestedGuard && transition.action && transition.target === currentActionState) {
                                        actionFound = true;
                                        const actions = transition.action.split(',').map(a => a.trim());
                                        actions.forEach(action => {
                                            addLogEntry('action', `Action: ${action}`);
                                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing action: ${action}`);
                                        });
                                    }
                                });
                                
                                if (!actionFound) {
                                    addLogEntry('info', `Action '${actionName}' resulted in no state change`);
                                }
                                
                                updateWebviewContent();
                            }
                        })
                        .catch(error => {
                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Error sending action '${actionName}' to server: ${error.message}`);
                            console.error('[Debugger] Error sending action to server:', error);
                            vscode.window.showErrorMessage(`Error executing action: ${error.message}`);
                            addLogEntry('error', `Error sending action to server: ${error.message}`);
                        });
                    } else {
                        vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Cannot execute action '${actionName}'. Missing state, action, client, or document URI.`);
                        console.warn('[Debugger] Cannot execute action - missing state, action, client, or document URI.');
                        addLogEntry('error', `Cannot execute action '${actionName}'. Missing state, action, client, or document URI.`);
                    }
                    break;
                case 'stopDebugging':
                    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Debugging stopped by user.`);
                    console.log('[Debugger] Stop debugging requested.');
                    addLogEntry('info', 'Debugging stopped by user');
                    if (currentPanel) {
                        currentPanel.dispose();
                    }
                    break;
                case 'clearLog':
                    clearSessionLog();
                    break;
                default:
                    console.warn('[Extension Host] Received unknown command from webview:', message.command);
            }
        },
        undefined,
    );

    currentPanel.onDidDispose(
        () => {
            if (currentState !== null) {
                 vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Debugger panel closed.`);
            }
            currentPanel = undefined;
            currentStateMachine = null;
            currentState = null;
            console.log('[Debugger] Webview panel disposed.');
        },
        null
    );
}

// Function to reveal and highlight a state in the editor
function revealStateInEditor(documentUri: string, range: LspRange) {
    const targetUri = vscode.Uri.parse(documentUri);
    const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === targetUri.toString()
    );

    if (editor) {
        const startPos = new vscode.Position(range.start.line, range.start.character);
        const endPos = new vscode.Position(range.end.line, range.end.character);
        const vscodeRange = new vscode.Range(startPos, endPos);

        // Reveal the range in the center of the viewport
        editor.revealRange(vscodeRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        // Select the range (highlights it) - Select the whole line for better visibility
        const lineStart = new vscode.Position(range.start.line, 0);
        const lineEnd = editor.document.lineAt(range.start.line).range.end; // Select the entire line where the state starts
        editor.selection = new vscode.Selection(lineStart, lineEnd);
        console.log(`[Debugger] Revealed and selected state at range: ${JSON.stringify(range)}`);
    } else {
        console.warn(`[Debugger] Could not find visible editor for URI: ${documentUri}`);
        // Optionally, try opening the document if not visible
        vscode.workspace.openTextDocument(targetUri).then(doc => {
            vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One }).then(newEditor => {
                 const startPos = new vscode.Position(range.start.line, range.start.character);
                 const endPos = new vscode.Position(range.end.line, range.end.character);
                 const vscodeRange = new vscode.Range(startPos, endPos);
                 newEditor.revealRange(vscodeRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                 // Select the whole line here too
                 const lineStart = new vscode.Position(range.start.line, 0);
                 const lineEnd = newEditor.document.lineAt(range.start.line).range.end;
                 newEditor.selection = new vscode.Selection(lineStart, lineEnd);
                 console.log(`[Debugger] Opened, revealed and selected state at range: ${JSON.stringify(range)}`);
            });
        });
    }
}

function updateWebviewContent() {
    if (!currentPanel || !currentStateMachine || !currentState) {
        console.log('[Debugger] Cannot update webview - panel, state machine, or current state missing.');
        return;
    }
    console.log(`[Debugger] Updating webview for state: ${currentState}`);

    const stateData = currentStateMachine.states[currentState];
    if (!stateData) {
        console.error(`[Debugger] Current state '${currentState}' not found in state machine!`);
        vscode.window.showErrorMessage(`Internal error: State '${currentState}' not found.`);
        return;
    }

    console.log('[Debugger] Setting webview HTML.');
    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Displaying state: '${currentState}'`);

    // Remove the entry action logging from here as it's already done during state transitions
    // and initial state setup, which is causing the duplicate logs

    currentPanel.webview.html = getWebviewContent(currentPanel.webview, stateData, currentState);
}

// Helper function to retrieve event handlers and their actions from the AST
async function findEventHandlersInAST(stateName: string, eventName: string, guardText: string): Promise<any[] | null> {
    // Check if client exists
    if (!client) {
        console.log('[Debugger] Language client not available for AST queries.');
        return null;
    }
    
    // Make sure client is ready
    try {
        await Promise.race([
            client.onReady(), 
            new Promise((_, reject) => setTimeout(() => reject(new Error('Client not ready')), 100))
        ]);
    } catch (e) {
        console.log('[Debugger] Language client not running for AST queries.');
        return null;
    }
    
    try {
        // Get current document
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            console.log('[Debugger] No active editor to query AST.');
            return null;
        }
        
        const documentUri = editor.document.uri.toString();
        
        // Create a custom request to get event handler actions from the server
        // This properly extracts actions from the AST without hard-coding
        return client.sendRequest<any[]>('stdl/getActionInfo', {
            uri: documentUri,
            stateName: stateName,
            eventName: eventName,
            guard: guardText
        }).then(result => {
            if (result && result.length > 0) {
                console.log(`[Debugger] Got actions from server for ${stateName}, ${eventName}, ${guardText}:`, result);
                return result;
            } else {
                console.log(`[Debugger] No actions found from server for ${stateName}, ${eventName}, ${guardText}`);
                return null;
            }
        }).catch(err => {
            // If the custom request isn't implemented yet, fall back to scanning the document
            console.log('[Debugger] Server doesn\'t support getActionInfo, falling back to document search');
            
            // Since we can't hard-code actions, we'll scan the active document
            // to find actions associated with this event+guard in this state
            const document = editor.document;
            const text = document.getText();
            const statePattern = new RegExp(`${escapeRegExp(stateName)}\\s*\\n(?:[^\\n]*\\n)*?[\\s\\n]*-\\s*${escapeRegExp(eventName)}\\s*\\[${escapeRegExp(guardText)}\\](?:[^\\n]*\\n)*?(?:[^\\n\\-]*\\/[^\\n]*\\n)+`, 'g');
            
            const matches = text.match(statePattern);
            if (matches && matches.length > 0) {
                const actionRegex = /\/\s*([^\n\/]+)/g;
                const actions: string[] = [];
                
                let actionMatch;
                const matchText = matches[0];
                
                // Extract action lines within the matched block
                while ((actionMatch = actionRegex.exec(matchText)) !== null) {
                    const actionText = actionMatch[1].trim();
                    if (actionText) {
                        actions.push(actionText);
                    }
                }
                
                console.log(`[Debugger] Found ${actions.length} actions by document search:`, actions);
                if (actions.length > 0) {
                    return [{ actions }];
                }
            }
            
            return null;
        });
    } catch (error) {
        console.error('[Debugger] Error finding event handlers in AST:', error);
        return null;
    }
}

// Helper function to escape special characters in a string for use in a RegExp
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWebviewContent(webview: vscode.Webview, stateData: StateData, currentStateName: string): string {
    let actionsHtml = '<h3>Available Actions/Events:</h3><ul>';
    let entryExitHtml = '';

    if (stateData.onEntry && stateData.onEntry.length > 0) {
        entryExitHtml += `<p><strong>On Entry:</strong> ${stateData.onEntry.join(', ')}</p>`;
    }
    if (stateData.onExit && stateData.onExit.length > 0) {
        entryExitHtml += `<p><strong>On Exit:</strong> ${stateData.onExit.join(', ')}</p>`;
    }

    if (stateData.transitions && Object.keys(stateData.transitions).length > 0) {
        for (const eventName of Object.keys(stateData.transitions)) {
            const transitionsForEvent = stateData.transitions[eventName];
            if (transitionsForEvent && transitionsForEvent.length > 0) {
                transitionsForEvent.forEach(transition => {
                    const guardText = transition.guard || ''; // Get guard text, default to empty string
                    const escapedGuardText = guardText.replace(/'/g, "\\'"); // Escape single quotes for JavaScript
                    const guardDisplay = guardText ? ` [${guardText}]` : ''; // Text for display
                    let details = '';
                    if (transition.target === currentStateName && transition.action) {
                        details = ` (Actions: ${transition.action})`;
                    } else {
                        details = ` -> ${transition.target}`;
                    }
                    // Pass both eventName and escapedGuardText to selectAction
                    actionsHtml += `<li><button onclick="selectAction('${eventName}', '${escapedGuardText}')">${eventName}${guardDisplay}</button>${details}</li>`;
                });
            } else {
                actionsHtml += `<li>${eventName} (No defined transitions)</li>`;
            }
        }
    } else {
        actionsHtml += '<li><i>No events defined for this state.</i></li>';
    }
    actionsHtml += '</ul>';

    // Prepare initial log data for injection (now includes sequence)
    const initialLogDataJson = JSON.stringify(sessionLog);

    // Log area HTML - Add Sort Toggle Button
    const logAreaHtml = `
        <div class="log-section">
            <h3>Debug Session Log:</h3>
            <div class="log-controls">
                <button id="sort-toggle" onclick="toggleSortOrder()">Sort: Newest First</button>
                <button onclick="clearLog()">Clear Log</button>
                <button onclick="copyLogToClipboard()">Copy to Clipboard</button>
            </div>
            <div id="log-container">
                <!-- Log entries will be rendered here by JavaScript -->
            </div>
        </div>
    `;

    const stopButtonHtml = `<button class="stop" onclick="stopDebugging()">Stop Debugging</button>`;

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>stdl Debugger</title>
        <style>
            body {
                font-family: var(--vscode-font-family, sans-serif);
                padding: 1em;
                color: var(--vscode-editor-foreground);
                background-color: var(--vscode-editor-background);
                display: flex;
                flex-direction: column;
                height: 97vh;
            }
            h1, h3 {
                color: var(--vscode-textLink-foreground);
            }
            button {
                margin: 0.2em;
                padding: 0.5em 1em;
                cursor: pointer;
                border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border-radius: 4px;
                transition: background-color 0.2s ease;
            }
            button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            .current-state {
                font-weight: bold;
                font-size: 1.3em;
                margin-bottom: 0.8em;
                color: var(--vscode-textLink-activeForeground);
            }
            .state-details {
                margin-bottom: 1.5em;
                padding: 1em;
                border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, #ccc));
                border-radius: 6px;
                background-color: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
            }
            ul {
                list-style: none;
                padding-left: 0;
            }
            li {
                margin-bottom: 0.5em;
                display: flex;
                align-items: center;
            }
            li button {
                 margin-right: 0.5em;
            }
            li span {
                color: var(--vscode-descriptionForeground);
            }
            .log-section {
                margin-top: 1.5em;
                flex-grow: 1;
                display: flex;
                flex-direction: column;
            }
            .log-controls {
                display: flex;
                justify-content: flex-end;
                gap: 0.5em; /* Add some space between buttons */
                margin-bottom: 0.5em;
            }
            #log-container {
                border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, #ccc));
                background-color: var(--vscode-editorWidget-background, var(--vscode-editor-background));
                border-radius: 4px;
                padding: 0.5em;
                overflow-y: auto;
                flex-grow: 1;
                font-family: var(--vscode-editor-font-family, monospace);
                font-size: var(--vscode-editor-font-size, 12px);
                min-height: 200px;
            }
            .log-entry {
                padding: 0.2em;
                border-bottom: 1px solid var(--vscode-editorWidget-border);
                display: flex;
            }
            .log-timestamp {
                color: var(--vscode-descriptionForeground);
                margin-right: 0.5em;
                width: 160px;
                flex-shrink: 0;
            }
            .log-message {
                white-space: pre-wrap;
            }
            .log-state {
                color: var(--vscode-textLink-activeForeground);
                font-weight: bold;
            }
            .log-event {
                color: var(--vscode-symbolIcon-eventForeground, orange);
            }
            .log-action {
                color: var(--vscode-gitDecoration-modifiedResourceForeground, lightblue);
            }
            .log-entry.log-entry, .log-entry.log-exit {
                color: var(--vscode-terminal-ansiGreen, green);
            }
            .log-error {
                color: var(--vscode-errorForeground, red);
            }
            button.stop {
                background-color: var(--vscode-errorForeground);
                color: var(--vscode-button-foreground);
                border: none;
                margin-top: 1em;
                margin-bottom: 1em;
            }
            button.stop:hover {
                opacity: 0.8;
            }
            hr {
                border: none;
                border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, #ccc));
                margin: 1em 0;
            }
            .controls-section {
                margin-top: auto;
            }
        </style>
    </head>
    <body>
        <h1>stdl State Machine Debugger</h1>
        <div class="controls-section">
            ${stopButtonHtml}
        </div>
        <div class="current-state">Current State: ${currentStateName}</div>
        <div class="state-details">
            ${entryExitHtml || '<p><i>No entry/exit actions defined.</i></p>'}
        </div>
        ${actionsHtml}
        ${logAreaHtml}
        <hr>

        <script>
            const vscode = acquireVsCodeApi();

            // Store log entries (including sequence) and sort order locally in the webview
            let webviewLogEntries = []; // Will store { timestamp, type, message, sequence }
            let sortOrder = 'newest'; // 'newest' or 'oldest'

            // Get references to DOM elements
            const logContainer = document.getElementById('log-container');
            const sortToggleButton = document.getElementById('sort-toggle');

            // Function to create a single log entry element
            function createLogElement(entry) {
                const entryElement = document.createElement('div');
                entryElement.className = \`log-entry log-\${entry.type}\`;

                const timestampSpan = document.createElement('span');
                timestampSpan.className = 'log-timestamp';
                timestampSpan.textContent = entry.timestamp;

                const messageSpan = document.createElement('span');
                messageSpan.className = 'log-message';
                messageSpan.textContent = entry.message;

                entryElement.appendChild(timestampSpan);
                entryElement.appendChild(messageSpan);
                return entryElement;
            }

            // Function to render all log entries based on current sort order
            function renderLogEntries() {
                if (!logContainer) return;
                logContainer.innerHTML = ''; // Clear existing entries

                // Sort a copy: Primary key timestamp, Secondary key sequence
                const sortedEntries = [...webviewLogEntries].sort((a, b) => {
                    const dateA = new Date(a.timestamp.replace(' ', 'T') + 'Z');
                    const dateB = new Date(b.timestamp.replace(' ', 'T') + 'Z');
                    const timestampDiff = sortOrder === 'newest' ? dateB - dateA : dateA - dateB;

                    if (timestampDiff !== 0) {
                        return timestampDiff;
                    }
                    // If timestamps are equal, sort by original sequence number (always ascending)
                    return a.sequence - b.sequence;
                });

                sortedEntries.forEach(entry => {
                    logContainer.appendChild(createLogElement(entry));
                });

                // Update button text
                sortToggleButton.textContent = sortOrder === 'newest' ? 'Sort: Newest First' : 'Sort: Oldest First';

                // Scroll to appropriate position
                if (sortOrder === 'newest') {
                    logContainer.scrollTop = 0; // Scroll to top
                } else {
                    logContainer.scrollTop = logContainer.scrollHeight; // Scroll to bottom
                }
            }

            // Function to add a single new log entry to the view
            function addLogEntryToView(entry) { // entry now includes sequence
                if (!logContainer) return;

                // Add to our local store (including sequence)
                webviewLogEntries.push(entry);

                // Create the element
                const entryElement = createLogElement(entry);

                // Add to the DOM based on sort order
                // Note: We don't re-sort the whole list here for performance.
                // We just append/prepend based on the current view order.
                // The full sort happens on initial load and when toggling sort.
                if (sortOrder === 'newest') {
                    logContainer.insertBefore(entryElement, logContainer.firstChild);
                    logContainer.scrollTop = 0; // Scroll to top to see the new entry
                } else {
                    logContainer.appendChild(entryElement);
                    logContainer.scrollTop = logContainer.scrollHeight; // Scroll to bottom
                }
            }

            // Function to clear the log view and local store
            function clearLogView() {
                webviewLogEntries = [];
                if (logContainer) {
                    logContainer.innerHTML = '';
                }
            }

            // Function to toggle sort order and re-render
            function toggleSortOrder() {
                sortOrder = (sortOrder === 'newest' ? 'oldest' : 'newest');
                renderLogEntries(); // Re-render applies the new sort order
            }

            // Function to copy log to clipboard, respecting sort order
            function copyLogToClipboard() {
                if (!logContainer) return;

                // Sort a copy based on the current view order (timestamp primary, sequence secondary)
                 const sortedEntries = [...webviewLogEntries].sort((a, b) => {
                    const dateA = new Date(a.timestamp.replace(' ', 'T') + 'Z');
                    const dateB = new Date(b.timestamp.replace(' ', 'T') + 'Z');
                    const timestampDiff = sortOrder === 'newest' ? dateB - dateA : dateA - dateB;

                    if (timestampDiff !== 0) {
                        return timestampDiff;
                    }
                    return a.sequence - b.sequence; // Secondary sort by sequence
                });

                let logText = '';
                sortedEntries.forEach(entry => {
                    logText += \`\${entry.timestamp} \${entry.message}\\n\`;
                });

                navigator.clipboard.writeText(logText).then(
                    () => console.log('Log copied to clipboard'),
                    err => console.error('Failed to copy log: ', err)
                );

                // Send a message to show the success notification in VS Code
                vscode.postMessage({
                    command: 'logCopied'
                });
            }

            // Function to send clear log command to extension
            function clearLog() {
                vscode.postMessage({
                    command: 'clearLog'
                });
            }

            // Handle messages from the extension
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'addLogEntry':
                        addLogEntryToView(message.entry); // entry includes sequence
                        break;
                    case 'clearLog':
                        clearLogView();
                        break;
                    case 'logCopied':
                         // Optionally show a VS Code notification
                         // vscode.postMessage({ command: 'showInfoMessage', text: 'Log copied!' });
                         break;
                }
            });

            // Initial setup
            try {
                // Load initial log data passed from the extension
                const initialData = ${initialLogDataJson};
                if (Array.isArray(initialData)) {
                    // Ensure sequence numbers are present if loading older data structure (optional robustness)
                    webviewLogEntries = initialData.map((entry, index) => ({
                        ...entry,
                        sequence: entry.sequence !== undefined ? entry.sequence : index
                    }));
                } else {
                     console.error("Failed to parse initial log data:", initialData);
                     webviewLogEntries = [];
                }
            } catch (e) {
                console.error("Error parsing initial log data:", e);
                webviewLogEntries = []; // Fallback to empty log
            }

            // Initial render of the log
            renderLogEntries();


            // Modified selectAction to send both action and guard
            function selectAction(actionName, guardText) {
                // ... existing selectAction code ...
            }

            function stopDebugging() {
                // ... existing stopDebugging code ...
            }
        </script>
    </body>
    </html>`;
}

export function deactivateDebugger() {
    client = null;
    console.log('[Debugger] Deactivated.');
}

export class stdlDebugSession implements vscode.DebugSession, vscode.DebugAdapter {
    private _currentState: string | undefined;
    private _client: LanguageClient;
    private _configurationDone?: () => void;
    private _sendMessage: (message: DebugProtocol.ProtocolMessage) => void;

    readonly id: string = `stdl-debug-session-${Date.now()}`;
    readonly type: string = 'stdl';
    readonly name: string;
    readonly configuration: vscode.DebugConfiguration;
    readonly workspaceFolder: vscode.WorkspaceFolder | undefined;

	private _onDidSendMessage = new vscode.EventEmitter<DebugProtocol.ProtocolMessage>();
	readonly onDidSendMessage: vscode.Event<DebugProtocol.ProtocolMessage> = this._onDidSendMessage.event;

    constructor(
        session: vscode.DebugSession,
        client: LanguageClient
    ) {
        this._client = client;
        this.name = session.name;
        this.configuration = session.configuration;
        this.workspaceFolder = session.workspaceFolder;

        this._sendMessage = (message) => {
            this._onDidSendMessage.fire(message);
        };

        const fileUri = this.configuration.program ? vscode.Uri.file(this.configuration.program) : undefined;
        if (!fileUri) {
             const errorMsg = "No 'program' file specified in launch configuration.";
             vscode.window.showErrorMessage(errorMsg);
             this._sendMessage(new TerminatedEvent());
             console.error(errorMsg);
             return;
        }

        this.initialize(fileUri);
    }

    private async initialize(fileUri: vscode.Uri): Promise<void> {
        try {
            console.log("Debugger: Waiting for client to be ready...");
            await this._client.onReady(); // Wait for the client to be fully ready
            console.log("Debugger: Client is ready.");

            const model = await this._client.sendRequest<StateMachine>('stdl/getStateMachineModel', { uri: fileUri.toString() });
            if (model && model.initialState) {
                this._currentState = model.initialState;
                this._sendMessage(new InitializedEvent());
                this._sendMessage(new Event('stateChange', { state: this._currentState, states: model.states }));
                console.log(`Debugger initialized. Initial state: ${this._currentState}`);
                if (this._configurationDone) {
                    this._configurationDone();
                    this._configurationDone = undefined;
                }
            } else {
                const errorMsg = `Failed to get initial state machine model from server for ${fileUri.fsPath}. Model: ${JSON.stringify(model)}`;
                vscode.window.showErrorMessage(errorMsg);
                this._sendMessage(new OutputEvent(errorMsg + '\n', 'stderr'));
                console.error(`Debugger initialization error: ${errorMsg}`);
                if (this._configurationDone) {
                    this._configurationDone();
                    this._configurationDone = undefined;
                }
                this._sendMessage(new TerminatedEvent());
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Error initializing stdl debugger: ${errorMessage}`);
            this._sendMessage(new OutputEvent(`Initialization error: ${errorMessage}\n`, 'stderr'));
            console.error("Debugger initialization error:", error);
            if (this._configurationDone) {
                this._configurationDone();
                this._configurationDone = undefined;
            }
            this._sendMessage(new TerminatedEvent());
        }
    }

    async handleMessage(message: DebugProtocol.ProtocolMessage): Promise<void> {
        console.log("Debugger received message:", message);

        if (message.type === 'request') {
            const request = message as DebugProtocol.Request;
            switch (request.command) {
                case 'configurationDone':
                    await this.configurationDoneRequest(request as DebugProtocol.ConfigurationDoneRequest);
                    break;
                case 'stackTrace':
                    await this.stackTraceRequest(request as DebugProtocol.StackTraceRequest);
                    break;
                case 'scopes':
                    await this.scopesRequest(request as DebugProtocol.ScopesRequest);
                    break;
                case 'variables':
                     await this.variablesRequest(request as DebugProtocol.VariablesRequest);
                    break;
                case 'disconnect':
                    await this.disconnectRequest(request as DebugProtocol.DisconnectRequest);
                    break;
                 case 'terminate':
                     await this.terminateRequest(request as DebugProtocol.TerminateRequest);
                     break;
                case 'executeAction':
                    await this.handleExecuteAction(request.arguments);
                    break;
                case 'reset':
                     await this.handleReset();
                     break;
                default:
                    console.warn(`Debugger received unknown request command: ${request.command}`);
                     const response: DebugProtocol.Response = {
                         seq: 0,
                         type: 'response',
                         request_seq: request.seq,
                         success: false,
                         command: request.command,
                         message: `Unsupported command: ${request.command}`
                     };
                     this._sendMessage(response);
                    break;
            }
        } else if (message.type === 'event') {
             console.log("Debugger received event:", message);
        }
    }

    private async configurationDoneRequest(request: DebugProtocol.ConfigurationDoneRequest): Promise<void> {
        await new Promise<void>((resolve) => {
            this._configurationDone = resolve;
            if (this._currentState !== undefined) {
                resolve();
                this._configurationDone = undefined;
            }
        });
         const response: DebugProtocol.Response = {
             seq: 0,
             type: 'response',
             request_seq: request.seq,
             success: true,
             command: request.command
         };
         this._sendMessage(response);
    }

    private async stackTraceRequest(request: DebugProtocol.StackTraceRequest): Promise<void> {
        const fileUri = this.configuration.program ? vscode.Uri.file(this.configuration.program) : undefined;
        const response: DebugProtocol.StackTraceResponse = {
             seq: 0,
             type: 'response',
             request_seq: request.seq,
             success: true,
             command: request.command,
             body: {
                 stackFrames: [{
                     id: 1,
                     name: this._currentState || "Initializing...",
                     source: fileUri ? { path: fileUri.fsPath, name: path.basename(fileUri.fsPath) } : undefined,
                     line: 1,
                     column: 1
                 }],
                 totalFrames: 1
             }
         };
         this._sendMessage(response);
    }

    private async scopesRequest(request: DebugProtocol.ScopesRequest): Promise<void> {
         const response: DebugProtocol.ScopesResponse = {
             seq: 0,
             type: 'response',
             request_seq: request.seq,
             success: true,
             command: request.command,
             body: { scopes: [] }
         };
         this._sendMessage(response);
    }

    private async variablesRequest(request: DebugProtocol.VariablesRequest): Promise<void> {
         const response: DebugProtocol.VariablesResponse = {
             seq: 0,
             type: 'response',
             request_seq: request.seq,
             success: true,
             command: request.command,
             body: { variables: [] }
         };
         this._sendMessage(response);
    }

     private async disconnectRequest(request: DebugProtocol.DisconnectRequest): Promise<void> {
         console.log("Disconnect requested.");
         this.dispose();
         const response: DebugProtocol.Response = {
             seq: 0,
             type: 'response',
             request_seq: request.seq,
             success: true,
             command: request.command
         };
         this._sendMessage(response);
         this._sendMessage(new TerminatedEvent());
     }

     private async terminateRequest(request: DebugProtocol.TerminateRequest): Promise<void> {
         console.log("Terminate requested.");
         this.dispose();
         const response: DebugProtocol.Response = {
             seq: 0,
             type: 'response',
             request_seq: request.seq,
             success: true,
             command: request.command
         };
         this._sendMessage(response);
         this._sendMessage(new TerminatedEvent());
     }

    private async handleExecuteAction(args: any): Promise<void> {
        const fileUri = this.configuration.program ? vscode.Uri.file(this.configuration.program) : undefined;
        if (!fileUri) {
             console.error("Cannot execute action: program URI is missing.");
             this._sendMessage(new OutputEvent("Cannot execute action: program URI is missing.\n", 'stderr'));
             return;
        }
        if (!this._currentState) {
            vscode.window.showWarningMessage("Debugger not initialized or no current state.");
             this._sendMessage(new OutputEvent("Warning: Debugger not initialized or no current state.\n", 'console'));
            return;
        }
        try {
            await this._client.onReady(); // Ensure client is ready before sending request

            const result = await this._client.sendRequest<ExecuteActionResult>('stdl/executeAction', {
                uri: fileUri.toString(),
                currentState: this._currentState,
                action: args.action
            });

            console.log("Server response to executeAction:", result);

            if (result.error) {
                vscode.window.showErrorMessage(`Error executing action: ${result.error}`);
                this._sendMessage(new OutputEvent(`Error executing action: ${result.error}\n`, 'stderr'));
            } else if (result.choices && result.choices.length > 0) {
                const choiceMsg = `Action '${args.action}' resulted in multiple choices. Automatic resolution not implemented.`;
                console.warn(choiceMsg, result.choices);
                vscode.window.showWarningMessage(choiceMsg);
                 this._sendMessage(new OutputEvent(choiceMsg + '\n', 'console'));
            } else if (result.newState) {
                if (result.warning) {
                    vscode.window.showWarningMessage(result.warning);
                     this._sendMessage(new OutputEvent(`Warning: ${result.warning}\n`, 'console'));
                }
                this._currentState = result.newState;
                this._sendMessage(new Event('stateChange', { state: this._currentState }));
                console.log(`Debugger state changed directly: ${this._currentState}`);
                this._sendMessage(new StoppedEvent('step', 1));
            } else {
                 if (result.warning) {
                    vscode.window.showWarningMessage(result.warning);
                     this._sendMessage(new OutputEvent(`Warning: ${result.warning}\n`, 'console'));
                } else {
                    vscode.window.showInformationMessage("Action did not result in a state change.");
                     this._sendMessage(new OutputEvent("Action did not result in a state change.\n", 'console'));
                }
                 console.warn("Server response for executeAction didn't change state:", result);
                 this._sendMessage(new StoppedEvent('step', 1));
            }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to send executeAction request: ${errorMsg}`);
            console.error("Failed to send executeAction:", error);
            this._sendMessage(new OutputEvent(`Failed to execute action: ${errorMsg}\n`, 'stderr'));
        }
    }

    private async handleReset(): Promise<void> {
         const fileUri = this.configuration.program ? vscode.Uri.file(this.configuration.program) : undefined;
         if (fileUri) {
             console.log("Resetting debugger state...");
             await this.initialize(fileUri);
             if (this._currentState) {
                 this._sendMessage(new StoppedEvent('entry', 1));
             }
         } else {
             console.error("Cannot reset: program URI is missing.");
             this._sendMessage(new OutputEvent("Cannot reset: program URI is missing.\n", 'stderr'));
         }
     }

    async customRequest(command: string, args?: any): Promise<any> {
        console.warn(`stdlDebugSession: Received unhandled custom request '${command}'.`);
        throw new Error(`Unsupported command: ${command}`);
    }

    async getDebugProtocolBreakpoint(breakpoint: vscode.Breakpoint): Promise<vscode.DebugProtocolBreakpoint | undefined> {
        console.warn("getDebugProtocolBreakpoint not fully implemented. Received vscode.Breakpoint:", breakpoint);
        return undefined;
    }

    public dispose(): void {
        console.log("stdl Debugger session disposed.");
        this._onDidSendMessage.dispose();
    }
}

export class StdlDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

    private client: LanguageClient;

    constructor(client: LanguageClient) {
        this.client = client;
    }

    createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const debugSessionAdapter = new stdlDebugSession(
            session,
            this.client
        );

        return new vscode.DebugAdapterInlineImplementation(debugSessionAdapter);
    }
}