# Auth Foundation Plan — Supabase (Google + Discord)

**Branch:** `worktree-auth-foundation`
**Status:** plan only — implement this.
**Scope of THIS task:** stand up the account/identity foundation. Nothing else (no XP,
no skins, no store, no ads). The deliverable is: a player can sign in with Google or
Discord, the game server can resolve a socket connection to a Supabase user id, and a
durable `progression` row exists per user that the server can read/write. Downstream
features (XP, skins, achievements, payments) build on top of this later and are **out of
scope here**.

This is the first chunk of a larger monetization/progression effort. The big picture
(why we're doing this): ChaoChao will be free-to-play, monetized Agar.io-style with **ads
+ earned/paid cosmetic skins**. Skins are earned via an XP/level curve and lifetime
achievements, or bought. None of that can persist across cache-clears or devices without
real accounts — hence this foundation. Do not implement the progression mechanics here;
just make identity durable and resolvable server-side.

---

## Architecture (decided — do not re-litigate)

- **Supabase for BOTH auth and database.** Free tier; external and always-on, so it's
  unaffected by the server's sleep/wake dyno loop (`index.js` sleeps when `clientCount == 0`).
- **Supabase owns the entire OAuth dance.** Therefore **add NO login/callback routes to the
  Express server.** The browser uses `@supabase/supabase-js` `signInWithOAuth({ provider })`;
  the OAuth redirect URI points at Supabase's `https://<ref>.supabase.co/auth/v1/callback`,
  not at our server.
- **The Socket.IO handshake carries the auth.** After sign-in the client holds a Supabase
  access token (JWT). It passes that token in the socket handshake
  (`io(url, { auth: { token, deviceId } })`). The server validates it in **`io.use()`
  middleware added immediately before `io.on('connection')` (`index.js:145`)**, attaches
  `socket.userId` (and `socket.deviceId` for guests), then proceeds.
- **The server is authoritative** and WRITES progression using the Supabase **service-role
  key** (bypasses RLS). The browser may READ its own progression via RLS for display, but
  must never be trusted to write it.
- **Anonymous players still work.** No token → the handshake carries a `deviceId` generated
  and persisted in `localStorage`; the socket is a guest. Guest progression stays in
  `localStorage` for now (server-side guest rows are a later nicety, out of scope).
- **Account linking = merge, never reset.** When a guest signs in, the client sends its
  `localStorage` deviceId; the server appends it to the user's `device_ids` and (later, when
  progression mechanics exist) merges guest progress into the account row. For THIS task,
  just record the deviceId on the row and create the row if missing.

### Keep this task OUT of `server/game.js`, `server/engine.js`, `server/config.json`

Touching any of those three files triggers the release-notes-check workflow and requires a
player-facing `## Unreleased` bullet in `CHANGELOG.md`. The auth foundation is pure infra and
can be built entirely in `index.js`, `server/messenger.js`, a new `server/auth.js`, and the
client. **Do not modify the `Player` object in `game.js`** — thread `userId` through the
socket/messenger layer and key progression by `userId` separately. If you find you cannot
avoid game.js, stop and flag it rather than silently adding a CHANGELOG entry.

---

## Prerequisites (the human operator provides these; assume they exist)

The repo owner sets these up in Supabase / Google Cloud / Discord and provides env vars.
Build against the env vars; if absent, the server should boot fine with auth disabled
(treat everyone as guest) so dev without credentials still works.

