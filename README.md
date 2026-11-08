# scrolltogo

Password-protected, one-way screen sharing for watching things with friends. You share your screen in a room; friends open the link, enter the password and watch.

- Peer-to-peer over WebRTC: video goes straight from the host's browser to each viewer, never through the server.
- A Cloudflare Worker serves the pages, and a Durable Object per room relays the connection handshake.
- Viewers must send the room password before the host learns they exist. Passwords are stored as salted PBKDF2 hashes, and a room locks for a minute after 5 wrong guesses.
- Quality from 720p30 up to 4K60. The host uploads a separate stream per viewer, so upload bandwidth sets the limit.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:8787. Screen capture is allowed on `localhost` without HTTPS.

## Deploy

```bash
npx wrangler login
npm run deploy
```

On Windows PowerShell, use `npx.cmd` if `npx` is blocked by the execution policy.

### Optional: TURN relay

Some networks block direct connections. To add a relay, create a TURN key in Cloudflare Realtime and set:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

## Files

- `src/worker.js` – Worker and the `Room` Durable Object (signaling, password check)
- `public/host.js` – capture and send the screen
- `public/watch.js` – password prompt and player
- `public/common.js` – reconnecting signaling socket

## Host app (Windows)

Uncapped, focused games can starve Chrome's screen capture on the GPU, so the stream stutters. OBS avoids this by giving itself realtime GPU scheduling priority (`D3DKMTSetProcessSchedulingPriorityClass` in `libobs-d3d11`). `host-app/` is a small launcher that opens the host page in its own Chrome window and gives that window's processes the same priority. Viewers still just use the link in their browser.

```bash
cd host-app
dotnet publish -c Release -o ../dist
```

Run `dist/scrolltogo.exe`; no admin rights are needed. Requires the .NET 9 desktop runtime and Chrome or Edge.
