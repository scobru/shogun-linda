import RPC from 'bare-rpc'
import type { Duplex } from 'streamx'
import { Session, type SessionEvents } from '../app/session.js'
import type { Room, ChatMessage, FileAttachment, MemberInfo, RoomFile } from '../rooms/room.js'
import { LocalMediaServer } from '../files/media-server-node.js'
import b4a from 'b4a'
import { packFrame, unpackFrame } from '../transport/frame.js'
import type { RemoteRoomState } from '../transport/remote-room-view.js'
import type { RemoteSessionInitialState, RemoteSessionOpenOptions, WireIdentity } from '../transport/remote-session-view.js'

export function extractRoomState(room: Room): RemoteRoomState & { roomId: string } {
  return {
    roomId: room.id,
    avatar: room.avatar,
    description: room.description,
    writable: room.writable,
    hasKey: room.hasKey,
    isBroadcast: room.isBroadcast,
    messageCount: room.messageCount,
    ownerId: room.ownerId,
    admins: room.listAdmins(),
    moderators: room.listModerators(),
    muted: room.listMuted(),
    banned: room.listBanned(),
    members: room.listMembers()
  }
}

export async function extractSessionState(session: Session): Promise<RemoteSessionInitialState> {
  const inviteLinks: [string, string][] = []
  for (const bookmark of session.listBookmarks()) {
    try {
      const link = session.inviteLinkFor(bookmark.id)
      if (link) inviteLinks.push([bookmark.id, link])
    } catch {
      // Room might not be open or device is not owner
    }
  }

  let fileStoreKeyHex: string | undefined
  try {
    const fsInst = await session.fileStore()
    if (fsInst?.key) {
      fileStoreKeyHex = b4a.toString(fsInst.key, 'hex')
    }
  } catch {}

  return {
    nickname: session.getNickname(),
    avatar: session.getAvatar(),
    wallpaper: session.getWallpaper(),
    appBackground: session.getAppBackground(),
    bookmarks: session.listBookmarks(),
    contacts: session.listContacts(),
    directory: session.listDirectory(),
    peerAvatars: [...session.listPeerAvatars().entries()],
    networkStatus: session.getNetworkStatus(),
    inviteLinks,
    fileStoreKeyHex
  }
}

/**
 * Handles incoming RPC requests from the desktop UI and dispatches them
 * to the underlying `Session` and `Room` instances.
 * Also pushes state change events back over the RPC stream.
 */
export class WorkerDispatcher {
  readonly rpc: RPC
  private session: Session | null = null
  private wiredRooms = new WeakSet<Room>()
  private mediaServer: Promise<LocalMediaServer> | null = null

  constructor(stream: Duplex, session?: Session) {
    if (session) {
      this.attachSession(session)
    }

    this.rpc = new RPC(stream as any, (req: any) => {
      if (!req.reply) return // incoming event, not request
      void this.handleRequest(req)
    })
  }

  attachSession(session: Session): void {
    this.session = session

    // Hook session events to push updates to client
    const events = (session as any).events as SessionEvents || {}

    const originalBookmarks = events.onBookmarksChange
    events.onBookmarksChange = () => {
      originalBookmarks?.()
      this.pushEvent('bookmarksChange', session.listBookmarks())
    }

    const originalContacts = events.onContactsChange
    events.onContactsChange = () => {
      originalContacts?.()
      this.pushEvent('contactsChange', session.listContacts())
    }

    const originalDirectory = events.onDirectoryChange
    events.onDirectoryChange = () => {
      originalDirectory?.()
      this.pushEvent('directoryChange', session.listDirectory())
    }

    const originalPresence = events.onPresence
    events.onPresence = (msg) => {
      originalPresence?.(msg)
      if (msg?.avatar) {
        this.pushEvent('peerAvatar', { userId: msg.userId, avatar: msg.avatar })
      }
      this.pushEvent('presence', msg)
    }

    const originalIncomingMessage = events.onIncomingMessage
    events.onIncomingMessage = (roomId, msg) => {
      originalIncomingMessage?.(roomId, msg)
      this.pushEvent('incomingMessage', { roomId, message: msg })
    }

    const originalTyping = events.onTyping
    events.onTyping = (msg) => {
      originalTyping?.(msg)
      this.pushEvent('typing', msg)
    }

    const originalReadReceipt = events.onReadReceipt
    events.onReadReceipt = (msg) => {
      originalReadReceipt?.(msg)
      this.pushEvent('readReceipt', msg)
    }

    // Both carry payloads that cannot cross — a live `PeerConnection`, a `Buffer` — and neither
    // needs to: the UI ignores the argument and only redraws. So the event travels empty, and
    // the network counters it redraws from ride along as fresh state.
    const originalPeerConnected = events.onPeerConnected
    events.onPeerConnected = (peer) => {
      originalPeerConnected?.(peer)
      this.pushEvent('peerConnected', { networkStatus: session.getNetworkStatus() })
    }

    const originalPeerDisconnected = events.onPeerDisconnected
    events.onPeerDisconnected = (publicKey) => {
      originalPeerDisconnected?.(publicKey)
      this.pushEvent('peerDisconnected', { networkStatus: session.getNetworkStatus() })
    }
  }

