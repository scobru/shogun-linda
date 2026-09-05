// Runs inside the Bare runtime (react-native-bare-kit Worklet), not the RN/Hermes thread.
// Bundled by scripts/build-worklet.mjs (esbuild -> bare-pack --linked) into worklet/dist/worklet.bundle.cjs.
// Protocol over BareKit.IPC: bare-rpc (see mobile/src/bare/client.ts for the RN-side half and
// why — binary-safe framing, no more base64-in-JSON for file bytes).
//   request:  method call, frame header {method, args}
//   response: frame header {ok:true, result} | {ok:false, error}, optional binary tail
//   push:     rpc.event(), frame header {event, payload}
import fs from 'node:fs'
import RPC from 'bare-rpc'
import b4a from 'b4a'
import { identityExists, createIdentity, unlockIdentity, recoverIdentity, pairIdentity, validateMnemonic, revealMnemonic, WrongPassphraseError, type Identity } from '../../src/identity/index.js'
import { hostPairing, joinPairing, decodePairingCode } from '../../src/identity/pairing.js'
import { Session, type SessionEvents } from '../../src/app/session.js'
import type { Room } from '../../src/rooms/room.js'
import { packFrame, unpackFrame } from '../src/bare/frame.js'
import { FORWARDED_SESSION_METHODS } from '../src/bare/session-contract.js'
import type { WorkletMediaServer } from './media-server.js'

declare const BareKit: { IPC: unknown }
declare const Bare: { on(event: string, listener: (...args: any[]) => void): void }

const { IPC } = BareKit

// An exception with nowhere left to be caught otherwise kills the whole worklet — and with it
// the app, since react-native-bare-kit gives no way back in short of a full restart. `console.*`
// here reaches the system log under the `bare` tag (see react-native-bare-kit's README), so this
// trades a silent, undiagnosable crash for a warning plus a slightly stale in-memory session state
// still running on the next request, which is strictly better for the one specific case this is
// meant to catch: a fire-and-forget background call (the write-request retry, a peer RPC push)
// throwing on state that changed mid-flight. It does not paper over a request's own errors —
// those already reply {ok:false} through handleRequest's try/catch.
Bare.on('uncaughtException', (err: Error) => {
  console.error('[worklet] uncaught exception:', err?.stack || err)
})
Bare.on('unhandledRejection', (err: Error) => {
  console.error('[worklet] unhandled rejection:', err?.stack || err)
})

let identity: Identity | null = null
let session: Session | null = null
let storageDir = ''
/** Keyed on the Room object, not its id: reopening a room (a rejoin rebuilds it under a fresh
 * namespace) produces a new instance with the same id, and an id-keyed guard skipped wiring it —
 * so the new room emitted no state at all and the UI kept showing whatever it had last seen. */
const wiredRooms = new WeakSet<Room>()
/** Cancels an in-flight hosted pairing; see identity.hostPairing. */
let stopHostedPairing: (() => void) | null = null
/** Started on the first play, so a session that opens no media opens no socket. */
let mediaServer: Promise<WorkletMediaServer> | null = null
/** Snapshot received during device pairing, imported into the session on next `session.create`. */
let pendingPairingSnapshot: Record<string, unknown> | null = null

/**
 * Serializes everything that opens or destroys the session, and makes each of those wait for the
 * one before it. The corestore under a session holds an exclusive lock on its directory for as
 * long as it is open — an OFD lock, so a second open conflicts with the first even from inside
 * this same runtime — and two paths used to reach `session.create` without either of them knowing
 * about the other: the unlock screen auto-prompts for biometrics while its passphrase field stays
 * live, and a login that failed part-way leaves the user tapping Unlock again. Whichever call came
 * second opened a second corestore over the same directory and waited on that lock — not failing,
 * just never answering — so the unlock screen span forever and no later attempt could get in
 * either, until the process itself was killed. With the background connection service holding that
 * process up, that is what "clear the app's storage to get back in" really was.
 */
let sessionWork: Promise<unknown> = Promise.resolve()

function queueSessionWork<T>(work: () => Promise<T>): Promise<T> {
  const next = sessionWork.then(work, work)
  // The result is the caller's to handle; this copy only keeps a failure from poisoning the chain.
  sessionWork = next.catch(() => {})
  return next
}

/** Tears down the current session, if any, so its storage lock is released before anything reopens it. */
async function closeSession(): Promise<void> {
  const open = session
  if (!open) return
  session = null
  try {
    await open.close()
  } catch (err) {
    console.error('[worklet] closing previous session failed:', (err as Error)?.stack || err)
  }
}

