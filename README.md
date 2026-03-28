# Code Courier

Telegram coding bot where users can send tasks from the phone and apply file changes on their own PCs.

Flow:

`Phone -> Telegram bot -> LLM backend -> preview -> approved job -> user's PC companion -> local files`

## Modes

- `inline` - bot applies approved changes on the same machine where the bot runs
- `companion` - each user can pair their own PC and receive approved jobs there

## What works now

- OpenAI-compatible backend support
- DeepSeek is the default model path
- legacy OpenCode adapter
- safe file operations: `write`, `mkdir`, `rename`, `delete`
- preview before apply
- backup + undo
- pairing codes for user PCs
- device list and active device selection
- remote companion polling API

## Bot setup

```bash
npm install
copy .env.example .env
```

Fill `/.env`:

- `TGBOT_API_KEY`
- `TGBOT_ALLOWED_USERS`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_TIMEOUT_MS`
- `AGENT_MODEL`
- `PUBLIC_BASE_URL`

Default model is `deepseek-ai/deepseek-r1`.

`OPENAI_TIMEOUT_MS` defaults to `120000` so the bot does not hang forever if the provider or model stalls.

Your current `/.env` is already filled for `c14.play2go.cloud:20033`.

Important for multi-user mode:

- `APPLY_MODE=companion`
- `API_HOST=0.0.0.0`
- `API_PORT=8787`
- `PUBLIC_BASE_URL` must be reachable by user PCs

## Run bot

```bash
npm start
```

For Pterodactyl, set `JS_FILE=app/index.js`. A ready note is in `pterodactyl.startup.txt`.

## Pair a user PC

1. User sends `/pair` in Telegram
2. Bot returns a short code
3. On that user's PC, prepare env:

```bash
copy companion.env.example .env
```

4. Edit the PC `.env`:
   - `PROJECT_ROOT`
   - `COMPANION_SERVER_URL`
5. Run pairing:

```bash
node app/companion.js pair YOUR_CODE
```

or on Windows:

```bash
start-companion.bat YOUR_CODE
```

6. Save returned token into `COMPANION_TOKEN` in that PC `.env`
7. Start the worker:

```bash
npm run companion
```

## Telegram commands

- `/help` - quick guide and examples
- `/pair` - generate a pairing code for a new PC
- `/devices` - list paired PCs
- `/use <deviceId>` - select active PC
- `/project` - show active project path
- `/project <path>` - set project path for active PC
- `/project <deviceId> <path>` - set project path for a specific PC
- `/jobs` - recent generated jobs
- `/undo` - rollback latest inline apply
- `/presets` - task mode
- `/connect` - checklist for onboarding a new user
- `/myid` - show Telegram ID for whitelist
- `/model ...` - model override

## UX upgrades

- cleaner dashboard on `/start`
- inline quick actions for status, presets, devices, jobs, and pairing
- richer status cards with active PC, health, model, and queue counts
- better device list with one-tap active device switching
- clearer pairing instructions for non-technical users

## Public access note

For real remote users, `PUBLIC_BASE_URL` and `COMPANION_SERVER_URL` must point to a reachable bot API address.
Examples:

- public VPS IP or domain
- reverse proxy with HTTPS
- tunnel like Cloudflare Tunnel or ngrok

If you leave `127.0.0.1`, only the same machine can connect.

## What to send a new user

Give them only this:

- bot username or invite link
- server URL for `COMPANION_SERVER_URL` and `PUBLIC_BASE_URL`
- their own `PROJECT_ROOT` value
- `companion.env.example` as a template

Do not send:

- `TGBOT_API_KEY`
- `OPENAI_API_KEY`
- another user's `COMPANION_TOKEN`

Before they can use the bot, add their Telegram ID to `TGBOT_ALLOWED_USERS`.
They can get it from the new `/myid` command.

## Files

- `app/index.js` - Telegram bot + pairing logic + API server bootstrap
- `app/api-server.js` - pairing and companion job API
- `app/device-store.js` - paired devices and pairing codes
- `app/job-store.js` - generated jobs
- `app/companion.js` - PC worker and pairing CLI
- `app/file-executor.js` - safe local file apply engine

## Safety

- file operations stay inside `PROJECT_ROOT`
- path traversal and absolute paths are blocked
- backups are written to `.bot-backups`
- bot requires `TGBOT_ALLOWED_USERS`

## Limitation right now

Undo is local to the machine that executed the change. For remote companion mode, rollback from Telegram is not yet routed back to the remote PC worker.