  pushEvent(event: string, payload?: unknown): void {
    this.rpc.event(0).send(packFrame({ event, payload }) as any)
  }

  pushRoomState(room: Room): void {
    this.pushEvent('roomState', extractRoomState(room))
  }

  wireRoom(room: Room): void {
    if (this.wiredRooms.has(room)) return
    this.wiredRooms.add(room)

    room.onMessage((index) => {
      this.pushEvent('roomMessage', { roomId: room.id, index })
    })

    room.onFilesChange(() => {
      this.pushEvent('roomFilesChange', { roomId: room.id })
    })

    room.onKeyChange((epoch, keyHex) => {
      this.pushRoomState(room)
      this.pushEvent('roomKeyChange', { roomId: room.id, epoch, keyHex })
    })

    room.onWritableChange(() => {
      this.pushRoomState(room)
      this.pushEvent('roomWritableChange', { roomId: room.id })
    })

    room.onMetaChange(() => {
      this.pushRoomState(room)
    })

    this.pushRoomState(room)
  }

  private requireSession(): Session {
    if (!this.session) throw new Error('Worker session is not initialized')
    return this.session
  }

  private requireRoom(roomId: string): Room {
    const room = this.requireSession().getRoom(roomId)
    if (!room) throw new Error(`Unknown room ${roomId}`)
    this.wireRoom(room)
    return room
  }

  private async handleRequest(req: any): Promise<void> {
    const { header, binary } = unpackFrame(req.data)
    try {
      const handler = this.handlers[header.method]
      if (!handler) throw new Error(`Unknown RPC method: ${header.method}`)
      const raw = await handler(...(header.args || []), binary)
      const isBinary = raw && typeof raw === 'object' && raw.__binary === true
      req.reply(
        packFrame(
          { ok: true, result: isBinary ? raw.result : raw },
          isBinary ? raw.binary : undefined
        )
      )
    } catch (err) {
      req.reply(packFrame({ ok: false, error: (err as Error).message || String(err) }))
    }
  }

