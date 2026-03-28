# Pterodactyl Quick Deploy

## 1. Upload files

Upload the whole project to the server root.

## 2. Startup setting

Set `JS_FILE=app/index.js`

If the panel uses a raw startup command, use:

```text
/usr/local/bin/node /home/container/app/index.js
```

## 3. Env file

Use `.env` as the server config file.

Your current `.env` is already prepared for your host:

```env
API_PORT=20033
PUBLIC_BASE_URL=http://c14.play2go.cloud:20033
COMPANION_SERVER_URL=http://c14.play2go.cloud:20033
```

## 4. Required panel/network settings

- Make sure port `20033` is the same public port your panel gives this server
- Keep `API_HOST=0.0.0.0`

## 5. First start check

After start, the console should not show `TGBOT_ALLOWED_USERS is required for safety`.

Expected startup lines include:

- `Code Courier started`
- `API server: 0.0.0.0:20033`

## 6. Pairing flow

1. In Telegram send `/pair`
2. On the user PC copy `companion.env.example` to `.env`
3. Put your public server URL into `COMPANION_SERVER_URL`
4. Run:

```text
start-companion.bat CODE
```

5. Save returned token into `COMPANION_TOKEN`
6. Start companion normally

## 7. Important

If you leave `127.0.0.1`, remote user PCs will not connect.
