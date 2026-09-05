import { bareClient } from './client'
import { RoomProxy } from './room-proxy'
import type { RoomBookmark, ContactEntry } from '@core/app/session'
import type { RoomAnnounceMessage } from '@core/network/encoding'
import { FORWARDED_SESSION_METHODS, type RemoteSession } from './session-contract'

export interface SessionInfo {
  nickname: string
  avatar: string
  bookmarks: RoomBookmark[]
  contacts: ContactEntry[]
  peerAvatars: [string, string][]
}

export interface RoomSummary extends RoomBookmark {
  lastMessageTime: number | null
  lastMessageText: string | null
  lastMessageAuthor: string | null
}

/** Declaration merging is what tells callers the forwarded methods exist: they are assigned in the
 * constructor rather than written out, so the class body alone cannot show them. */
export interface SessionProxy extends RemoteSession {}

export class SessionProxy {
  private rooms = new Map<string, RoomProxy>()

  constructor() {
    // Every plain Session method, forwarded by name. The contract guarantees this covers all of
    // them; anything needing more than a forward is written out below.
    for (const name of FORWARDED_SESSION_METHODS) {
      ;(this as unknown as Record<string, unknown>)[name] =
        (...args: unknown[]) => bareClient.call(`session.${name}`, ...args)
    }
  }

  getRoom(id: string): RoomProxy {
    let room = this.rooms.get(id)
    if (!room) {
      room = new RoomProxy(id)
      this.rooms.set(id, room)
    }
    return room
  }

  static async create(storageDir: string, dhtPort?: number): Promise<{ session: SessionProxy; info: SessionInfo }> {
    const info = await bareClient.call<SessionInfo>('session.create', storageDir, dhtPort)
    return { session: new SessionProxy(), info }
  }

  async reopenBookmarkedRooms(): Promise<void> {
    await bareClient.call('session.reopenBookmarkedRooms')
  }



  /** Loopback URL for streaming a shared file, served from inside the worklet. Use this for
   * playback; `downloadFile` is for saving or sharing a file whole. */
  mediaUrl(driveKey: string, filePath: string): Promise<string> {
    return bareClient.call('media.url', driveKey, filePath)
  }


  listRoomSummaries(): Promise<RoomSummary[]> {
    return bareClient.call('session.listRoomSummaries')
  }



  /** Owner/moderator only — enforced in the room's apply(). */

  /** Call after the OS reports a network change (wifi <-> cellular) — see Session.resumeNetwork. */




  async listPeerAvatars(): Promise<Map<string, string>> {
    const pairs = await bareClient.call<[string, string][]>('session.listPeerAvatars')
    return new Map(pairs)
  }





  async createRoom(name: string, isPublic = false, avatar = '', description = '', broadcast = false): Promise<RoomProxy> {
    const { roomId } = await bareClient.call<{ roomId: string }>('session.createRoom', name, isPublic, avatar, description, broadcast)
    return this.getRoom(roomId)
  }

  async ensurePersonalVault(): Promise<RoomProxy> {
    const { roomId } = await bareClient.call<{ roomId: string }>('session.ensurePersonalVault')
    return this.getRoom(roomId)
  }

  async joinRoomByKey(name: string, key: string): Promise<RoomProxy> {
    const { roomId } = await bareClient.call<{ roomId: string }>('session.joinRoomByKey', name, key)
    return this.getRoom(roomId)
  }


  async acceptContactInvite(invite: { from: string; name: string; key: string }): Promise<RoomProxy> {
    const { roomId } = await bareClient.call<{ roomId: string }>('session.acceptContactInvite', invite)
    return this.getRoom(roomId)
  }

















}