const rpc = new RPC(IPC as any, (req: any) => {
  if (!req.reply) return // stray incoming event; RN never sends one
  void handleRequest(req)
})

async function handleRequest(req: any): Promise<void> {
  const { header, binary } = unpackFrame(req.data)
  try {
    const handler = methods[header.method]
    if (!handler) throw new Error(`unknown method ${header.method}`)
    const raw = await handler(...header.args, binary)
    const isBinary = raw && typeof raw === 'object' && raw.__binary === true
    req.reply(packFrame({ ok: true, result: isBinary ? raw.result : raw }, isBinary ? raw.binary : undefined))
  } catch (err) {
    req.reply(packFrame({ ok: false, error: (err as Error).message || String(err) }))
  }
}

function pushEvent(event: string, payload?: unknown): void {
  rpc.event(0).send(packFrame({ event, payload }) as any)
}

function requireIdentity(): Identity {
  if (!identity) throw new Error('no identity loaded')
  return identity
}

function requireSession(): Session {
  if (!session) throw new Error('session not created')
  return session
}

function roomState(room: Room) {
  return {
    roomId: room.id,
    writable: room.writable,
    hasKey: room.hasKey,
    broadcast: room.isBroadcast,
    canPost: identity ? room.canPost(identity.id) : false
  }
}

function pushRoomState(room: Room): void {
  pushEvent('roomState', roomState(room))
}

function wireRoom(room: Room): void {
  if (wiredRooms.has(room)) return
  wiredRooms.add(room)
  room.onMessage((index) => pushEvent('roomMessage', { roomId: room.id, index }))
  room.onWritableChange(() => pushRoomState(room))
  room.onKeyChange(() => pushRoomState(room))
  room.onFilesChange(() => {
    pushEvent('roomFilesChange', { roomId: room.id })
  })
  // Broadcast mode and mutes both change who may post without touching writable/hasKey.
  room.onMetaChange(() => pushRoomState(room))
  pushRoomState(room)
}

function requireRoom(roomId: string): Room {
  const room = requireSession().getRoom(roomId)
  if (!room) throw new Error(`unknown room ${roomId}`)
  wireRoom(room)
  return room
}

/** Everything on `Session` that is plain forwarding — see session-contract.ts. Built from the
 * contract rather than typed out, so a method cannot exist on Session and be missing here. */
const forwardedSession: Record<string, (...args: any[]) => any> = Object.fromEntries(
  FORWARDED_SESSION_METHODS.map((name) => [
    `session.${name}`,
    (...args: any[]) => (requireSession() as any)[name](...args)
  ])
)

