import type { Session } from './session.js'
import type { Room } from '../rooms/room.js'

/**
 * The seam between the desktop UI and the core.
 *
 * `app-shell.ts` holds a `Session` and a `Room` and reaches into them from 84 call sites, which
 * makes every one of those a private agreement with the core's entire surface. That is fine while
 * the two live in the same process — and it is exactly what stops them from not living in the same
 * process. Mobile already runs this core inside a Bare worklet and drives it through a proxy
 * (`mobile/src/bare/session-contract.ts`); the desktop cannot follow while its UI depends on the
 * classes themselves rather than on what it actually uses of them.
 *
 * So this file states that surface once. Nothing changes at runtime and nothing is re-implemented:
 * the types are `Pick`ed from the real classes, so a renamed or deleted member fails the build here
 * — in one place, with a name — instead of at whichever call site happened to touch it.
 *
 * The rule for anything added later: if the UI needs it, it goes in here first. A call that
 * bypasses the view is a call the worker will not be able to serve.
 */

/** What the UI uses of a `Room`. Deliberately narrow: `base`, the Autobase handle, is absent — a
 * remote room has no Autobase to hand over, only the state derived from one. */
export type RoomView = Pick<Room,
  | 'id'
  | 'avatar'
  | 'description'
  | 'writable'
  | 'hasKey'
  | 'messageCount'
  | 'messages'
  | 'getMessage'
  | 'send'
  | 'sendFile'
  | 'editMessage'
  | 'toggleReaction'
  | 'listMembers'
  | 'listFiles'
  | 'listBanned'
  | 'isOwner'
  | 'isAdmin'
  | 'listAdmins'
  | 'isModerator'
  | 'isMuted'
  | 'isBanned'
  | 'isBroadcast'
  | 'canPost'
  | 'canModerate'
  | 'onMessage'
  | 'onFilesChange'
  | 'onKeyChange'
  | 'onWritableChange'
>

/** The rest of `Session`'s surface, minus the members that hand back a `Room` — those are restated
 * below in terms of `RoomView`, since a worker can return a room's *state* but never the object. */
type SessionMembers = Pick<Session,
  | 'peers'
  | 'close'
  | 'fileStore'
  | 'downloadFile'
  | 'listDirectory'
  | 'removeFromDirectory'
  | 'findOrphanBlobs'
  | 'deleteBlobs'
  | 'getNetworkStatus'
  | 'broadcastPresence'
  | 'getNickname'
  | 'setNickname'
  | 'getAvatar'
  | 'setAvatar'
  | 'getPeerAvatar'
  | 'listPeerAvatars'
  | 'getWallpaper'
  | 'setWallpaper'
  | 'getAppBackground'
  | 'setAppBackground'
  | 'listBookmarks'
  | 'deleteRoom'
  | 'markRoomRead'
  | 'isRoomFavorite'
  | 'setRoomFavorite'
  | 'setRoomBroadcast'
  | 'updateRoomMeta'
  | 'clearRoomHistory'
  | 'restoreRoomHistory'
  | 'deleteMessage'
  | 'inviteLinkFor'
  | 'regenerateInvite'
  | 'listContacts'
  | 'deleteContact'
  | 'sendContactRequest'
  | 'respondToContact'
  | 'createContactInvite'
  | 'muteMember'
  | 'unmuteMember'
  | 'banMember'
  | 'unbanMember'
  | 'promoteToModerator'
  | 'demoteModerator'
  | 'promoteToAdmin'
  | 'demoteAdmin'
  | 'getPairingSnapshot'
  | 'importPairingSnapshot'
>

export interface SessionView extends SessionMembers {
  mediaUrl(driveKeyHex: string, drivePath: string): Promise<string>
  getRoom(roomId: string): RoomView | undefined
  createRoom(name: string, isPublic?: boolean, avatar?: string, description?: string, broadcast?: boolean): Promise<RoomView>
  ensurePersonalVault(): Promise<RoomView>
  joinRoomByKey(name: string, invite: string, avatar?: string, description?: string): Promise<RoomView>
  acceptContactInvite(invite: { from: string; name: string; key: string }): Promise<RoomView>
  reopenBookmarkedRooms(): Promise<RoomView[]>
  getPairingSnapshot(): Promise<Record<string, unknown>>
  importPairingSnapshot(snapshot: Record<string, unknown>): Promise<void>
}

// The two checks that keep this honest. The in-process classes must keep satisfying the view they
// are derived from — otherwise the UI has quietly grown a dependency the worker cannot serve, and
// the first sign of it would be the port failing much later.
const _sessionSatisfiesView: (session: Session) => SessionView = (session) => session
const _roomSatisfiesView: (room: Room) => RoomView = (room) => room
void _sessionSatisfiesView
void _roomSatisfiesView

/**
 * The members the UI reads *synchronously* — it calls them while building HTML strings, where
 * there is nothing to await. A worker-backed implementation cannot round-trip for these: it has to
 * answer from a local mirror kept current by pushed events, which is exactly what mobile's
 * `RoomProxy` does with `writable`/`hasKey`/`canPost`.
 *
 * Derived rather than listed, so it cannot fall out of date: hover it to see the current set. It is
 * the work item for whoever moves the core out of the renderer — everything else can simply become
 * a promise.
 */
type SyncMembers<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => Promise<unknown> ? never : K
}[keyof T]

export type MirroredSessionMembers = SyncMembers<SessionView>
export type MirroredRoomMembers = SyncMembers<RoomView>
