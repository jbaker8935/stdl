# STDL README

VS Code language extension for a simple state machine description language with semantics borrowed liberally from UML State Machines

The language is an easy to use, intentionally limited scope capability to describe simple state machines in text with some syntax and semantic checking in the editor.  The syntax is simple enough to be understood by a non-technical audience.

The editor supports listing references to a state and clicking a transition target to go to the state definition.

The extension also supports a simple debugger to allow walking through the state machine.   Users select from available events,  Actions are logged to a debugger session log.

![screenshot](https://raw.githubusercontent.com/jbaker8935/stdl/refs/heads/master/images/Screenshot.png)


STDL can be output as a mermaid state diagram which can be rendered by installing a mermaid extension.   
![screenshot](https://raw.githubusercontent.com/jbaker8935/stdl/refs/heads/master/images/Screenshot_Mermaid_State.png)

The debug session log can be output as a mermaid sequence diagram.

![screenshot](https://raw.githubusercontent.com/jbaker8935/stdl/refs/heads/master/images/Screenshot_Mermaid_Sequence.png)

Example:
```
State A     // comment
    OnEntry
        / Action A
    OnExit
        / Action B
    - Event A [Guard Condition A]
        / Action C
        / Action D        
        -> State B
    - Event A [Guard Condition B]
        / Action E
        -> State B        
State B
    - Event B
        -> State C
State C
    Initial
        -> Substate D
    Substate D
        - Action F
        -> State A
```
- States are free text names starting with a letter.  With 3 exceptions any line starting with a letter is a state declaration.

- States may be composite and have nested state declarations within them.

- Events within states start with a '-'

- Events have an optional Guard Condition enclosed in brackets.

- Actions within events start with a '/'

- Transitions to a new state start with '->'

States have three special keywords:
* Special events OnEntry and OnExit specify the first and last actions executed when entering and leaving a state.
* Composite States, like State C in the example, have a pseudostate Initial that specifies a transition to the initial substate.  The Initial transition occurs after any OnEntry actions in the composite state.

- Actions and Guard Conditions are free text and have no symantics

There are more examples in the [repository](https://github.com/jbaker8935/stdl).

