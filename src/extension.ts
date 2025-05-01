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

    console.log('STDL extension activation complete.');
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    console.log('STDL extension deactivating.');
    return client.stop();
}