const methods: Record<string, (...args: any[]) => any> = {
  ...forwardedSession,

  'identity.exists': (dir: string) => identityExists(dir),

  'identity.create': (passphrase: string, dir: string) => {
    const { identity: id, mnemonic } = createIdentity(passphrase, dir)
    identity = id
    return { id: id.id, mnemonic }
  },

  'identity.unlock': (passphrase: string, dir: string) => {
    try {
      identity = unlockIdentity(passphrase, dir)
    } catch (err) {
      if (err instanceof WrongPassphraseError) throw new Error('wrong passphrase')
      throw err
    }
    return { id: identity.id }
  },

  'identity.recover': (mnemonic: string, passphrase: string, dir: string) => {
    if (!validateMnemonic(mnemonic)) throw new Error('invalid recovery phrase')
    identity = recoverIdentity(mnemonic, passphrase, dir)
    return { id: identity.id }
  },

  'identity.validateMnemonic': (mnemonic: string) => validateMnemonic(mnemonic),

  'identity.revealSecretKey': () => b4a.toString(requireIdentity().secretKey, 'hex'),

  'identity.revealMnemonic': (passphrase: string, dir: string) => revealMnemonic(passphrase, dir),

  'identity.resetDevice': (dir: string) => queueSessionWork(async () => {
    await closeSession()
    identity = null
    fs.rmSync(dir, { recursive: true, force: true })
  }),

  'identity.hostPairing': async () => {
    stopHostedPairing?.()
    // If a session is active, gather its state so the joining device gets all rooms.
    const snapshot = session ? await session.getPairingSnapshot() : undefined
    stopHostedPairing = hostPairing(
      requireIdentity(),
      (code) => pushEvent('pairingCode', { code }),
      () => {
        pushEvent('pairingDone')
        stopHostedPairing = null
      },
      snapshot
    )
  },

  'identity.stopPairing': () => {
    stopHostedPairing?.()
    stopHostedPairing = null
  },

  'identity.pair': async (code: string, passphrase: string, dir: string) => {
    const parsed = decodePairingCode(code)
    if (!parsed) throw new Error('invalid pairing code')
    const result = await joinPairing(parsed)
    identity = pairIdentity(result.keypair, passphrase, dir)
    pendingPairingSnapshot = result.snapshot ?? null
    return { id: identity.id }
  },

  'session.create': (dir: string, dhtPort?: number) => queueSessionWork(async () => {
    // A session left over from an earlier attempt (or from a login the UI gave up waiting on)
    // still holds the storage; hand it back before opening the same directory again.
    await closeSession()
    const events: SessionEvents = {
      onPresence: (m) => pushEvent('presence', m),
      onPeerConnected: () => pushEvent('peerConnected'),
      onPeerDisconnected: (pk) => pushEvent('peerDisconnected', { userId: b4a.toString(pk, 'hex') }),
      onContactsChange: () => pushEvent('contactsChange'),
      onDirectoryChange: () => pushEvent('directoryChange'),
      onBookmarksChange: () => pushEvent('bookmarksChange'),
      onIncomingMessage: (roomId, message) => pushEvent('incomingMessage', { roomId, message }),
      onTyping: (m) => pushEvent('typing', m),
      onReadReceipt: (m) => pushEvent('readReceipt', m)
    }
    storageDir = dir
    // No `createLanDiscovery` here — see `SwarmTransport.createLanDiscovery` in swarm.ts. It
    // pulls in `multicast-dns`, which does a bare `require('dgram')` with no Bare-native shim,
    // and `bare-pack` bails on that at bundle time, breaking the Android build entirely.
    const opened = await Session.create(requireIdentity(), dir, { events, transport: { dhtPort } })
    session = opened
    // If a pairing snapshot was received, import it now — before the UI calls
    // reopenBookmarkedRooms — so the bookmarks and keys are in the ProfileStore.
    if (pendingPairingSnapshot) {
      await opened.importPairingSnapshot(pendingPairingSnapshot)
      pendingPairingSnapshot = null
    }
    return {
      nickname: opened.getNickname(),
      avatar: opened.getAvatar(),
      bookmarks: opened.listBookmarks(),
      contacts: opened.listContacts(),
      peerAvatars: [...opened.listPeerAvatars()]
    }
  }),

  'session.reopenBookmarkedRooms': async () => {
    const rooms = await requireSession().reopenBookmarkedRooms()
    for (const room of rooms) wireRoom(room)
  },



  /** Loopback URL a native player can stream from — see worklet/media-server.ts. The bytes
   * never cross the IPC bridge; only this address does. */
  'media.url': async (driveKey: string, filePath: string) => {
    if (!mediaServer) {
      // Loaded here rather than at the top of the file. The server pulls in bare-http1, whose
      // transport addons have to be compiled into the app — and when they are not, the failure
      // is a module load. At the top that took the entire app down before it could start, over
      // a feature that is optional; here it is just playback that fails.
      const { WorkletMediaServer } = await import('./media-server.js')
      mediaServer = WorkletMediaServer.start(requireSession())
    }
    return (await mediaServer).url(driveKey, filePath)
  },


  // Bookmark + latest-message-time per room, for the room list's unread dot/preview/sort.
  // Mirrors desktop's own full-history scan (app-shell.ts notifyIncomingMessage backfill) — same cost, same result.
  'session.listRoomSummaries': async () => {
    const session = requireSession()
    const summaries = []
    for (const bookmark of session.listBookmarks()) {
      const room = session.getRoom(bookmark.id)
      let lastMessageTime: number | null = null
      let lastMessageText: string | null = null
      let lastMessageAuthor: string | null = null
      // Walk from the newest message backward and stop at the first non-deleted one, instead
      // of decrypting the room's entire history just to find its tail — this used to be O(all
      // messages in every room) on every call (app start, each incoming message, any room's
      // meta change), which got very slow in rooms with a real amount of history.
      if (room) {
        for (let i = room.messageCount - 1; i >= 0; i--) {
          const m = await room.getMessage(i)
          if (m.deleted) continue
          lastMessageTime = m.timestamp
          lastMessageText = m.file ? `Shared ${m.file.name}` : m.body
          lastMessageAuthor = m.authorId
          break
        }
      }
      summaries.push({ ...bookmark, lastMessageTime, lastMessageText, lastMessageAuthor })
    }
    return summaries
  },

  'session.listPeerAvatars': () => [...requireSession().listPeerAvatars()],

  'session.createRoom': async (name: string, isPublic: boolean, avatar: string, description: string, broadcast = false) => {
    const room = await requireSession().createRoom(name, isPublic, avatar, description, broadcast)
    wireRoom(room)
    return { roomId: room.id }
  },

  'session.ensurePersonalVault': async () => {
    const room = await requireSession().ensurePersonalVault()
    wireRoom(room)
    return { roomId: room.id }
  },

  'session.joinRoomByKey': async (name: string, key: string) => {
    const room = await requireSession().joinRoomByKey(name, key)
    wireRoom(room)
    return { roomId: room.id }
  },


  'session.acceptContactInvite': async (invite: { from: string; name: string; key: string }) => {
    const room = await requireSession().acceptContactInvite(invite)
    wireRoom(room)
    return { roomId: room.id }
  },



  // Explicit pull, not just the 'roomState' push from wireRoom — that push fires the instant
  // the room is created/joined, before RN has had a chance to construct the RoomProxy that
  // would listen for it, so it's silently lost. Rooms whose writable/hasKey never change again
  // afterward (e.g. a room you just created, already fully writable) would otherwise be stuck
  // showing as not-writable forever.
  'room.getState': (roomId: string) => roomState(requireRoom(roomId)),

  'room.setBroadcast': (roomId: string, enabled: boolean) => requireRoom(roomId).setBroadcast(enabled),

  'room.listMembers': (roomId: string) => {
    const room = requireRoom(roomId)
    return {
      members: room.listMembers(),
      ownerId: room.ownerId,
      admins: room.listAdmins(),
      moderators: room.listModerators(),
      muted: room.listMuted(),
      banned: room.listBanned()
    }
  },

  // start/end page the room's message log (see room.ts) instead of dumping the whole
  // history through the bridge on every room open.
  'room.messages': async (roomId: string, start?: number | null, end?: number | null) => {
    // args cross the bridge as JSON, which turns a trailing `undefined` into `null` — coerce
    // back so Room.messages()'s start=0/end=messageCount defaults still kick in.
    const out = []
    for await (const msg of requireRoom(roomId).messages(start ?? undefined, end ?? undefined)) out.push(msg)
    return out
  },
  'room.messageCount': (roomId: string) => requireRoom(roomId).messageCount,
  'room.getMessage': (roomId: string, index: number) => requireRoom(roomId).getMessage(index),
  'room.send': (roomId: string, authorId: string, body: string, replyTo?: string) => requireRoom(roomId).send(authorId, body, replyTo),
  'room.editMessage': (roomId: string, id: string, body: string) => requireRoom(roomId).editMessage(id, body),
  'room.deleteMessage': (roomId: string, id: string) => requireRoom(roomId).deleteMessage(id),
  'room.toggleReaction': (roomId: string, userId: string, messageId: string, emoji: string) => requireRoom(roomId).toggleReaction(userId, messageId, emoji),

  // Trailing `binary` param is the file's raw bytes, appended by handleRequest() — see the
  // bare-rpc frame layout at the top of this file. No base64 args() field: RN sends the file
  // as the frame's binary tail instead.
  'room.sendFile': async (roomId: string, authorId: string, name: string, mimeType: string, thumbnail: string | undefined, body: string | undefined, binary: Uint8Array) => {
    const room = requireRoom(roomId)
    const fileStore = await requireSession().fileStore()
    const drivePath = `/${roomId}/${Date.now()}-${name}`
    const shared = await fileStore.addBuffer(drivePath, b4a.from(binary))
    return room.sendFile(authorId, { driveKey: b4a.toString(fileStore.key, 'hex'), path: shared.path, size: shared.size, name, mimeType, thumbnail }, body || '')
  },

  'room.sendTyping': (roomId: string, userId: string, typing: boolean) => {
    for (const peer of requireSession().peers.values()) peer.rpc.sendTyping({ roomId, userId, typing })
  },

  'room.sendReadReceipt': (roomId: string, userId: string, messageId: string) => {
    for (const peer of requireSession().peers.values()) peer.rpc.sendReadReceipt({ roomId, userId, messageId })
  },

  'room.listFiles': (roomId: string) => requireRoom(roomId).listFiles(),

  'room.downloadRoomFile': async (_roomId: string, filePath: string, driveKey: string) => {
    const buffer = await requireSession().downloadFile(driveKey, filePath)
    return buffer ? { __binary: true as const, result: { found: true }, binary: buffer } : { found: false }
  },

  // Returns the file's raw bytes as the reply's binary tail instead of a base64 string —
  // see the __binary convention in handleRequest() above.
  'files.download': async (driveKeyHex: string, drivePath: string) => {
    const buffer = await requireSession().downloadFile(driveKeyHex, drivePath)
    return buffer ? { __binary: true as const, result: { found: true }, binary: buffer } : { found: false }
  }
}

pushEvent('ready')
