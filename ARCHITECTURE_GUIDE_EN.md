# Complete Architecture Guide for Linda Pear

This document provides a clear, simple, and structured explanation of how **Linda Pear** works, its internal architecture, the responsibility of each file, and where specific features and subsystems are implemented.

---

## 1. What is Linda Pear (In Simple Terms)

**Linda Pear** is a **100% Peer-to-Peer (P2P)**, encrypted, **serverless** messaging and file-sharing application.

Unlike traditional messengers (such as WhatsApp, Telegram, or Signal) or other P2P apps that rely on third-party relay servers (like TURN/relay infrastructure):
- **No central server**: There is no central database, no cloud backend, and no account registration with an email or phone number.
- **Zero relay dependency**: Data flows directly from device to device.
- **Sovereign end-to-end cryptography**: User identities are cryptographic keypairs (derived from a 12-word BIP39 mnemonic seed phrase).
- **Built on the Holepunch Stack**: Powered by the battle-tested open-source primitives created by Holepunch/Keet (*Hypercore*, *Corestore*, *Autobase*, *Hyperbee*, *Hyperswarm*, *Hyperdrive*).

---

## 2. Core Architectural Pillars (The Holepunch Stack)

To understand the codebase, here are the 6 foundational building blocks:

```
+-------------------------------------------------------------------------+
|                                USER INTERFACE                           |
|  Desktop: Electron *or* the Pear runtime + Web Components               |
|           (src/ui/app-shell.ts, src/ui/desktop-host.ts)                 |
|  Mobile:  React Native / Expo + Bare-Kit Worklet (mobile/)              |
+-------------------------------------------------------------------------+
|                         SESSION COORDINATOR                             |
|  Global state management, profile, bookmarks, contacts, RPC channels    |
+------------------------------------+------------------------------------+
|               DATA                 |              NETWORKING            |
|  • Autobase: multi-writer room log |  • Hyperswarm: DHT & Holepunching  |
|  • Hyperbee: B-tree key-value store|  • Protomux / RPC: ephemeral data  |
|  • Hyperdrive: P2P files & media   |    (typing, acks, write grants)    |
|  • Corestore: Hypercore manager    |                                    |
+------------------------------------+------------------------------------+
|                        SECURITY & IDENTITY                              |
|  • Libsodium / Argon2id: encrypted local storage with user passphrase   |
|  • BIP39: 12-word mnemonic recovery phrase                              |
|  • Epoch Keys: rotating room encryption keys                            |
+-------------------------------------------------------------------------+
```

1. **Hypercore**: An append-only, cryptographically signed log of binary blocks.
2. **Corestore**: A manager that creates, persists, and namespacing multiple Hypercores.
3. **Autobase**: Coordinates multi-user rooms. Each member appends to their own local Hypercore; Autobase deterministically linearizes all participants' logs into a single causal message stream.
4. **Hyperbee**: A B-tree key-value database built on top of Hypercore/Autobase. Used for indexing room state, messages, overlays, contacts, and user profiles.
5. **Hyperswarm & DHT**: A distributed networking layer that connects peers over the internet using 32-byte topic hashes and UDP holepunching—without intermediaries.
6. **Hyperdrive**: A distributed P2P filesystem. Shared files are written to the sender's local drive and transferred block-by-block directly to peers (who in turn become seeders).

---

## 3. Directory Map & File Responsibilities

