import type Corestore from 'corestore'
import Hyperbee from 'hyperbee'

export interface RoomBookmark {
  id: string
  name: string
  bootstrapKey: string
  avatar?: string
  description?: string
  /** Physical corestore namespace this room's data lives under. Owner-created rooms pick a random namespace before the canonical (bootstrapKey-derived) `id` is known, so it must be persisted separately and reused on reopen — passing `id` instead opens an empty namespace. Absent on old bookmarks / joined rooms, where namespace already equals `id`. */
  storeId?: string
  /** Epoch ms this room was last opened/viewed. A room is unread when its latest message postdates this. Absent = never read. */
  lastReadAt?: number
  /** Pins the room to the Favorites filter. Local to this device, like `lastReadAt` — it is a
   * view preference, not something the room's other members have any business seeing. */
  favorite?: boolean
  /** Set on the room behind an unclaimed contact link. Cleared the moment someone joins, which
   * is also when the room stops being a placeholder and becomes that person's direct chat. */
  contactInvite?: boolean
  /** The invite code this device joined with, kept only while the room is still read-only here.
   * The owner is the only one who can grant write access, and the code is what gets a returning
   * member past that gate — so a rejoin made while the owner is away has to be able to present it
   * again on the next run. Held in memory alone, it died with the process and the background
   * retry then asked forever with an empty code. Cleared as soon as write access lands, so a
   * member removed later still needs a fresh invite rather than replaying this one. */
  inviteCode?: string
  /** Epoch ms of the last "Clear Chat History" — local-only, this device's view of the room only. Messages
   * at or before this point are hidden from the message list; the replicated log itself is untouched, so
   * they're still there for other members/devices and reappear here if this bookmark is ever reset. */
  clearedAt?: number
  /** Flags this room as the user's sovereign Personal Vault for private files and notes. */
  isVault?: boolean
}


/** A contact response we owe a peer but haven't managed to hand to a live socket yet. */
export interface PendingContactResponse {
  accepted: boolean
  roomId: string
  name: string
  bootstrapKey: string
  inviteCode: string
}

export interface ContactEntry {
  userId: string
  nickname: string
  /** `declined` is a tombstone: hidden from `Session.listContacts()`, kept only until its
   * pending refusal reaches the peer, then dropped. */
  status: 'outgoing' | 'incoming' | 'accepted' | 'declined'
  roomId?: string
  avatar?: string
  pendingResponse?: PendingContactResponse
}

export interface StoredRoomKey {
  roomId: string
  epoch: number
  keyHex: string
}

export interface StoredInviteToken {
  roomId: string
  code: string
  usedCount: number
}

export class ProfileStore {
  private constructor(
    private readonly profile: Hyperbee<string>,
    private readonly bookmarks: Hyperbee<RoomBookmark>,
    private readonly contacts: Hyperbee<ContactEntry>,
    private readonly keys: Hyperbee<StoredRoomKey>,
    private readonly invites: Hyperbee<StoredInviteToken>,
    private readonly peerAvatars: Hyperbee<string>
  ) {}

