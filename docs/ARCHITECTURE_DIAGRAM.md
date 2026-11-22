# RuleCanvas Architecture & Component Interaction

## System Lifecycle Overview

RuleCanvas is structured around a deterministic decision evaluation engine decoupled from the React 19 presentation layer.

`mermaid
flowchart TD
    Client[React 19 SPA] -->|State Action| Dispatcher[History & State Dispatcher]
    Dispatcher -->|Dirty State| InFlight[In-Flight Save Coordinator]
    InFlight -->|REST API / JSON| Storage[Local JSON File Store]
    Client -->|Evaluation Request| Engine[Deterministic Rule Engine]
    Engine -->|Step-by-Step Trace| StepPlayer[Execution Trace Visualizer]
`

## Key Architectural Principles

1. **Deterministic Evaluation**: Given identical input state and graph topology, rule outcomes are strictly reproducible across platforms.
2. **Non-Destructive Navigation**: Browser back/forward traversals (popstate) check dirty draft state before unloading, reverting via history.go(+1) / history.go(-1) if saves fail.
3. **Decoupled Engine**: The core rule engine runs in Node.js server environments or browser web workers without DOM dependencies.
