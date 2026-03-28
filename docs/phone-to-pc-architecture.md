# Phone-to-PC architecture

## Recommendation

The best setup is a hybrid architecture:

- Telegram bot for chat and approvals from the phone.
- A small local desktop companion app running on the user's PC.
- A provider-agnostic agent backend that returns text plus file operations.
- A local file executor on the PC that applies changes only inside the selected project folder.

## Why not only a site or Telegram Mini App

A website or mini app cannot safely create arbitrary files on a user's PC by itself.
Browser sandboxes do not have direct access to the local filesystem.

They can still be useful for:

- approval UI
- project selection
- change preview
- logs and history

But actual file creation on the PC still needs a local process.

## Best flow

1. User sends a task from Telegram on the phone.
2. Bot sends the task to the agent backend.
3. Backend returns:
   - assistant text
   - structured operations like `write`, `mkdir`, `rename`, `delete`
4. Bot sends preview back to Telegram.
5. User taps apply.
6. Desktop companion receives the approved operations.
7. Local executor validates paths and writes files inside the chosen root folder.
8. Companion returns success, changed files, and undo transaction id.

## Desktop companion responsibilities

- keep a secure local connection to the bot backend
- store device id and local settings
- choose and remember allowed project roots
- preview and apply operations
- create backups and support undo
- never allow path traversal outside project root

## Suggested transport

Preferred order:

1. WebSocket from companion app to backend
2. HTTPS long-polling if WebSocket is unavailable
3. Local-only mode where Telegram bot and companion run on the same PC

The PC app should initiate the connection outbound so users do not need to open ports.

## Suggested stack

- Bot/backend: Node.js
- Desktop companion: Node.js + tray app, or Tauri if you want a native shell later
- Local storage: SQLite
- File apply format: structured operations first, unified diff as optional advanced mode

## Rollout plan

### Phase 1

- remove hard dependency on OpenCode
- introduce `AgentClient`
- keep Telegram bot as the control plane

### Phase 2

- add desktop companion app
- add secure device registration
- add apply, reject, and undo actions

### Phase 3

- add mini app for richer previews
- add multi-project support
- add task queue and resumable jobs

## Rule of thumb

If the goal is "user sits with a phone, files appear on their PC", the correct core is not a website.
It is a small local companion app plus a bot/backend.
