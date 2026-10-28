# GRIDLINE Studio — Cloudflare Free Edition

**A converted version of the GRIDLINE Studio 0.8 application** for Cloudflare Workers, D1 database, and SQLite-backed Durable Object WebSocket notifications.

This is an actual conversion, not a proposed architecture. It retains the original browser interface, templates, edit tools, board, host commands, player join form, scoreboard, and quiz-engine rules. The Worker API is adapted for D1, while the WebSocket room broadcasts state revision hints to connected players. The correct answers remain hidden from unauthenticated/public session snapshots until reveal.

**Important:** The source passes Node-based API and game-engine tests. Live `wrangler dev` and real Cloudflare deployment could **not** be exercised in the creation environment because its npm registry access is blocked. Final deployment and testing on your Cloudflare account remain necessary. There is no claim that this is a production-security-audited application.

## What you need

- An eligible **adult-managed Cloudflare account** on Workers Free. The ordinary Free developer plan usually requires no bank card, but Cloudflare may impose regional or risk-based verification; **do not attempt to bypass any eligibility or verification**.
- Windows 10/11 or macOS/Linux with internet and Node.js 22.13+ (Node 24 LTS is recommended).
- No GitHub repository, paid domain, private VPS, ngrok or always-on laptop is required after publishing.
- A modern browser for hosting and friends' phones for joining.

## Deploy from Windows — exact steps

### 1. Unzip and open a terminal

Extract **GRIDLINE-Cloudflare-v1.0.zip** and open the extracted `GRIDLINE-Cloudflare` folder containing `package.json`. In Windows File Explorer's address bar type `cmd` then press Enter.

Verify Node.js:

```bat
node -v
```

If not found, install Node.js LTS from https://nodejs.org and reopen the terminal.

### 2. Install the free Cloudflare deployment tool

```bat
npm install
```

This downloads **Wrangler** as a project development dependency. Unlike the original locally hosted ZIP, this Cloudflare edition does require internet during installation.

### 3. Log in to your Cloudflare account

```bat
npx wrangler login
```

An authorization page opens. Sign in to the **eligible adult account owner's Cloudflare account** and authorize Wrangler. Never share the login token or account details.

### 4. Create your *persistent* Cloudflare D1 database

```bat
npx wrangler d1 create gridline-cloud
```

Wrangler prints a **database_id**, a UUID looking like `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`. Copy **your own actual database ID**.

In `wrangler.jsonc` replace ONLY the string:

```json
"database_id": "00000000-0000-0000-0000-000000000000"
```

with your real ID; do not change `binding: DB` or `database_name: gridline-cloud`.

Tip: Open `wrangler.jsonc` in Notepad; press Ctrl+S to save it. The actual UUID is not a password, but do not share your Cloudflare API tokens.

### 5. Create the remote database tables

```bat
npx wrangler d1 migrations apply gridline-cloud --remote
```

Confirm when asked. The migration makes tables for host accounts, games, sessions, players, scoring history, preferences and themes. Without this step, the website cannot save games.

### 6. Deploy the entire website + API + game rooms

```bat
npm run deploy
```

If asked to register a `workers.dev` subdomain, follow the Cloudflare prompt for the eligible account. Deployment should print the resulting HTTPS URL, for example:

```text
https://gridline-studio-cloud.YOUR-SUBDOMAIN.workers.dev
```

**The above is an example, not your assigned link.** Use the actual URL printed by Wrangler.

### 7. Play with friends

Open the deployed HTTPS URL. Click **Launch Studio**, create a host login (new cloud account; local credentials cannot migrate automatically), create a quiz and launch it. Use **Copy Join Link** and send the link to friends. Friends can choose a team, join and buzz without creating host accounts.

To confirm the multiplayer actually works, open two different devices/browsers, select a question as host, open buzzing and have a friend press BUZZ. Check the updated score from both devices.

### 8. Move existing quizzes from your laptop

The old Node/SQLite data is **not** contained in this converted ZIP. Your new D1 database starts empty. On your original local GRIDLINE website, export games as JSON, then open the cloud GRIDLINE Studio and **Import** the JSON quiz. This migrates questions, categories and settings, not past account credentials or completed sessions. Never upload `data/gridline.sqlite` or authentication databases to a public repository.

## Optional: run locally before deploying

After configuring `wrangler.jsonc`, you may run:

```bat
npx wrangler d1 migrations apply gridline-cloud --local
npm run dev
```

Open the local address Wrangler prints, typically `http://localhost:8787` (not 4173). The local D1 database is separate from the remote D1 database. Node browser previews require Wrangler; running `npm run dev` in the original ZIP still starts the original Node server.

## Saving, keeping live, and backups

- **Worker scaling**: Cloudflare handles requests without your laptop being on. No per-hour VM charge on Workers Free.
- **Persistence**: D1 holds all saved quiz definitions, active game snapshots, scores and history in the cloud. Updates don't clear D1. A redeploy does not reset the database unless you manually destroy/replace it.
- **Live connections**: a SQLite-backed Durable Object room for each session uses *hibernating WebSockets*. It sends revision hints, never private correct answers. Clients reconnect if the socket is closed and fetch the latest authoritative D1 snapshot.
- **Backups**: Periodically run:

```bat
npx wrangler d1 export gridline-cloud --remote --output=gridline-d1-backup.sql
```

