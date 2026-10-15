# Football Auction Royale — Railway deployment

Full multiplayer football auction game, 1,000 players, synchronized bidding/markets, cinematic 2D match simulation and room reconnection. **This branch is isolated from BuzzGrid's `main` branch.**

## Start

`npm start` with Node.js 22+. The `bootstrap.mjs` file unpacks the locked application source, HTML/CSS/JS, and the full 1,000-card database from `game.tar.gz` before starting the game's built-in HTTP/WebSocket server.

- HTTP health check: `/api/health`
- Player endpoint: `/api/players`
- Full page: `/`
- WebSockets are served by the same Node process.
- To preserve active rooms and player image uploads, attach a persistent Railway volume mounted at `/data`. The game automatically respects `RAILWAY_VOLUME_MOUNT_PATH`; it saves `sessions.json` and `player-images` there.
- **One replica only**: this version uses a single in-process authoritative game state.
- Do not enable sleep/serverless hibernation during live games.

The source is bundled because it is deployed as a complete tested, version-locked artifact. Its original directory hierarchy is preserved inside `game.tar.gz` and is unpacked at startup. This is distinct from an ordinary static website.

Deployment package passes all 37 Node tests locally. Remote website acceptance tests and actual live-player functionality must be checked after deployment. Player photos from Wikimedia still need some manual identity/attribution review.