### 📁 Root Directory
- [package.json](package.json): Project dependencies, startup scripts (`npm run start`, `start:a`, `start:b` for local multi-peer testing), build tools, and Pear/Electron packaging.
- [build.js](build.js): *esbuild* bundler. Emits three bundles from the one `src/` tree — `dist/app.js` (CommonJS, Electron), `dist/pear/app.js` (ESM with `node:*` rewritten to `bare-*`, Pear) and `dist/worker.js` (the session worker, see `src/worker/`) — and generates `src/version.ts` from `package.json`'s version.
- [index.html](index.html): GUI entry point for the Electron build.
- [pear.js](pear.js) & [pear.html](pear.html): entry points for the Pear build. `package.json`'s `main` is `pear.js`: Pear v2 dropped HTML entrypoints, so it boots JS that starts `pear-electron` (the UI runtime) and `pear-bridge` (which serves `pear.html`).
- [forge.config.cjs](forge.config.cjs): Electron Forge packaging (`.msix` on Windows, `.zip` on macOS/Linux). Its `packageAfterCopy` hook writes `main: electron/main.cjs` into the packaged copy, since `package.json`'s own `main` belongs to Pear.
- [style.css](style.css): Complete CSS stylesheet for the desktop interface (themes, layout, chat bubbles, modals).
- [test.js](test.js): Integration test runner executing TypeScript test suites via Node.js native test runner.

---

### 📁 `src/` (The Shared Core Engine)

All business logic in `src/` is platform-agnostic and shared by all three runtimes: Electron (Node),
Pear (Bare) and the mobile worklet (Bare). Anything that reaches for a `node:` builtin with no Bare
equivalent has to be injected rather than imported, or it breaks the other two at *bundle* time —
see `SwarmTransport.createLanDiscovery` and `Session`'s `createMediaServer` for the two cases.

- [main.ts](src/main.ts): Entry point for both desktop bundles — boots the identity flow and mounts `<app-shell>`.
- `src/types/`: Hand-written ambient declarations for the Holepunch packages that ship no types of their own (`autobase`, `hyperbee`, the `holepunch*` set), plus `pear.d.ts` for the Pear runtime globals and `lan-discovery-deps.d.ts` for `multicast-dns`.

#### 🔐 `src/identity/` (Identity & Key Management)
- [index.ts](src/identity/index.ts): Main interface for creating, unlocking, recovering, and pairing identities.
- [keypair.ts](src/identity/keypair.ts): Generates Ed25519 public/secret keypairs using `hypercore-crypto`.
- [mnemonic.ts](src/identity/mnemonic.ts): Handles 12-word BIP39 recovery phrases and seed generation.
- [storage.ts](src/identity/storage.ts): Persists `identity.json` to disk, encrypting the secret key using **Argon2id** (`crypto_pwhash`) and `crypto_secretbox`.
- [pairing.ts](src/identity/pairing.ts): QR code device-pairing protocol. Securely transfers an identity over a temporary Hyperswarm channel to a secondary device.
- [profile.ts](src/identity/profile.ts): Basic nickname and avatar schema.

---

#### 🌐 `src/network/` (P2P Swarm & Ephemeral RPC)
- [swarm.ts](src/network/swarm.ts): Initializes **Hyperswarm**, connects to DHT topics, and performs NAT traversal.
- [rpc.ts](src/network/rpc.ts): Protomux-based RPC protocol (`linda-rpc/1`) for ephemeral interactions: typing indicators, presence, read receipts, room write-access requests, public announcements, and encryption key exchanges.
- [encoding.ts](src/network/encoding.ts): Compact binary encoders and decoders (`compact-encoding`) for network RPC payloads.
- [lobby.ts](src/network/lobby.ts): Global discovery topic for announcing and discovering public rooms.
- [lan-discovery.ts](src/network/lan-discovery.ts): Opt-in mDNS discovery for a LAN with no uplink, alongside the DHT. **Electron only** — it pulls in `multicast-dns`, which needs `node:dgram`; [lan-discovery-stub.ts](src/network/lan-discovery-stub.ts) takes its place in the Pear and mobile bundles.

---

#### 💬 `src/rooms/` (Multi-Writer Room Engine)
- [room.ts](src/rooms/room.ts): **The core engine of Linda Pear rooms.**
  - Organizes multi-writer distributed logs using **Autobase**.
  - **Deterministic `apply()` function**: Applies and validates all room operations (messages, edits, deletions, emoji reactions, writer additions, moderation roles, mutes, bans, broadcast mode).
  - **Multi-Admin Governance (Keet-style peer model)**: Supports promoting/demoting multiple administrators (`promoteAdmin`, `demoteAdmin`). Co-admins can authorize new writers and validate invite codes even when the room creator is offline.
  - **Rotating Room Encryption**: Manages message encryption across rotating *Epoch Keys*.
  - **Reactions & Overlays**: Tracks message metadata changes without violating the immutability of the underlying log.

