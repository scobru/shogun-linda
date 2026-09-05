// What of `Session` the worklet exposes, stated once.
//
// The worklet handlers and the proxy that calls them used to be two hand-written lists of string
// literals. TypeScript cannot relate one string to another, so a method added to `Session` and
// forgotten in either list produced a capability that simply did not exist on mobile — silently,
// with nothing failing. It happened twice in one week (contact links, orphaned-file cleanup).
//
// Both sides are now derived from `Session` itself. Adding a method to `Session` makes it a member
// of `ForwardedSessionMethod`, which makes `FORWARDED_SESSION_METHODS` incomplete, which fails the
// build. The choice to expose it or not becomes deliberate rather than accidental.
import type { Session } from '@core/app/session'

type MethodNames<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never
}[keyof T]

/**
 * Methods that cannot be forwarded as-is, each for a reason:
 *
 * - `close`, `fileStore`, `createFileStream`, `statFile` — worklet-internal lifecycle and streams;
 *   nothing here survives JSON.
 * - `downloadFile` — returns bytes, which ride the binary channel (`files.download`) instead.
 * - `getRoom` — returns a live `Room`; the proxy hands back a `RoomProxy` keyed by id.
 * - `createRoom`, `joinRoomByKey`, `acceptContactInvite`, `reopenBookmarkedRooms` — must call
 *   `wireRoom` on what they return, which is what connects the room's events to the UI. Hiding that
 *   behind a generic forward is exactly the bug where a rebuilt room stopped emitting state.
 * - `listPeerAvatars` — returns a `Map`, which JSON flattens to `{}`.
 */
type NotForwarded =
  | 'close'
  | 'fileStore'
  | 'createFileStream'
  | 'statFile'
  | 'downloadFile'
  | 'getRoom'
  | 'createRoom'
  | 'joinRoomByKey'
  | 'acceptContactInvite'
  | 'reopenBookmarkedRooms'
  | 'listPeerAvatars'
  | 'mediaUrl'
  | 'getAppBackground'
  | 'setAppBackground'
  | 'getPairingSnapshot'
  | 'importPairingSnapshot'
  | 'ensurePersonalVault'

export type ForwardedSessionMethod = Exclude<MethodNames<Session>, NotForwarded>

export const FORWARDED_SESSION_METHODS = [
  'banMember',
  'broadcastPresence',
  'clearRoomHistory',
  'restoreRoomHistory',
  'createContactInvite',
  'deleteBlobs',
  'deleteContact',
  'deleteMessage',
  'deleteRoom',
  'demoteAdmin',
  'demoteModerator',
  'findOrphanBlobs',
  'getAvatar',
  'getNetworkStatus',
  'getNickname',
  'getPeerAvatar',
  'getWallpaper',
  'inviteLinkFor',
  'isRoomFavorite',
  'listBookmarks',
  'listContacts',
  'listDirectory',
  'markRoomRead',
  'muteMember',
  'promoteToAdmin',
  'promoteToModerator',
  'regenerateInvite',
  'removeFromDirectory',
  'respondToContact',
  'resumeNetwork',
  'sendContactRequest',
  'setAvatar',
  'setNickname',
  'setRoomBroadcast',
  'setRoomFavorite',
  'setWallpaper',
  'unbanMember',
  'unmuteMember',
  'updateRoomMeta'
] as const satisfies readonly ForwardedSessionMethod[]

// The two checks that make the whole thing work. A new Session method fails the first with its own
// name in the error; a stale entry fails the second.
type MissingFromList = Exclude<ForwardedSessionMethod, (typeof FORWARDED_SESSION_METHODS)[number]>
const _everyMethodIsListed: [MissingFromList] extends [never]
  ? true
  : { error: 'add these to FORWARDED_SESSION_METHODS, or to NotForwarded'; missing: MissingFromList } = true
void _everyMethodIsListed

/**
 * The same surface as seen from the app side. Every call crosses a message boundary, so results
 * arrive as promises even where `Session` is synchronous.
 */
export type RemoteSession = {
  [K in ForwardedSessionMethod]: Session[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}
