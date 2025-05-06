import { StateMachineModel, StateNode } from './server';

/**
 * Generates a Mermaid state diagram string from a given state machine model.
 * Ensures the use of composite state syntax for representing composite states with nested substates.
 * @param model The state machine model to convert into a Mermaid diagram.
 * @returns A string representing the Mermaid state diagram.
 */
export function generateMermaidStateDiagram(model: StateMachineModel): string {
    let diagram = 'stateDiagram-v2\n';
    diagram += '    direction TB\n\n';

    // No aliases needed, using direct state names

    // Helper function to get qualified name for a state considering hierarchy (for internal tracking only)
    function getQualifiedName(node: StateNode, parentQualifiedName: string | null): string {
        return parentQualifiedName ? `${parentQualifiedName}_${node.name}` : node.name;
    }

    // Helper function to resolve target qualified name for transitions
    function resolveTargetQualifiedName(targetName: string, sourceQualifiedName: string, model: StateMachineModel): string {
        // Split the source qualified name to understand the hierarchy
        const sourceParts = sourceQualifiedName.split('_');
        // Check if target is a sibling or in the hierarchy
        let currentPath = sourceParts.slice(0, -1).join('_');
        while (currentPath) {
            const potentialQualifiedName = currentPath + '_' + targetName;
            if (findStateByQualifiedName(potentialQualifiedName, model)) {
                return potentialQualifiedName;
            }
            currentPath = currentPath.split('_').slice(0, -1).join('_');
        }
        // Check if it's a top-level state
        if (findStateByQualifiedName(targetName, model)) {
            return targetName;
        }
        // Check within the source's hierarchy for substates
        const fullPathCheck = sourceQualifiedName + '_' + targetName;
        if (findStateByQualifiedName(fullPathCheck, model)) {
            return fullPathCheck;
        }
        return targetName; // Fallback if not found
    }

    // Helper function to find a state by qualified name
    function findStateByQualifiedName(qualifiedName: string, states: StateNode[]): StateNode | null {
        const parts = qualifiedName.split('_');
        let currentStates = states;
        let currentNode: StateNode | null = null;

        for (const part of parts) {
            currentNode = currentStates.find(s => s.name === part) || null;
            if (!currentNode) return null;
            currentStates = currentNode.subStates;
        }
        return currentNode;
    }

    // Helper function to process state nodes and their substates
    function processStateNode(node: StateNode, indent: string, parentQualifiedName: string | null): string {
        const qualifiedName = getQualifiedName(node, parentQualifiedName);
        let stateDef = '';

        // Define the state with an alias
        const alias = 'st_' + qualifiedName.replace(/\./g, '_').replace(/\s/g, '_');
        if (node.subStates.length > 0) {
            let stateName = node.name;
            if (node.onEntryActions.length > 0 || node.onExitActions.length > 0) {
                stateName += '<hr>';
                stateName += "<div style='text-align: left;'>"
                if (node.onEntryActions.length > 0) {
                    stateName += 'OnEntry:<br>';
                    node.onEntryActions.forEach(action => {
                        // Remove any comments from the action name
                        const cleanActionName = action.name.split('//')[0].trim().replace(/"/g, "'");
                        stateName += `${cleanActionName}<br>`;
                    });
                }
                if (node.onExitActions.length > 0) {
                    stateName += 'OnExit:<br>';
                    node.onExitActions.forEach(action => {
                        // Remove any comments from the action name
                        const cleanActionName = action.name.split('//')[0].trim().replace(/"/g, "'");
                        stateName += `${cleanActionName}<br>`;
                    });
                }
                // Remove the last <br> to avoid extra line break
                stateName = stateName.slice(0, -4);
                stateName += "</div>";
            }
            stateDef += `${indent}state "${stateName}" as ${alias} {\n`;

            // Handle Initial pseudo-state if defined
            if (node.initialSubStateName) {
                const initialSubStateQualifiedName = `${qualifiedName}_${node.initialSubStateName}`;
                const initialSubStateAlias = 'st_' + initialSubStateQualifiedName.replace(/\./g, '_').replace(/\s/g, '_');
                stateDef += `${indent}    [*] --> ${initialSubStateAlias} : Initial\n`;
            }

            // Process substates recursively, defining them fully inside composite state
            node.subStates.forEach(subState => {
                stateDef += processStateNode(subState, indent + '    ', qualifiedName);
            });

            // Close the composite state definition
            stateDef += `${indent}}\n\n`;
        } else {
            let stateNameSimple = node.name;
            if (node.onEntryActions.length > 0 || node.onExitActions.length > 0) {
                stateNameSimple += '<hr>';
                stateNameSimple += "<div style='text-align: left;'>"                
                if (node.onEntryActions.length > 0) {
                    stateNameSimple += 'OnEntry:<br>';
                    node.onEntryActions.forEach(action => {
                        // Remove any comments from the action name
                        const cleanActionName = action.name.split('//')[0].trim().replace(/"/g, "'");
                        stateNameSimple += `${cleanActionName}<br>`;
                    });
                }
                if (node.onExitActions.length > 0) {
                    stateNameSimple += 'OnExit:<br>';
                    node.onExitActions.forEach(action => {
                        // Remove any comments from the action name
                        const cleanActionName = action.name.split('//')[0].trim().replace(/"/g, "'");
                        stateNameSimple += `${cleanActionName}<br>`;
                    });
                }
                // Remove the last <br> to avoid extra line break
                stateNameSimple = stateNameSimple.slice(0, -4);
                stateNameSimple += "</div>";
            }
            stateDef += `${indent}state "${stateNameSimple}" as ${alias}\n`;
            stateDef += `\n`;
        }

        // Substates are already processed inside the composite state block, no need for outside definition

        return stateDef;
    }

    // Helper function to collect transitions separately
    function collectTransitions(node: StateNode, parentQualifiedName: string | null, transitions: string[], model: StateMachineModel): void {
        const qualifiedName = getQualifiedName(node, parentQualifiedName);
        const sourceAlias = 'st_' + qualifiedName.replace(/\./g, '_').replace(/\s/g, '_');

        // Handle transitions (event handlers)
        node.eventHandlers.forEach(handler => {
            if (handler.transition) {
                const targetQualifiedName = resolveTargetQualifiedName(handler.transition.targetStateName, qualifiedName, model);
                const targetAlias = 'st_' + targetQualifiedName.replace(/\./g, '_').replace(/\s/g, '_');
                let transitionLine = `    ${sourceAlias} --> ${targetAlias}: ${handler.event}`;
                if (handler.guard) {
                    transitionLine += ` [${handler.guard}]`;
                }
                if (handler.actions.length > 0) {
                    // Remove any comments from action names and replace double quotes with single quotes
                    const cleanActions = handler.actions.map(a => a.name.split('//')[0].trim().replace(/"/g, "'")).join(', ');
                    transitionLine += ` / ${cleanActions}`;
                }
                transitions.push(transitionLine);
            }
        });

        // Process substates recursively for transitions
        node.subStates.forEach(subState => {
            collectTransitions(subState, qualifiedName, transitions, model);
        });
    }

    // Process top-level states for state definitions
    model.forEach(state => {
        diagram += processStateNode(state, '    ', null);
    });

    // Collect all transitions after defining states to ensure aliases are created
    const transitions: string[] = [];
    model.forEach(state => {
        collectTransitions(state, null, transitions, model);
    });

    // Append all transitions to the diagram
    transitions.forEach(transition => {
        diagram += transition + '\n';
    });

    // Define the initial state transition if available
    if (model.length > 0) {
        const initialAlias = 'st_' + getQualifiedName(model[0], null).replace(/\./g, '_').replace(/\s/g, '_');
        diagram += `    [*] --> ${initialAlias}\n`;
    }

    return diagram;
}