---

#### 📁 `src/files/` (File Sharing & Media Streaming)
- [drive.ts](src/files/drive.ts): `FileStore` abstraction built on **Hyperdrive** for seeding and fetching files P2P.
- [media-range.ts](src/files/media-range.ts): Computes HTTP `Range` headers (e.g. `bytes=0-1048576`) to support seeking and instant playback.
- [media-server.ts](src/files/media-server.ts): Platform-agnostic request handler protected by session tokens (`/<token>/<driveKey>/<filePath>`).
- [media-server-node.ts](src/files/media-server-node.ts): Node.js loopback HTTP server (`127.0.0.1`) that pipes requested file slices directly into the native video/audio player.

---

#### 🧠 `src/app/` (Application State & Coordination)
- [session.ts](src/app/session.ts): **The central orchestrator.**
  - Glues together identity, Hyperswarm networking, Hyperdrive file management, room lifecycle, contact requests, and file downloads.
  - Handles the full lifecycle: account unlock, opening rooms, joining via invites, delegating write authorizations to online admins, sending messages, attachments, and remote downloads.
  - **Local History Management**: Implements `clearRoomHistory` (device-local `clearedAt` filter leaving the distributed log intact) and `restoreRoomHistory` (instant local unhiding without network download).
  - **Device Pairing**: Exports and imports secure snapshots to clone identities and synchronize contacts, bookmarks, and epoch encryption keys across devices.
- [profile-store.ts](src/app/profile-store.ts): Local **Hyperbee** store containing:
  - Saved room bookmarks (`bookmarks`).
  - Contact book and pending requests (`contacts`).
  - Room encryption keys (`room_keys`).
  - Reusable room invite tokens (`room_invites`).
  - Peer avatar cache (`peer_avatars`).
  - Local preferences (chat wallpapers, nickname).
- [session-view.ts](src/app/session-view.ts): The interface the UI is allowed to see. `SessionView` and `RoomView` are `Pick<>`s over the real classes, so the UI compiles against the subset that can survive being moved behind an RPC boundary — and a member added to `Session` without a wire equivalent fails typecheck rather than at runtime.
- [open-session.ts](src/app/open-session.ts) / [open-session-worker.ts](src/app/open-session-worker.ts): The two launchers. The first opens a `Session` in this process (Electron/Pear); the second talks to one running in the worker. `build.js` swaps one for the other per target, so neither ever reaches the other's bundle.

---

#### ⚙️ `src/worker/` & `src/transport/` (Session Out-of-Process)

The session can run outside the UI process — the mobile app has always worked this way, with `src/`
inside a Bare worklet and React Native talking to it over IPC. These two directories are that seam,
shared rather than reimplemented per platform.

- [worker/entry.ts](src/worker/entry.ts): Boots a `Session` inside the worker and wires it to the pipe.
- [worker/dispatcher.ts](src/worker/dispatcher.ts): Turns wire calls into `Session`/`Room` calls and pushes events (typing, read receipts, peer connect/disconnect) back the other way.
- [transport/frame.ts](src/transport/frame.ts): The frame layout both ends share — `<4-byte LE header length><JSON header><binary tail>` — so a file's bytes ride the same channel without base64.
- [transport/rpc-client.ts](src/transport/rpc-client.ts): The calling half.
- [transport/remote-session-view.ts](src/transport/remote-session-view.ts) & [remote-room-view.ts](src/transport/remote-room-view.ts): `SessionView`/`RoomView` implementations backed by that RPC, so UI code cannot tell whether the session is in this process or another one.

---