  private handlers: Record<string, (...args: any[]) => any> = {
    /**
     * Opens the session inside the worker. Nothing else could: `entry.ts` starts the dispatcher
     * with no session, and every other handler needs one, so before this existed a worker-backed
     * UI could not get past its first call.
     *
     * Idempotent by design — the renderer re-sends it on reconnect, and a second open would strand
     * the first session holding the storage lock.
     */
    'session.open': async (identity: WireIdentity, storageDir: string, options?: RemoteSessionOpenOptions) => {
      if (this.session) return await extractSessionState(this.session)
      const session = await Session.create(
        {
          id: identity.id,
          publicKey: b4a.from(identity.publicKey, 'hex'),
          secretKey: b4a.from(identity.secretKey, 'hex')
        },
        storageDir,
        { events: {}, transport: { dhtPort: options?.dhtPort, bootstrap: options?.bootstrap } }
      )
      this.attachSession(session)
      for (const room of await session.reopenBookmarkedRooms()) this.wireRoom(room)
      return await extractSessionState(session)
    },

    'session.getState': async () => {
      return await extractSessionState(this.requireSession())
    },

    'session.close': async () => {
      if (this.mediaServer) {
        try { (await this.mediaServer).close() } catch {}
        this.mediaServer = null
      }
      await this.requireSession().close()
    },

    'session.createRoom': async (
      name: string,
      isPublic = false,
      avatar = '',
      description = '',
      broadcast = false
    ) => {
      const room = await this.requireSession().createRoom(name, isPublic, avatar, description, broadcast)
      this.wireRoom(room)
      let inviteLink = ''
      try {
        if (room.isOwner(this.requireSession().identity.id)) {
          inviteLink = this.requireSession().inviteLinkFor(room.id)
        }
      } catch {}
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { roomId: room.id, state: extractRoomState(room), inviteLink, bookmarks }
    },

    'session.ensurePersonalVault': async () => {
      const room = await this.requireSession().ensurePersonalVault()
      this.wireRoom(room)
      let inviteLink = ''
      try {
        if (room.isOwner(this.requireSession().identity.id)) {
          inviteLink = this.requireSession().inviteLinkFor(room.id)
        }
      } catch {}
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { roomId: room.id, state: extractRoomState(room), inviteLink, bookmarks }
    },

    'session.joinRoomByKey': async (
      name: string,
      invite: string,
      avatar?: string,
      description?: string
    ) => {
      const room = await this.requireSession().joinRoomByKey(name, invite, avatar, description)
      this.wireRoom(room)
      let inviteLink = ''
      try {
        if (room.isOwner(this.requireSession().identity.id)) {
          inviteLink = this.requireSession().inviteLinkFor(room.id)
        }
      } catch {}
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { roomId: room.id, state: extractRoomState(room), inviteLink, bookmarks }
    },

    'session.acceptContactInvite': async (invite: { from: string; name: string; key: string }) => {
      const room = await this.requireSession().acceptContactInvite(invite)
      this.wireRoom(room)
      let inviteLink = ''
      try {
        if (room.isOwner(this.requireSession().identity.id)) {
          inviteLink = this.requireSession().inviteLinkFor(room.id)
        }
      } catch {}
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { roomId: room.id, state: extractRoomState(room), inviteLink, bookmarks }
    },

    'session.reopenBookmarkedRooms': async () => {
      const rooms = await this.requireSession().reopenBookmarkedRooms()
      for (const room of rooms) this.wireRoom(room)
      const bookmarks = this.requireSession().listBookmarks()
      return rooms.map((room) => {
        let inviteLink = ''
        try {
          if (room.isOwner(this.requireSession().identity.id)) {
            inviteLink = this.requireSession().inviteLinkFor(room.id)
          }
        } catch {}
        return { roomId: room.id, state: extractRoomState(room), inviteLink, bookmarks }
      })
    },

    'session.getPairingSnapshot': async () => {
      return await this.requireSession().getPairingSnapshot()
    },

    'session.importPairingSnapshot': async (snapshot: Record<string, unknown>) => {
      await this.requireSession().importPairingSnapshot(snapshot)
    },

    'session.deleteRoom': async (roomId: string) => {
      await this.requireSession().deleteRoom(roomId)
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { bookmarks }
    },

    'session.markRoomRead': (roomId: string) => {
      this.requireSession().markRoomRead(roomId)
      this.pushEvent('bookmarksChange', this.requireSession().listBookmarks())
    },

    'session.setRoomFavorite': async (roomId: string, favorite: boolean) => {
      await this.requireSession().setRoomFavorite(roomId, favorite)
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { bookmarks }
    },

    'session.setRoomBroadcast': async (roomId: string, broadcast: boolean) => {
      await this.requireSession().setRoomBroadcast(roomId, broadcast)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.updateRoomMeta': async (
      roomId: string,
      opts: { name?: string; avatar?: string; description?: string }
    ) => {
      await this.requireSession().updateRoomMeta(roomId, opts)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
      const bookmarks = this.requireSession().listBookmarks()
      this.pushEvent('bookmarksChange', bookmarks)
      return { bookmarks }
    },

    'session.clearRoomHistory': (roomId: string) => {
      this.requireSession().clearRoomHistory(roomId)
      this.pushEvent('bookmarksChange', this.requireSession().listBookmarks())
    },

    'session.restoreRoomHistory': (roomId: string) => {
      this.requireSession().restoreRoomHistory(roomId)
      this.pushEvent('bookmarksChange', this.requireSession().listBookmarks())
    },

    'session.deleteMessage': async (roomId: string, messageId: string) => {
      await this.requireSession().deleteMessage(roomId, messageId)
    },

    'session.removeFromDirectory': (roomId: string) => {
      this.requireSession().removeFromDirectory(roomId)
    },

    'session.broadcastPresence': (online = true) => {
      this.requireSession().broadcastPresence(online)
    },

    'session.regenerateInvite': (roomId: string) => {
      const link = this.requireSession().regenerateInvite(roomId)
      return { inviteLink: link }
    },

    'session.setNickname': async (nickname: string) => {
      await this.requireSession().setNickname(nickname)
    },

    'session.setAvatar': async (avatar: string) => {
      await this.requireSession().setAvatar(avatar)
    },

    'session.setWallpaper': async (wallpaperId: string) => {
      await this.requireSession().setWallpaper(wallpaperId)
    },

    'session.setAppBackground': async (backgroundId: string) => {
      await this.requireSession().setAppBackground(backgroundId)
    },

    'session.deleteContact': async (userId: string) => {
      await this.requireSession().deleteContact(userId)
    },

    'session.sendContactRequest': async (userId: string, nickname: string) => {
      return this.requireSession().sendContactRequest(userId, nickname)
    },

    'session.respondToContact': async (userId: string, accept: boolean) => {
      await this.requireSession().respondToContact(userId, accept)
    },

    'session.createContactInvite': async () => {
      return this.requireSession().createContactInvite()
    },

    'session.muteMember': async (roomId: string, identityId: string) => {
      await this.requireSession().muteMember(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.unmuteMember': async (roomId: string, identityId: string) => {
      await this.requireSession().unmuteMember(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.banMember': async (roomId: string, writerKeyHex: string, identityId: string) => {
      await this.requireSession().banMember(roomId, writerKeyHex, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.unbanMember': async (roomId: string, identityId: string) => {
      await this.requireSession().unbanMember(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.promoteToModerator': async (roomId: string, identityId: string) => {
      await this.requireSession().promoteToModerator(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.demoteModerator': async (roomId: string, identityId: string) => {
      await this.requireSession().demoteModerator(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.promoteToAdmin': async (roomId: string, identityId: string) => {
      await this.requireSession().promoteToAdmin(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.demoteAdmin': async (roomId: string, identityId: string) => {
      await this.requireSession().demoteAdmin(roomId, identityId)
      const room = this.requireSession().getRoom(roomId)
      if (room) this.pushRoomState(room)
    },

    'session.findOrphanBlobs': async () => {
      return this.requireSession().findOrphanBlobs()
    },

    'session.deleteBlobs': async (blobKeys: string[]) => {
      return this.requireSession().deleteBlobs(blobKeys)
    },

    'files.download': async (driveKeyHex: string, drivePath: string) => {
      const buf = await this.requireSession().downloadFile(driveKeyHex, drivePath)
      if (!buf) {
        return { __binary: true, result: { found: false }, binary: new Uint8Array(0) }
      }
      return {
        __binary: true,
        result: { found: true },
        binary: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      }
    },

    'files.upload': async (drivePath: string, binary: Uint8Array) => {
      const fileStore = await this.requireSession().fileStore()
      const shared = await fileStore.addBuffer(drivePath, b4a.from(binary))
      return {
        driveKey: b4a.toString(fileStore.key, 'hex'),
        path: shared.path,
        size: shared.size
      }
    },

    'media.url': async (driveKeyHex: string, drivePath: string) => {
      if (!this.mediaServer) {
        this.mediaServer = LocalMediaServer.start(this.requireSession())
      }
      return (await this.mediaServer).url(driveKeyHex, drivePath)
    },

    // Room methods
    'room.getState': (roomId: string) => {
      return extractRoomState(this.requireRoom(roomId))
    },

    'room.getMessage': async (roomId: string, index: number) => {
      return this.requireRoom(roomId).getMessage(index)
    },

    'room.messages': async (roomId: string, start?: number, end?: number) => {
      const room = this.requireRoom(roomId)
      const list: ChatMessage[] = []
      for await (const msg of room.messages(start, end)) {
        list.push(msg)
      }
      return list
    },

    'room.send': async (roomId: string, authorId: string, body: string, replyTo?: string) => {
      return this.requireRoom(roomId).send(authorId, body, replyTo)
    },

    'room.sendFile': async (
      roomId: string,
      authorId: string,
      file: FileAttachment,
      body = ''
    ) => {
      return this.requireRoom(roomId).sendFile(authorId, file, body)
    },

    'room.editMessage': async (roomId: string, messageId: string, body: string) => {
      await this.requireRoom(roomId).editMessage(messageId, body)
    },

    'room.toggleReaction': async (
      roomId: string,
      userId: string,
      messageId: string,
      emoji: string
    ) => {
      await this.requireRoom(roomId).toggleReaction(userId, messageId, emoji)
    },

    'room.listFiles': async (roomId: string) => {
      return this.requireRoom(roomId).listFiles()
    }
  }
}
