
# Task Control Hub

Custom Obsidian plugin for Neal.

Shows all tasks from your vault in a right-sidebar view with filtering and sorting.

## Features

- Scans all markdown files in the vault for tasks:
  - Lines like `- [ ] Do the thing`
- Parses optional inline metadata:
  - `@created(YYYY-MM-DD)`
  - `@due(YYYY-MM-DD)`
  - `@closed(YYYY-MM-DD)`
  - `@status(Open|In Progress|Complete|Canceled)`
  - `@priority(High|Medium|Low)`
  - `@project([[Some Project Note]])`
  - `@person([[Some Person]])` (repeatable)
- Shows a task hub view with:
  - Filter by Status (All, Open, In Progress, Complete, Canceled)
  - Filter by Priority (All, High, Medium, Low)
  - Sort by Created Date, Due Date, Priority, or Status
- Clicking a task opens the source file at that task line.

## Notes

- This is an early version (0.1.0).
- It currently **reads** `@created` and `@closed` but does not yet auto-write them.
- Status and priority are inferred when missing:
  - No `@status`:
    - `[ ]` → `Open`
    - `[x]` → `Complete`
  - No `@priority` → `Medium` by default.