#### 🖥️ `src/ui/` & `src/util/` (Desktop UI & Utilities)
- [app-shell.ts](src/ui/app-shell.ts): Custom Web Component `<app-shell>` implementing the complete Electron GUI (authentication screens, room directory, chat stream, audio recorder, modals).
- [qr.ts](src/ui/qr.ts) & [qr-core.ts](src/ui/qr-core.ts): QR code rendering and video stream scanning.
- [desktop-host.ts](src/ui/desktop-host.ts): The window controls the shell needs (minimise, maximise, close, maximised-state), behind one interface with an `ElectronHost`, a `PearHost` and a `WebHost` behind it — the two desktop runtimes expose entirely different APIs for the same three buttons.
- [wallpapers.ts](src/ui/wallpapers.ts): Preset chat wallpapers and background styles.
- [app-backgrounds.ts](src/ui/app-backgrounds.ts): Backgrounds for the app frame itself, as opposed to the chat canvas.
- [room-presets.ts](src/ui/room-presets.ts): Preset room icons and descriptions offered at room creation.
- [avatar.ts](src/util/avatar.ts), [bytes.ts](src/util/bytes.ts), [hashtag.ts](src/util/hashtag.ts), [id.ts](src/util/id.ts): Utility functions for deterministic color generation, size formatting, hashtag parsing, and ID generation.

---

### 🖥️ `electron/` (Desktop Shell)
- [main.cjs](electron/main.cjs): Electron main process. Configures native window settings, security permissions (microphone capture for voice notes, screen capture, clipboard), and boots `index.html`.
- [preload.cjs](electron/preload.cjs): Safe preload bridge for system-level APIs.

---

### 📱 `mobile/` (React Native / Expo Mobile App)
- [App.tsx](mobile/App.tsx): Root React Native component with theme and navigation containers.
- [mobile/worklet/entry.ts](mobile/worklet/entry.ts): The **mobile P2P engine**. Executes the shared `src/` core in a native background worklet (*Bare Kit*) and interfaces with the UI via asynchronous IPC frames.
- [mobile/worklet/media-server.ts](mobile/worklet/media-server.ts): Mobile HTTP streaming server powered by `bare-http1`.
- `mobile/src/bare/`: Proxy clients bridging React Native hooks to the Bare background worklet.
- `mobile/src/screens/`: Screens for Room Chat, Room List, Contacts, Profile, QR Device Pairing, and Authentication.
- `mobile/src/components/`: Reusable components (Chat Bubbles, Video Player Modal, Audio Player, Contact List Item).

---

### 🧪 `test/` (Integration Test Suite)
Run with `npm test`, or `LINDA_TEST_DHT=public npm test` to put the same assertions on the public DHT.

- [session.test.ts](test/session.test.ts): Spawns two full `Session` instances communicating over an in-process testnet DHT to test end-to-end sync and write grants.
- [room.test.ts](test/room.test.ts): Tests Autobase ordering, message mutations, emoji reactions, and moderation rules.
- [security.test.ts](test/security.test.ts): Verifies security boundaries against forged entries and unauthorized writers.
- [media-stream.test.ts](test/media-stream.test.ts), [media-range.test.ts](test/media-range.test.ts) & [media-transport.test.ts](test/media-transport.test.ts): Validates chunked HTTP media streaming and the transport under it.
- [room-files.test.ts](test/room-files.test.ts) & [drive-reuse.test.ts](test/drive-reuse.test.ts): File sharing, the Files index over the chat log, and drive reuse.
- [contact-invite.test.ts](test/contact-invite.test.ts): The contact-link flow and the 1-to-1 room it opens.
- [rejoin-restart.test.ts](test/rejoin-restart.test.ts): A write grant that has to survive a restart, because the owner was away when the invite was presented.
- [room-open-retry.test.ts](test/room-open-retry.test.ts): Pins the one-`Room.open`-per-corestore-namespace invariant a first join depends on.
- [worker-bootstrap.test.ts](test/worker-bootstrap.test.ts), [remote-session.test.ts](test/remote-session.test.ts) & [mirror-parity.test.ts](test/mirror-parity.test.ts): The worker transport, the remote views over it, and the check that the mirrored surface has not drifted from `SessionView`.
- [lan-discovery.test.ts](test/lan-discovery.test.ts), [hashtag.test.ts](test/hashtag.test.ts) & [wallpapers.test.ts](test/wallpapers.test.ts): mDNS discovery, hashtag parsing, wallpaper presets.

