import * as path from 'path';
import * as vscode from 'vscode';
import { StdlDebugAdapterFactory, activateDebugger } from './debugger'; // Import activateDebugger
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';
// Import DebugProtocol types if needed by debugger.ts
import { DebugProtocol } from '@vscode/debugprotocol';

import { Range } from 'vscode-languageclient/node';

// Define minimal interfaces for StateMachine data from server
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

let client: LanguageClient;

export async function activate(context: vscode.ExtensionContext) { // Make activate async
    console.log('STDL extension activating.');

    // Server options
    const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    // Client options
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'stdl' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.stdl')
        }
    };

    // Create the language client
    client = new LanguageClient('stdlLanguageServer', 'STDL Language Server', serverOptions, clientOptions);

    try {
        // Start the client and wait for it to be ready
        console.log('Starting STDL Language Client...');
        await client.start(); // Explicitly await start
        console.log('STDL Language Client started successfully.');

        // Register the debug adapter factory *after* the client has started
        context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('stdl', new StdlDebugAdapterFactory(client)));
        console.log('STDL Debug Adapter Factory registered.');

        // Activate the webview debugger command *after* the client has started
        activateDebugger(context, client);
        console.log('STDL Webview Debugger command registered.');

    } catch (error) {
        console.error('Failed to start STDL Language Client or register Debug Adapter:', error);
        vscode.window.showErrorMessage('Failed to activate STDL extension. See console for details.');
    }

    // Register the showStateDiagram command
    context.subscriptions.push(vscode.commands.registerCommand('stdl.showStateDiagram', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'stdl') {
            vscode.window.showErrorMessage('Please open an STDL file to view the state diagram.');
            return;
        }

        const uri = editor.document.uri.toString();
        try {
            const stateMachine = await client.sendRequest<StateMachine>('stdl/getStateMachineModel', { uri });
            if (!stateMachine || !stateMachine.states || Object.keys(stateMachine.states).length === 0) {
                vscode.window.showErrorMessage('No state machine data available to display.');
                return;
            }

            // Generate Mermaid code for the state diagram
            let mermaidCode = '---\nconfig:\n    layout: elk\n---\n';
            mermaidCode += 'stateDiagram-v2\n';
            mermaidCode += '    direction TB\n'; // Top to Bottom layout
            for (const stateName in stateMachine.states) {
                const state = stateMachine.states[stateName];
                mermaidCode += `    state "${stateName}" as ${stateName.replace(/\./g, '_')}\n`;
                for (const event in state.transitions) {
                    if (event === '__initialTransition') continue; // Skip internal initial transitions for diagram
                    state.transitions[event].forEach((transition: StateTransition) => {
                        const target = transition.target.replace(/\./g, '_');
                        const source = stateName.replace(/\./g, '_');
                        let label = event;
                        if (transition.guard) {
                            label += ` [${transition.guard}]`;
                        }
                        if (transition.action) {
                            label += ` / ${transition.action}`;
                        }
                        mermaidCode += `    ${source} --> ${target}: ${label}\n`;
                    });
                }
            }
            // Handle initial state
            if (stateMachine.initialState) {
                const initial = stateMachine.initialState.replace(/\./g, '_');
                mermaidCode += `    [*] --> ${initial}\n`;
            }

            // Create a new text document with Mermaid code
            const document = await vscode.workspace.openTextDocument({
                language: 'mermaid',
                content: mermaidCode
            });
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Beside
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load state diagram: ${errorMessage}`);
        }
    }));

    // Register context menu item for .stdl files
    context.subscriptions.push(vscode.commands.registerCommand('stdl.showStateDiagramContext', async (uri: vscode.Uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No file selected to view the state diagram.');
            return;
        }

        try {
            const stateMachine = await client.sendRequest<StateMachine>('stdl/getStateMachineModel', { uri: uri.toString() });
            if (!stateMachine || !stateMachine.states || Object.keys(stateMachine.states).length === 0) {
                vscode.window.showErrorMessage('No state machine data available to display.');
                return;
            }

            // Generate Mermaid code for the state diagram
            let mermaidCode = '---\nconfig:\n    layout: elk\n---\n';
            mermaidCode += 'stateDiagram-v2\n';
            mermaidCode += '    direction TB\n'; // Top to Bottom layout
            for (const stateName in stateMachine.states) {
                const state = stateMachine.states[stateName];
                mermaidCode += `    state "${stateName}" as ${stateName.replace(/\./g, '_')}\n`;
                for (const event in state.transitions) {
                    if (event === '__initialTransition') continue; // Skip internal initial transitions for diagram
                    state.transitions[event].forEach((transition: StateTransition) => {
                        const target = transition.target.replace(/\./g, '_');
                        const source = stateName.replace(/\./g, '_');
                        let label = event;
                        if (transition.guard) {
                            label += ` [${transition.guard}]`;
                        }
                        if (transition.action) {
                            label += ` / ${transition.action}`;
                        }
                        mermaidCode += `    ${source} --> ${target}: ${label}\n`;
                    });
                }
            }
            // Handle initial state
            if (stateMachine.initialState) {
                const initial = stateMachine.initialState.replace(/\./g, '_');
                mermaidCode += `    [*] --> ${initial}\n`;
            }

            // Create a new text document with Mermaid code
            const document = await vscode.workspace.openTextDocument({
                language: 'mermaid',
                content: mermaidCode
            });
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Beside
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to load state diagram: ${errorMessage}`);
        }
    }));

    // Note: Context menu items for .stdl files should be defined in package.json under contributes.menus
    // The command 'stdl.showStateDiagramContext' is registered above and can be used in package.json as follows:
    // "contributes": {
    //   "menus": {
    //     "explorer/context": [
    //       {
    //         "command": "stdl.showStateDiagramContext",
    //         "title": "Show State Diagram (Mermaid)",
    //         "when": "resourceLangId == stdl"
    //       }
    //     ]
    //   }
    // }
    console.log('Context menu command for .stdl files to show state diagram is ready. Update package.json to include it in the context menu.');

    console.log('STDL extension activation complete.');
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    console.log('STDL extension deactivating.');
    return client.stop();
}