# stdl README

VS Code language extension for a simple state machine description language with symantics borrowed liberally from UML State Machines

The intent is to provide an easy to use, limited scope, capability to describe simple state machines in text with some syntax and symantic checking.  The syntax is simple enough to be understood by a non-technical audience.


The extension also supports a simple debugger to allow walking through the state machine.   Users select from available events,  Actions are logged to a debugger session log.

Syntax:   Indention is required as shown.
```
State A
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

Actions and Guard Conditions are free text and have no symantics
Special events OnEntry and OnExit specify the first and last actions executed when entering and leaving a state.
Composite States, like State C in the example, have a pseudostate Initial that specifies a transition to the initial substate.  The Initial transition occurs after any OnEntry actions in the composite state.