---

## 4. Key Operational Workflows

### A. Account Creation & Unlock
1. On launch, `storage.ts` checks for an existing `identity.json`.
2. **If new**: `mnemonic.ts` generates a 12-word phrase, deriving an Ed25519 keypair. The user chooses a passphrase, which encrypts the private key via Argon2id into `identity.json`.
3. **If existing**: The user enters their passphrase, `storage.ts` decrypts the secret key, and `Session` initializes.

### B. Sending a Chat Message
1. User enters text and sends.
2. The UI calls `room.send(authorId, body, replyTo?)` ([app-shell.ts](src/ui/app-shell.ts) on desktop; on mobile the same call crosses the worker RPC first).
3. The message body is encrypted with the room's current *Epoch Key*.
4. Autobase appends the entry to the user's local Hypercore.
5. Hyperswarm pushes new blocks to connected room peers.
6. Each peer's deterministic `apply()` function validates the author and indexes the entry in the linearized message view, then notifies the UI. `apply()` does **not** decrypt: the ciphertext is what is stored, and `getMessage()` decrypts on read (see `decryptText` in [room.ts](src/rooms/room.ts)).

### C. File Sharing & Range Streaming
1. User attaches a video or audio file.
2. `FileStore` ([drive.ts](src/files/drive.ts)) writes the binary data to the user's local Hyperdrive.
3. A chat message containing the file metadata (`driveKey`, path, size, MIME type) is published.
4. The file automatically appears in both the chat feed and the **Room Files** tab.
5. When a peer clicks play, their local media player requests byte slices from the internal HTTP server (`media-server.ts`).
6. The server streams requested chunks directly over the P2P swarm, enabling instant playback without downloading the entire file first.

### D. Multi-Admin Governance & Offline Creator Resilience
1. The room creator can promote any member to **Admin** via `room.promoteAdmin(identityId)` or to **Moderator** via `room.promoteToModerator(identityId)`.
2. The action appends a deterministic entry (`promoteAdmin`) to the Autobase log. All connected peers update their indexed admin registry in Hyperbee.
3. When a new user attempts to join via an invite link (`bootstrapKey:inviteCode`), their client broadcasts an RPC `requestWriteIfNeeded` request over Protomux to all connected room peers.
4. Any **currently online co-admin** validates that the invite code matches the active state in Autobase and executes `room.addWriter(writerKey, identityId)`.
5. The new member receives write authorization and the current encryption epoch key even if the original room owner is offline, ensuring continuous room autonomy and decentralization.

### E. Local-Only Clear & Restore Chat History
1. Selecting "Clear Chat History" invokes `session.clearRoomHistory(roomId)`.
2. The method **never alters the local Autobase/Hypercore log** nor broadcasts delete entries to peers: it simply records `clearedAt = Date.now()` in the local `RoomBookmark`.
3. The UI filters displayed messages using `timestamp > clearedAt`, hiding past history from this device's view.
4. Clicking **"Restore Chat History"** executes `session.restoreRoomHistory(roomId)`, dropping the `clearedAt` property.
5. All previous conversation entries immediately reappear on screen, read directly from local storage with zero network bandwidth or peer dependency.