  static async open(store: Corestore): Promise<ProfileStore> {
    const profile = new Hyperbee<string>(store.get({ name: 'profile' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    const bookmarks = new Hyperbee<RoomBookmark>(store.get({ name: 'bookmarks' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    const contacts = new Hyperbee<ContactEntry>(store.get({ name: 'contacts' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    const keys = new Hyperbee<StoredRoomKey>(store.get({ name: 'room_keys' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    const invites = new Hyperbee<StoredInviteToken>(store.get({ name: 'room_invites' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    const peerAvatars = new Hyperbee<string>(store.get({ name: 'peer_avatars' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await Promise.all([profile.ready(), bookmarks.ready(), contacts.ready(), keys.ready(), invites.ready(), peerAvatars.ready()])
    return new ProfileStore(profile, bookmarks, contacts, keys, invites, peerAvatars)
  }

  /** Writes that no caller is awaiting. Most of the store's writers are fire-and-forget — a
   * peer's avatar arriving over RPC, a room key learned mid-session — because nothing in the UI
   * waits on them. That is fine right up until `Session.close()` tears the corestore down while
   * one is still in flight, which rejects with "cannot append to a closed session" and, with no
   * caller to catch it, takes the process down as an unhandled rejection. Holding the promises
   * here lets `flush()` drain them first. */
  private readonly inFlight = new Set<Promise<unknown>>()

  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work)
    // The rejection is the caller's to handle; this copy exists only to keep the set from
    // leaking, and must not itself become a second unhandled rejection.
    void work.catch(() => {}).then(() => { this.inFlight.delete(work) })
    return work
  }

  /** Settles every write still in flight. Call before closing the corestore underneath. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      const draining = [...this.inFlight]
      await Promise.allSettled(draining)
      for (const work of draining) this.inFlight.delete(work)
    }
  }

  async getNickname(): Promise<string> {
    return (await this.profile.get('nickname'))?.value ?? ''
  }

  async setNickname(nickname: string): Promise<void> {
    await this.track(this.profile.put('nickname', nickname))
  }

  /** Chat background id (see `src/ui/wallpapers.ts`). Local to this device — nobody else's
   * business what your chat looks like. */
  async getWallpaper(): Promise<string> {
    return (await this.profile.get('wallpaper'))?.value ?? ''
  }

  async setWallpaper(id: string): Promise<void> {
    await this.track(this.profile.put('wallpaper', id))
  }

  /** App shell background id (see `src/ui/app-backgrounds.ts`). Local to this device, same as
   * wallpaper — just the canvas behind the sidebar/chat panel instead of behind messages. */
  async getAppBackground(): Promise<string> {
    return (await this.profile.get('appBackground'))?.value ?? ''
  }

  async setAppBackground(id: string): Promise<void> {
    await this.track(this.profile.put('appBackground', id))
  }

  static readonly MAX_AVATAR_BYTES = 64 * 1024

  async getAvatar(): Promise<string> {
    return (await this.profile.get('avatar'))?.value ?? ''
  }

  async setAvatar(avatar: string): Promise<void> {
    if (avatar && avatar.length > ProfileStore.MAX_AVATAR_BYTES) {
      console.warn(`[profile-store] avatar too large (${avatar.length} bytes), max is ${ProfileStore.MAX_AVATAR_BYTES}`)
      return
    }
    await this.track(this.profile.put('avatar', avatar))
  }

  async getPeerAvatar(userId: string): Promise<string> {
    const val = (await this.peerAvatars.get(userId))?.value ?? ''
    return val.length <= ProfileStore.MAX_AVATAR_BYTES ? val : ''
  }

  async setPeerAvatar(userId: string, avatar: string): Promise<void> {
    if (!avatar || avatar.length > ProfileStore.MAX_AVATAR_BYTES) return
    await this.track(this.peerAvatars.put(userId, avatar))
  }

  async listPeerAvatars(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for await (const node of this.peerAvatars.createReadStream()) {
      if (node.key && node.value) {
        if (node.value.length <= ProfileStore.MAX_AVATAR_BYTES) {
          map.set(node.key, node.value)
        } else {
          // Prune legacy bloated avatar from disk so it never bloats IPC again
          void this.track(this.peerAvatars.del(node.key))
        }
      }
    }
    return map
  }

  async listBookmarks(): Promise<RoomBookmark[]> {
    const out: RoomBookmark[] = []
    for await (const node of this.bookmarks.createReadStream()) out.push(node.value)
    return out
  }

  async saveBookmark(bookmark: RoomBookmark): Promise<void> {
    await this.track(this.bookmarks.put(bookmark.id, bookmark))
  }

  async removeBookmark(id: string): Promise<void> {
    await this.track(this.bookmarks.del(id))
  }

  async listContacts(): Promise<ContactEntry[]> {
    const out: ContactEntry[] = []
    for await (const node of this.contacts.createReadStream()) out.push(node.value)
    return out
  }

  async saveContact(contact: ContactEntry): Promise<void> {
    await this.track(this.contacts.put(contact.userId, contact))
  }

  async removeContact(userId: string): Promise<void> {
    await this.track(this.contacts.del(userId))
  }

  async saveRoomKey(roomId: string, epoch: number, keyHex: string): Promise<void> {
    await this.track(this.keys.put(`${roomId}:${epoch}`, { roomId, epoch, keyHex }))
  }

  async getRoomKeys(roomId: string): Promise<StoredRoomKey[]> {
    const out: StoredRoomKey[] = []
    const prefix = `${roomId}:`
    for await (const node of this.keys.createReadStream({ gte: prefix, lt: prefix + '\uffff' })) {
      if (node.value) out.push(node.value)
    }
    return out
  }

  async saveInviteToken(token: StoredInviteToken): Promise<void> {
    await this.track(this.invites.put(token.roomId, token))
  }

  async getInviteToken(roomId: string): Promise<StoredInviteToken | null> {
    return (await this.invites.get(roomId))?.value ?? null
  }

  async listInviteTokens(): Promise<StoredInviteToken[]> {
    const out: StoredInviteToken[] = []
    for await (const node of this.invites.createReadStream()) out.push(node.value)
    return out
  }

}
