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

                    createOrShowWebview(context.extensionUri, documentUri, context.subscriptions); // Pass subscriptions here
                    updateWebviewContent();
                })
                .catch(error => {
                    console.error('[Debugger] Error getting state machine:', error);
                    vscode.window.showErrorMessage(`Error getting state machine: ${error.message}`);
                    currentStateMachine = null;
                    currentState = null;
                    addLogEntry('error', `Error loading state machine: ${error.message}`);
                });
        }),
        vscode.commands.registerCommand('stdl.showSequenceDiagram', async () => {
            if (sessionLog.length === 0) {
                vscode.window.showInformationMessage('No debug session log available to display sequence diagram.');
                return;
            }

            // Generate Mermaid code for sequence diagram from session log
            let mermaidCode = 'sequenceDiagram\n';
            const participants = new Set<string>();
            // Intermediate structure to hold parsed diagram elements in order
            const elements: {
                index: number;
                type: 'initial' | 'transition' | 'entryNote' | 'exitNote' | 'actionNote';
                state?: string;
                from?: string;
                to?: string;
                event?: string;
                actions?: string[];
                noteText?: string;
            }[] = [];

            let lastStateName: string | null = null;
            let pendingEvent: { name: string; index: number; actions: string[]; onExits: string[] } | null = null;

            // --- First Pass: Parse log into structured elements ---
            for (let i = 0; i < sessionLog.length; i++) {
                const entry = sessionLog[i];
                const messageParts = entry.message.split(': ');
                const messageType = messageParts[0];
                const messageContent = entry.message.substring(messageType.length + 1).trim();

                switch (entry.type) {
                    case 'info':
                        if (messageType === 'Debugger started with initial state') {
                            const initialState = messageContent;
                            participants.add(initialState);
                            elements.push({ index: i, type: 'initial', state: initialState });
                            lastStateName = initialState;
                        }
                        break;
                    case 'state':
                        if (messageType === 'Entered state' && !lastStateName) {
                            const initialState = messageContent;
                            participants.add(initialState);
                            if (!elements.some(el => el.index === i || (el.type === 'initial' && el.state === initialState))) {
                                elements.push({ index: i, type: 'initial', state: initialState });
                            }
                            lastStateName = initialState;
                        } else if (messageType === 'Transitioned to state') {
                            const newState = messageContent;
                            participants.add(newState);
                            if (lastStateName && pendingEvent) {
                                // Attach all collected actions and onExit actions to this transition
                                const allActions = [...pendingEvent.actions, ...pendingEvent.onExits];
                                elements.push({
                                    index: i,
                                    type: 'transition',
                                    from: lastStateName,
                                    to: newState,
                                    event: pendingEvent.name,
                                    actions: allActions
                                });
                                pendingEvent = null;
                            } else if (lastStateName && !pendingEvent) {
                                elements.push({
                                    index: i,
                                    type: 'transition',
                                    from: lastStateName,
                                    to: newState,
                                    event: '[Implicit]',
                                    actions: []
                                });
                                console.warn(`[SequenceDiagram] Transition to ${newState} found without preceding event log. Marked as [Implicit].`);
                            }
                            lastStateName = newState;
                        } else if (messageType === 'Initial transition to') {
                            const newState = messageContent;
                            participants.add(newState);
                            if (lastStateName) {
                                elements.push({
                                    index: i,
                                    type: 'transition',
                                    from: lastStateName,
                                    to: newState,
                                    event: '[Initial]',
                                    actions: []
                                });
                            }
                            lastStateName = newState;
                        }
                        break;
                    case 'event':
                        if (messageType === 'Event triggered') {
                            // Use the full event text (including guard) for the transition label
                            const eventText = messageContent; // Do not strip guard
                            pendingEvent = { name: eventText, index: i, actions: [], onExits: [] };
                        }
                        break;
                    case 'action':
                        if (pendingEvent && messageType === 'Action') {
                            pendingEvent.actions.push(entry.message);
                        } else if (!pendingEvent && lastStateName && messageType === 'Action') {
                            elements.push({ index: i, type: 'actionNote', state: lastStateName, noteText: entry.message });
                        }
                        break;
                    case 'exit':
                        if (pendingEvent && messageType === 'OnExit action') {
                            pendingEvent.onExits.push(entry.message);
                        }
                        break;
                    case 'entry':
                        if (lastStateName && messageType === 'OnEntry action') {
                            elements.push({ index: i, type: 'entryNote', state: lastStateName, noteText: entry.message });
                        }
                        break;
                }
            }

            // --- Second Pass: Generate Mermaid Code ---
            participants.forEach(state => {
                mermaidCode += `    participant '${state}'\n`;
            });

            // Keep track of which entry notes have been added to avoid duplicates
            const addedEntryNotes = new Set<number>(); // Store indices of added notes

            for (let i = 0; i < elements.length; i++) {
                const element = elements[i];

                if (element.type === 'initial' && element.state) {
                    // Find and add initial OnEntry notes immediately following the initial state log entry
                    for (let j = i + 1; j < elements.length; j++) {
                        const nextElement = elements[j];
                        if (nextElement.type === 'transition') {
                            break;
                        }
                        // Do not add OnEntry notes if the note is a comment (starts with '//')
                        if (nextElement.type === 'entryNote' && nextElement.state === element.state && nextElement.noteText && !nextElement.noteText.trim().startsWith('//')) {
                            // Only include the action name before any comment
                            const actionText = nextElement.noteText.split('//')[0].trim();
                            if (actionText) {
                                mermaidCode += `    Note over '${nextElement.state}': ${actionText}\n`;
                                addedEntryNotes.add(nextElement.index);
                            }
                        }
                    }
                } else if (element.type === 'transition' && element.from && element.to && element.event) {
                    // Generate the transition arrow line
                    let transitionLine = `    '${element.from}'->>'${element.to}': ${element.event}`;
                    if (element.actions && element.actions.length > 0) {
                        // Filter out stdl comments and OnExit/OnEntry actions for self-transitions from the label
                        const filteredActions = element.actions.filter(a => {
                            const isComment = a.trim().startsWith('//');
                            const isExitNoteForSelfTransition = element.from === element.to && a.startsWith('OnExit action:');
                            const isEntryNoteForSelfTransition = element.from === element.to && a.startsWith('OnEntry action:');
                            return !isComment && !isExitNoteForSelfTransition && !isEntryNoteForSelfTransition;
                        }).map(a => {
                            // Strip out any inline comments from the action text
                            return a.split('//')[0].trim();
                        }).filter(a => a.length > 0);
                        if (filteredActions.length > 0) {
                            transitionLine += `<br>${filteredActions.join('<br>')}`;
                        }
                    }
                    mermaidCode += transitionLine + '\n';

                    // Only add OnEntry notes if not a self-transition
                    if (element.from !== element.to) {
                        for (let j = i + 1; j < elements.length; j++) {
                            const nextElement = elements[j];
                            if (nextElement.type === 'transition') {
                                break;
                            }
                            // Do not add OnEntry notes if the note is a comment (starts with '//')
                            if (nextElement.type === 'entryNote' && nextElement.state === element.to && nextElement.noteText && !nextElement.noteText.trim().startsWith('//') && !addedEntryNotes.has(nextElement.index)) {
                                const actionText = nextElement.noteText.split('//')[0].trim();
                                if (actionText) {
                                    mermaidCode += `    Note over '${nextElement.state}': ${actionText}\n`;
                                    addedEntryNotes.add(nextElement.index);
                                }
                            }
                        }
                    }
                } else if (element.type === 'actionNote' && element.state && element.noteText && !element.noteText.trim().startsWith('//')) {
                    const actionText = element.noteText.split('//')[0].trim();
                    if (actionText) {
                        mermaidCode += `    Note over '${element.state}': ${actionText}\n`;
                    }
                }
                // Handle entry notes that might not have been added yet (e.g., if they occurred without a preceding transition log)
                else if (element.type === 'entryNote' && element.state && element.noteText && !addedEntryNotes.has(element.index) && !element.noteText.trim().startsWith('//')) {
                    // Do not add entry notes for self-transitions
                    const isSelfTransition = elements.some(e => e.type === 'transition' && e.from === e.to && e.to === element.state);
                    if (!isSelfTransition) {
                        console.warn(`[SequenceDiagram] Adding potentially orphaned entry note: ${element.noteText} for state ${element.state}`);
                        const actionText = element.noteText.split('//')[0].trim();
                        if (actionText) {
                            mermaidCode += `    Note over '${element.state}': ${actionText}\n`;
                            addedEntryNotes.add(element.index);
                        }
                    }
                }
            }

            // Handle cases with no log data or no transitions
            if (elements.length === 0 && participants.size === 0) {
                 mermaidCode += '    Note over System: No debug session log available.\n';
            } else if (elements.filter(e => e.type === 'transition').length === 0) {
                 // Find the initial state from the parsed elements or default
                 const initialStateElement = elements.find(e => e.type === 'initial');
                 const initialStateName = (initialStateElement && typeof initialStateElement.state === 'string')
                     ? initialStateElement.state
                     : (participants.size > 0 && typeof participants.values().next().value === 'string')
                         ? participants.values().next().value as string
                         : 'System';

                 if (!participants.has(initialStateName)) {
                     mermaidCode += `    participant '${initialStateName}'\n`;
                 }
                 // Add initial entry notes if they exist but no transitions happened
                 elements.forEach(el => {
                     if (el.type === 'entryNote' && el.state === initialStateName && el.noteText && !addedEntryNotes.has(el.index)) {
                         const actionText = el.noteText.split('//')[0].trim();
                         if (actionText) {
                             mermaidCode += `    Note over '${el.state}': ${actionText}\n`;
                             addedEntryNotes.add(el.index);
                         }
                     }
                 });
                 mermaidCode += `    Note over '${initialStateName}': No transitions recorded yet.\n`;
            }

            // Create a new text document with Mermaid code
            const document = await vscode.workspace.openTextDocument({
                language: 'mermaid',
                content: mermaidCode
            });
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Beside
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

function createOrShowWebview(extensionUri: vscode.Uri, documentUri: string, subscriptions: vscode.Disposable[]) { // Add subscriptions parameter
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'stdlDebugger',
        'STDL State Machine Debugger',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
        }
    );

    // Register listener and add the returned disposable to the subscriptions array
    subscriptions.push(currentPanel.webview.onDidReceiveMessage(
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
                                    // THEN log OnExit actions from the current state and all parent states
                                    if (currentStateMachine && response.newState && currentActionState) {
                                        const newState = response.newState as string;
                                        // Get the hierarchy of states from current to top
                                        const currentStateHierarchy = getStateHierarchy(currentActionState);
                                        const targetStateHierarchy = getStateHierarchy(newState);
                                        
                                        // Find the common ancestor
                                        let commonAncestor = '';
                                        for (let i = 0; i < Math.min(currentStateHierarchy.length, targetStateHierarchy.length); i++) {
                                            if (currentStateHierarchy[i] !== targetStateHierarchy[i]) {
                                                break;
                                            }
                                            commonAncestor = currentStateHierarchy[i];
                                        }
                                        
                                        // Execute OnExit actions from the deepest state up to the common ancestor
                                        for (let i = 0; i < currentStateHierarchy.length; i++) {
                                            const stateName = currentStateHierarchy[i];
                                            if (commonAncestor && stateName === commonAncestor) {
                                                break; // Stop at the common ancestor
                                            }
                                            const stateData = currentStateMachine.states[stateName];
                                            if (stateData && stateData.onExit && stateData.onExit.length > 0) {
                                                addLogEntry('exit', `OnExit from ${stateName}:`);
                                                stateData.onExit.forEach((exitAction: string) => {
                                                    addLogEntry('exit', `OnExit action: ${exitAction}`);
                                                    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing OnExit action from ${stateName}: ${exitAction}`);
                                                });
                                            }
                                        }
                                        
                                        // Update state and log state transition
                                        currentState = newState;
                                        addLogEntry('state', `Transitioned to state: ${newState}`);

                                        // Reveal and highlight the new state in the editor
                                        if (targetRange) { // Check if the range was provided
                                            revealStateInEditor(documentUri, targetRange); // Call reveal here
                                        }
                                        
                                        // Log OnEntry actions for the new state and its hierarchy down from common ancestor
                                        for (let i = targetStateHierarchy.indexOf(commonAncestor) + 1; i < targetStateHierarchy.length; i++) {
                                            const entryStateName = targetStateHierarchy[i];
                                            const entryStateData = currentStateMachine.states[entryStateName];
                                            if (entryStateData && entryStateData.onEntry && entryStateData.onEntry.length > 0) {
                                                addLogEntry('entry', `OnEntry to ${entryStateName}:`);
                                                entryStateData.onEntry.forEach((action: string) => {
                                                    addLogEntry('entry', `OnEntry action: ${action}`);
                                                    vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing OnEntry action to ${entryStateName}: ${action}`);
                                                });
                                            }
                                        }

                                        // Check for automatic Initial transition after OnEntry actions
                                        const newStateData = currentStateMachine.states[newState];
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
                                                
                                                // Log OnEntry actions for the initial state hierarchy, but only for states not already processed
                                                const initialHierarchy = getStateHierarchy(initialTarget);
                                                const startIdx = targetStateHierarchy.length; // Start after the last state in target hierarchy to avoid duplicates
                                                for (let i = startIdx; i < initialHierarchy.length; i++) {
                                                    const initStateName = initialHierarchy[i];
                                                    const initStateData = currentStateMachine.states[initStateName];
                                                    if (initStateData && initStateData.onEntry && initStateData.onEntry.length > 0) {
                                                        addLogEntry('entry', `OnEntry to ${initStateName}:`);
                                                        initStateData.onEntry.forEach((action: string) => {
                                                            addLogEntry('entry', `OnEntry action: ${action}`);
                                                            vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Executing OnEntry action in initial state ${initStateName}: ${action}`);
                                                        });
                                                    }
                                                }
                                                // TODO: Optionally reveal the initial state as well? Needs its range.
                                            }
                                        }
                                        
                                        updateWebviewContent();
                                    }
                                }
                                
                                // Helper function to get the hierarchy of states from a qualified state name
                                function getStateHierarchy(stateName: string): string[] {
                                    const parts = stateName.split('.');
                                    const hierarchy: string[] = [];
                                    for (let i = 0; i < parts.length; i++) {
                                        const parentName = parts.slice(0, i + 1).join('.');
                                        hierarchy.push(parentName);
                                    }
                                    return hierarchy;
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
                case 'generateSequenceDiagram':
                    console.log('[Debugger] Generate Sequence Diagram requested from webview.');
                    vscode.commands.executeCommand('stdl.showSequenceDiagram');
                    break;
                default:
                    console.warn('[Extension Host] Received unknown command from webview:', message.command);
            }
        },
        undefined // thisArg remains undefined
    ));

    // Register listener and add the returned disposable to the subscriptions array
    subscriptions.push(currentPanel.onDidDispose(
        () => {
            if (currentState !== null) {
                 vscode.debug.activeDebugConsole.appendLine(`[stdl Debugger] Debugger panel closed.`);
            }
            currentPanel = undefined;
            currentStateMachine = null;
            currentState = null;
            console.log('[Debugger] Webview panel disposed.');
        },
        null // thisArg remains null
    ));
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
        for (const event in stateData.transitions) {
            if (event === '__initialTransition') continue; // Skip internal initial transition
            stateData.transitions[event].forEach(transition => {
                const guardText = transition.guard ? ` [${transition.guard}]` : '';
                const actionText = transition.action ? ` / ${transition.action}` : '';
                // When parsing transitions, ignore comments after the target state
                // (This is handled in the state machine model/server, but if parsing is needed here, strip after '->' and before '//')
                actionsHtml += `<li><button data-event="${event}" data-guard="${transition.guard || ''}" onclick="selectAction(this.dataset.event, this.dataset.guard)">${event}${guardText}</button> -> ${transition.target}${actionText}</li>`;
            });
        }
    } else {
        actionsHtml += '<li>No outgoing transitions defined for this state.</li>';
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
                <button onclick="generateSequenceDiagram()">Generate Sequence Diagram</button>
            </div>
            <div id="log-container">
                <!-- Log entries will be rendered here by JavaScript -->
            </div>
        </div>
    `;

    const stopButtonHtml = `<button class="stop" onclick="stopDebugging()">Stop Debugging</button>`;

    // Construct the full HTML content
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>STDL Debugger</title>
    <style>
        body {
            font-family: var(--vscode-font-family, sans-serif);
            padding: 1em;
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
        }
        h2, h3 {
            margin-top: 1em;
            margin-bottom: 0.5em;
            color: var(--vscode-editor-foreground, #d4d4d4);
        }
        ul {
            list-style: none;
            padding-left: 0;
        }
        li {
            margin-bottom: 0.5em;
        }
        button {
            padding: 0.5em 1em;
            margin-right: 0.5em;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border, #444);
            border-radius: 4px;
            background-color: var(--vscode-button-background, #2d2d2d);
            color: var(--vscode-button-foreground, #d4d4d4);
            transition: background 0.2s, color 0.2s;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground, #37373d);
            color: var(--vscode-button-foreground, #fff);
        }
        .stop {
            background-color: var(--vscode-editorError-foreground, #f44336);
            color: #fff;
            border: none;
        }
        .stop:hover {
            background-color: #da190b;
        }
        .log-section {
            margin-top: 2em;
            border-top: 1px solid var(--vscode-panel-border, #333);
            padding-top: 1em;
        }
        #log-container {
            max-height: 300px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border, #333);
            padding: 0.5em;
            background-color: var(--vscode-editorWidget-background, #232323);
            font-family: var(--vscode-editor-font-family, monospace);
            white-space: pre-wrap;
            color: var(--vscode-editor-foreground, #d4d4d4);
        }
        .log-entry {
            margin-bottom: 0.3em;
            padding-bottom: 0.3em;
            border-bottom: 1px dotted var(--vscode-panel-border, #444);
        }
        .log-entry:last-child {
            border-bottom: none;
        }
        .log-timestamp {
            color: var(--vscode-editorLineNumber-foreground, #888);
            margin-right: 0.5em;
        }
        .log-type-state {
            color: var(--vscode-charts-blue, #4FC3F7);
            font-weight: bold;
        }
        .log-type-event {
            color: var(--vscode-charts-green, #81C784);
            font-weight: bold;
            background: rgba(129,199,132,0.08);
            border-radius: 3px;
            padding: 0 2px;
        }
        .log-type-action {
            color: var(--vscode-charts-purple, #BA68C8);
        }
        .log-type-entry {
            color: var(--vscode-charts-cyan, #26C6DA);
        }
        .log-type-exit {
            color: var(--vscode-charts-orange, #FFB74D);
        }
        .log-type-info {
            color: var(--vscode-editorInfo-foreground, #82aaff);
        }
        .log-type-error {
            color: var(--vscode-editorError-foreground, #f44336);
            font-weight: bold;
        }
        .log-controls {
            margin-bottom: 1em;
        }
    </style>
</head>
<body>
    <h2>Current State: ${currentStateName}</h2>
    ${entryExitHtml}
    ${actionsHtml}
    ${stopButtonHtml}
    ${logAreaHtml}

    <script>
        const vscode = acquireVsCodeApi();
        let logEntries = ${initialLogDataJson}; // Initial log data
        let sortOrder = 'newest'; // 'newest' or 'oldest'

        function selectAction(event, guard) {
            vscode.postMessage({ command: 'actionSelected', action: event, guard: guard });
        }

        function stopDebugging() {
            vscode.postMessage({ command: 'stopDebugging' });
        }

        function clearLog() {
            vscode.postMessage({ command: 'clearLog' });
            logEntries = []; // Clear local log data
            renderLog(); // Re-render empty log
        }

        function copyLogToClipboard() {
            const logText = logEntries.map(entry => \`\${entry.timestamp} | \${entry.message}\`).join('\\n');
            navigator.clipboard.writeText(logText).then(() => {
                // Optional: Show feedback to the user
                console.log('Log copied to clipboard');
            }).catch(err => {
                console.error('Failed to copy log:', err);
            });
        }

        function generateSequenceDiagram() {
             vscode.postMessage({ command: 'generateSequenceDiagram' });
        }

        function toggleSortOrder() {
            sortOrder = (sortOrder === 'newest') ? 'oldest' : 'newest';
            const button = document.getElementById('sort-toggle');
            button.textContent = \`Sort: \${sortOrder === 'newest' ? 'Newest First' : 'Oldest First'}\`;
            renderLog();
        }

        function renderLog() {
            const container = document.getElementById('log-container');
            container.innerHTML = ''; // Clear existing logs

            const sortedEntries = [...logEntries]; // Create a copy to sort
            if (sortOrder === 'newest') {
                sortedEntries.sort((a, b) => b.sequence - a.sequence); // Sort by sequence descending
            } else {
                sortedEntries.sort((a, b) => a.sequence - b.sequence); // Sort by sequence ascending
            }

            sortedEntries.forEach(entry => {
                const div = document.createElement('div');
                div.classList.add('log-entry');
                div.classList.add(\`log-type-\${entry.type}\`); // Add type-specific class

                const timestampSpan = document.createElement('span');
                timestampSpan.classList.add('log-timestamp');
                timestampSpan.textContent = entry.timestamp;

                const messageSpan = document.createElement('span');
                messageSpan.textContent = entry.message;

                div.appendChild(timestampSpan);
                div.appendChild(messageSpan);
                container.appendChild(div);
            });

            // Scroll to bottom if sorted newest first
            if (sortOrder === 'newest') {
                container.scrollTop = container.scrollHeight;
            } else {
                 container.scrollTop = 0; // Scroll to top if sorted oldest first
            }
        }

        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'addLogEntry':
                    logEntries.push(message.entry);
                    renderLog(); // Re-render log with the new entry
                    break;
                case 'clearLog':
                    logEntries = [];
                    renderLog();
                    break;
                // Add other message handlers if needed
            }
        });

        // Initial render of the log
        renderLog();

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