Env vars (local `.env` + Heroku config vars, never committed):
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`        — client-safe (exposed to browser)
- `SUPABASE_SERVICE_ROLE_KEY` — **server only, never sent to client**
- `SUPABASE_JWT_SECRET`       — server only, for local JWT verification

Add `.env` to `.gitignore` if not already covered.

---

## Database schema (run in Supabase SQL editor)

```sql
create table if not exists progression (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  xp             integer not null default 0,
  level          integer not null default 1,
  unlocked_skins text[]  not null default '{}',
  selected_skin  text,
  wins           integer not null default 0,
  medal_counts   jsonb   not null default '{}',
  device_ids     text[]  not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- RLS: a user may read only their own row; writes happen via service role (bypasses RLS).
alter table progression enable row level security;
create policy "read own progression"
  on progression for select
  using (auth.uid() = user_id);
```

(XP/level/skins columns exist now so downstream work doesn't require a migration, but THIS
task only ensures the row exists and stores `device_ids`. Leave the rest at defaults.)

---

## Server changes

1. **Add dependency:** `npm install @supabase/supabase-js`.

2. **New file `server/auth.js`:**
   - Export a server Supabase client built with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
   - Export `verifyToken(token)` → returns `userId` or null. Prefer local verification of the
     JWT with `SUPABASE_JWT_SECRET` (no network round-trip per connection). Acceptable
     fallback: `supabase.auth.getUser(token)`.
   - Export `ensureProgressionRow(userId, deviceId)` → upserts a `progression` row for the
     user, appending `deviceId` to `device_ids` (dedup) if provided.
   - If env vars are missing, export no-op stubs so dev works without credentials.

3. **`index.js` — Socket.IO middleware** (insert **before** `io.on('connection')` at line 145):
   ```js
   io.use(async (socket, next) => {
     const { token, deviceId } = socket.handshake.auth || {};
     socket.deviceId = deviceId || null;
     socket.userId = null;
     if (token) {
       const userId = await auth.verifyToken(token);
       if (userId) {
         socket.userId = userId;
         await auth.ensureProgressionRow(userId, deviceId);
       }
     }
     next(); // never reject — guests are allowed
   });
   ```
   Require `server/auth.js` near the other requires (around `index.js:128-130`).

4. **`server/messenger.js`:** in `addMailBox` / the connection wiring, record `socket.userId`
   and `socket.deviceId` alongside the existing socket-id mailbox so later code can resolve
   client id → account. A simple `id → { socket, userId, deviceId }` is enough. Do not change
   the gameplay event handlers' behavior in this task.

5. **Expose public Supabase config to the client.** The browser needs `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` (both safe to expose). Reuse the existing HTML-injection pattern in
   `index.js` (the `<!-- VERSION -->` / `<!-- NEWS_BANNER -->` string replacement, ~lines
   95-106): inject a small inline `<script>window.__SUPABASE__ = {url, anonKey}</script>` (or a
   `<meta>` tag) into the served pages that need auth. Add a placeholder comment in the HTML
   and replace it server-side. **Never inject the service-role key or JWT secret.**

---

## Client changes

The client is NOT a module bundler — `build.js` concatenates per-file globals and HTML pages
list raw `<script>` tags inside `<!-- BUILD: bundle-start --> … <!-- BUILD: bundle-end -->`.
So:

1. **Load supabase-js via CDN UMD** (simplest, given the concat build), e.g.
   `<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>` which exposes
   `window.supabase.createClient`. Add it to the relevant page(s).

2. **New client script `client/scripts/auth.js`** (add it to BOTH the `build.js` bundle list
   for the relevant page AND the `<!-- BUILD -->` block in that page's HTML — per CLAUDE.md):
   - Init: `const sb = supabase.createClient(window.__SUPABASE__.url, window.__SUPABASE__.anonKey)`.
   - Generate + persist a `deviceId` UUID in `localStorage` if absent.
   - `signIn(provider)` → `sb.auth.signInWithOAuth({ provider, options: { redirectTo: <current page> } })`.
   - On load, `sb.auth.getSession()` → if signed in, grab the access token.
   - Provide a getter the socket setup uses to obtain `{ token, deviceId }`.

3. **Pass auth into the socket handshake.** Find where the client constructs the Socket.IO
   connection (in the play/join client bootstrap) and change it to
   `io(url, { auth: { token: <access token or null>, deviceId } })`. If not signed in, token is
   null and the player is a guest.

4. **Login UI.** Add minimal Discord + Google sign-in buttons (where they live in the UX is a
   later design call — for THIS task a simple, unobtrusive placement is fine, e.g. the landing
   page or lobby). The "save your skins" framing/prompt-at-peak is a LATER task; here just make
   sign-in possible and reflect signed-in state (show the user's name/avatar from
   `sb.auth.getUser()`).

5. **Merge on sign-in.** After a successful sign-in, ensure the client's `deviceId` is included
   in the next socket handshake so the server records it on the row (the actual progression
   merge happens later when progression exists).

---

## Local-multiplayer open question (document, don't fully solve)

Local multiplayer runs up to 4 players on one machine as **one socket per local player**
(see the project's local-multiplayer feature). That means per-local-player sign-in is
*technically feasible* (each socket could carry its own token). For THIS foundation task,
keep it simple: the browser session has at most one signed-in account, and the token applies
to player 1's socket; other local players are guests. Leave a `TODO` comment noting that
per-seat sign-in is possible later. Do not block on this.

---

## Verification

1. Without env vars: `npm start`, confirm the server boots, everyone connects as guest, the
   game is unaffected.
2. With env vars + a Supabase project: click Discord/Google sign-in, complete OAuth, confirm
   the browser gets a session, the socket handshake carries the token, the server logs a
   resolved `socket.userId`, and a `progression` row exists in Supabase with the `deviceId`
   recorded.
3. Sign out / clear localStorage / sign in again on a different browser → same `user_id`
   resolved (proves durability across cache-clear, which is the whole point).

## Done criteria

- [ ] `@supabase/supabase-js` added; `server/auth.js` created with token verify + row upsert.
- [ ] `io.use()` middleware resolves socket → `userId`/`deviceId`; guests still allowed.
- [ ] `progression` table + RLS created in Supabase (SQL above).
- [ ] Public Supabase config injected into the client safely (no secrets leaked).
- [ ] `client/scripts/auth.js` created, registered in `build.js` AND the page's `<!-- BUILD -->`
      block; sign-in works for Google + Discord; socket handshake carries `{ token, deviceId }`.
- [ ] No changes to `server/game.js` / `server/engine.js` / `server/config.json` (so no
      CHANGELOG entry required). If unavoidable, flagged instead of silently added.
- [ ] Verified per the steps above.
