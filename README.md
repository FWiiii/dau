# X Media to Telegram (Saved Messages)

Daily sync service that fetches media from specified public X users and uploads to Telegram Saved Messages.

## Features

- Incremental sync and batched full-history backfill
- Permanent dedupe using `sha256(tweet_id + media_url)`
- Group upload by tweet (auto chunk per 10 media files)
- SQLite state (`/data/state.sqlite`) with job locking
- Failure and run reports sent to Saved Messages
- Designed for Zeabur Cron deployment
- Backfill stops once `backfill_done=true` and keeps incremental-only mode

## Commands

- `pnpm build`
- `pnpm sync:run`
- `pnpm sync:daemon`
- `pnpm auth:telegram`
- `pnpm health:check`
- `pnpm cookies:check`
- `pnpm test`

If your platform forces `node index.js` as start command, this repo includes `/index.js`.
- default mode: run once (`sync:run`)
- daemon mode: set `APP_MODE=daemon` to run daily scheduler (`sync:daemon`)

## Environment Variables

See `.env.example`.

The CLI auto-loads `.env` from project root via `dotenv`, so local runs do not require manual `export` commands.

- `TWITTER_USERS`: comma-separated usernames
- `TWITTER_COOKIES_JSON`: JSON array of cookies (string or object)
- `TWITTER_WEB_BEARER_TOKEN`: optional override for X web bearer token
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_STRING_SESSION`
- `APP_MODE=daemon` (Zeabur recommended if no cron UI)
- `SYNC_DAILY_AT=09:00`
- `SCHEDULER_TICK_SECONDS=30`
- `SCHEDULER_RUN_ON_START=false`
- `TZ=Asia/Shanghai`
- `STATE_DB_PATH=/data/state.sqlite`
- `BACKFILL_PAGES_PER_RUN=10`
- `MAX_MEDIA_PER_RUN=300`
- `DOWNLOAD_TMP_DIR=/tmp/work`

Quick validate cookies format before health check:

```bash
pnpm cookies:check
```

`cookies:check` validates both static format and runtime auth (Twitter GraphQL auth probe).

## Telegram Auth Bootstrap

Run locally:

```bash
pnpm build
pnpm auth:telegram
```

After interactive login, copy printed string into `TELEGRAM_STRING_SESSION`.

## Zeabur Deployment

1. Create Node service in Zeabur.
2. Mount persistent volume to `/data`.
3. Add all env vars from `.env.example`.
4. Build command: `pnpm install && pnpm build`.
5. Start command:
   - Preferred: `pnpm sync:run`
   - If immutable default only: `node index.js` (already supported)
6. If Zeabur has no cron UI, run as daemon mode:
   - set `APP_MODE=daemon`
   - set `SYNC_DAILY_AT=09:00`
   - set `TZ=Asia/Shanghai`
7. Keep replicas at 1 and mount `/data` volume.
8. Trigger one manual run (`pnpm sync:run`) to verify connectivity.

## Notes

- This project uses non-official X scraping via cookies. Keep cookies fresh.
- Twitter GraphQL query IDs/features can change if X updates internal APIs.
- Files are deleted locally after successful upload (or oversize skip handling).