### F. P2P Device Pairing via QR
1. The primary (unlocked) device opens "Pair a Device", generating an ephemeral secret token and announcing a temporary topic on Hyperswarm.
2. A QR code containing the connection coordinates and symmetric session encryption key is displayed.
3. The secondary device scans the QR code using its camera (`expo-camera` on mobile or desktop scanner) and joins the Hyperswarm topic.
4. The primary device exports a complete snapshot (`getPairingSnapshot`): nickname, avatar, accepted contacts, room bookmarks, and all historical *Epoch Keys*.
5. The secondary device imports the snapshot (`importPairingSnapshot`), excluding device-local state (such as `clearedAt` or favorites), and boots the synchronized rooms.

### G. Contact Requests & 1:1 Encrypted Chat Spawn
1. A user generates a contact invite link via `session.createContactInvite()`. The link (`linda-pear://...`) encodes the author's public identity and bootstrap key for an auto-provisioned room.
2. The recipient pastes the link and dispatches a contact request (`sendContactRequest`).
3. The request surfaces in the recipient's **Contacts** list as an incoming request.
4. Accepting the request (`respondToContact`) marks the contact as `accepted` on both clients, exchanges writer keys for the 1:1 room, and opens the private, end-to-end encrypted chat.

### H. Sovereign Personal Vault (Single-Writer Encrypted Space)
1. Every identity is automatically provisioned with an encrypted **Personal Vault** (`isVault: true`, `favorite: true`), idempotently verified or initialized at startup via `session.ensurePersonalVault()`.
2. Unlike group or 1:1 rooms, the Personal Vault is a **single-writer** Autobase space: only the local identity possesses write authority. With zero remote writers to coordinate with, append operations are instantaneous, conflict-free, and fully offline-capable.
3. In local storage (`RoomBookmark`), the `isVault: true` attribute guarantees that the vault is pinned to the top of the sidebar with a prominent gold `🔐 VAULT` badge.
4. During P2P device pairing (`getPairingSnapshot` / `importPairingSnapshot`), both `isVault` and `favorite` flags are preserved and replicated to secondary devices, ensuring private notes, passwords, and personal files remain synchronized across all trusted hardware.

### I. Adaptive Message Views (Chat, Mailbox, Notes, Files)
1. An Autobase room maintains an immutable, causal log of messages (`body`, `file`, `reactions`, `timestamp`).
2. The presentation layer (`app-shell.ts`) projects this unified data stream into 4 specialized operational perspectives via the header navigation switcher:
   - **Chat**: Standard conversational bubble stream for real-time messaging, emoji reactions, and voice notes.
   - **Mailbox**: Asynchronous dual-pane layout inspired by desktop email clients (inbox message list with author, preview snippet, and time on the left; formal reading pane with E2E encryption badge, sender/recipient metadata, attachments, and quick-reply composer on the right).
   - **Notes / Document**: Distraction-free continuous document stream without speech bubbles, organized by date dividers. Tailored for long-form notes, research records, and Personal Vault journal entries.
   - **Files**: Replicated Hyperdrive shared file browser with search, download, and range-seek media streaming.
3. This multi-view design requires **zero backend schema migrations**: all views are pure functional renderer projections of the identical underlying encrypted Autobase log.

### J. LindaWeb Roadmap: Zero-Knowledge WebSocket Bridge & Headless Companion
1. **The Browser Constraint**: Web browsers cannot execute raw UDP/TCP sockets or join the Hyperswarm DHT due to security sandbox restrictions; WebRTC requires external STUN/TURN relays.
2. **The Sovereign Solution**: A lightweight headless companion daemon (`linda-daemon` or the local desktop client itself) acts as a local or remote gateway by exposing an authenticated WebSocket endpoint (`linda-bridge`).
3. **Zero-Knowledge Wire Security**:
   - The user's 12-word BIP39 mnemonic and Ed25519 identity keypairs remain strictly inside the browser (IndexedDB protected via WebCrypto).
   - The web client compiles cryptographic primitives to WASM (`libsodium-wrappers`), encrypting and decrypting all messages locally on the client device.
   - The WebSocket bridge exclusively transports encrypted ciphertext frames and Hypercore replication streams, with zero visibility into message payloads or capability to forge signatures.