This saves a local SQL backup. Store it securely: it includes users, session metadata and game content. It may interrupt your database briefly during export.
- **Free tier**: There are daily Workers and Durable Objects usage caps, D1 read/write limits and database size limits. If you exceed free limits, requests/queries may fail rather than incur charges; you don't get unlimited access. Check Cloudflare's dashboard for actual current limits.

## App architecture and security

```text
Public HTTPS workers.dev URL
    |
    +-- Web assets: web/index.html, style.css, app.js, favicon.svg
    |
    +-- Worker API: src/worker.mjs -> src/core.mjs
            |
            +-- D1 binding DB (durable SQLite) -> migrations/0001_initial.sql
            |
            +-- Durable Object binding ROOMS -> src/room.mjs
                     |-- Hibernating WebSockets per game
                     |-- Internal credential hashing endpoint (PBKDF2-SHA256)
            |
            +-- Shared pure engine: src/engine.mjs
            +-- Quiz templates: src/templates.mjs
```

- Auth: secure HTTP-only, SameSite=Strict cookies, CSRF header on authorized account mutations. Password hashing uses WebCrypto PBKDF2 within a Durable Object to remain compatible with Workers Free's stricter per-request CPU budget.
- Actions: host-only commands and player-token buzzes are validated by Worker API.
- Concurrency: D1 compare-and-swap updates with revision check prevent two simultaneous buzzes from both receiving first-winner status. Not a guarantee of equal internet latency.
- Preset game sample is created at host signup.
- No arbitrary executable HTML uploaded via questions; user-entered text is escaped by UI.
- Do not store sensitive personal information in this beta. The game uses a public, guessable join-code format; invite only trusted friends.
- No payment, subscription, cryptocurrency, hidden secrets or externally hosted application server needed for baseline gameplay.

## If something goes wrong

**`npm is not recognized`** — Install the latest LTS version of Node.js and reopen the terminal.

**`could not resolve ... wrangler`** — The PC needs internet access for `npm install`; run it again when connected.

**`D1_ERROR: no such table: users`** — Run `npx wrangler d1 migrations apply gridline-cloud --remote` on the SAME database ID your Worker uses.

**`Invalid database_id`** — Replace the zero UUID placeholder with the UUID printed by `npx wrangler d1 create gridline-cloud`.

**`Could not find worker` / DO namespace error** — Ensure Wrangler version 4+, both `Room` class and `ROOMS` binding exist, then rerun `npm run deploy`.

**Website loads but buttons say connection error** — Check `<your-link>/api/health` for JSON; check Cloudflare Workers logs from the deployment dashboard.

**Join link fails** — Use the deployed `https://...workers.dev` address, not `localhost:4173` or a closed ngrok link.

**Friend doesn't get real-time score** — Refresh first; WebSocket reconnection should fetch authoritative D1 state. Check browser console's network WebSocket upgrade at `/api/sessions/CODE/events` and check Durable Objects usage in Cloudflare dashboard.

**Auth appears slow** — Password hashing is deliberately expensive; subsequent gameplay requests do not hash passwords.

**Existing old host password doesn't work** — Create a new cloud host account. Local passwords use Node scrypt; cloud passwords use WebCrypto PBKDF2. Existing host credentials are not automatically copied.

## Test status / scope

22 Node-based tests pass, validating gameplay, timers, final wagers, JSON/SQL-backed API flow with a D1 shim, login, protected snapshots, player identity, score audit/undo and revision notifications. These are **not** a Cloudflare edge integration run. The environment where the ZIP was assembled could not download or execute Wrangler, so complete deployment compatibility remains to be verified on a computer with npm access. If it throws an error, save the terminal message and investigate before assuming production is ready.

Some ambitions in the original 60-section master prompt remain unimplemented in either GRIDLINE version (such as media uploads, QR generation, and high-scale load testing). This conversion preserves the existing v0.8 beta, not a complete newly developed commercial SaaS.

## Official documentation

- Workers Free: https://developers.cloudflare.com/workers/platform/pricing/
- D1 migration commands: https://developers.cloudflare.com/d1/wrangler-commands/
- Durable Object WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Worker assets: https://developers.cloudflare.com/workers/static-assets/binding/
- D1 exports: https://developers.cloudflare.com/d1/best-practices/import-export-data/


## Admission update prepared 29 October 2026

The host selects 1–60 participants (default 8) and admits or declines one waiting contestant at a time. Join reservations and participant records now commit in a single D1 batch transaction. Failed inserts cannot leave an invisible pending contestant, and racing admit/decline actions cannot remove an approved player. Command receipts and action logs commit with state changes.

The cumulative UI update keeps answer reveal under host control, supports buzzer reset/reopen, and shows approval status. `npm run check` passes 37 tests on Node 24, including concurrent joins, admit/decline races, retries, database rollback and the actual Room authentication handler. A real local workerd/D1 smoke check also covers registration, login, incorrect-password rejection and the admission flow.

The Cloudflare account and D1 identifiers were recovered from the original deployment setup and restored in `wrangler.jsonc`. The Room handler now uses the deployed 100,000-round PBKDF2 format; the older 110,000-round version exceeded the reported runtime limit. Malformed digest fields and unsupported iteration formats are rejected. No stored password hashes were rewritten. The local test confirms runtime compatibility; an existing production host account still needs a signed-in live check.

Deployment remains pending because Wrangler is not authenticated. Use the existing Cloudflare account, export D1 before deployment, verify the target database identity, then deploy. Verify existing-account sign-in and a new isolated session with a host and two clients. Confirm that only one waits, rejected clients cannot play and caps hold. No production migrations or live room changes were performed by this review.

D1 transactional batching: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
