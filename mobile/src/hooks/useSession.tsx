import React, { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import NetInfo from '@react-native-community/netinfo'
import { NOTIFICATION_CHANNEL_ID } from '../notifications'
import { startBackgroundConnection, stopBackgroundConnection } from '../foreground-service'
import { getDhtPort } from '../dht-port'
import { bareClient } from '../bare/client'
import { SessionProxy, type RoomSummary } from '../bare/session-proxy'
import type { Identity } from '../bare/identity-client'
import type { ContactEntry } from '@core/app/session'
import type { ChatMessage } from '@core/rooms/room'
import { privateModeEnabled } from '../private-mode'

interface SessionContextValue {
  session: SessionProxy | null
  identity: Identity | null
  nickname: string
  avatar: string
  bookmarks: RoomSummary[]
  contacts: ContactEntry[]
  onlineUsers: Set<string>
  nicknames: Map<string, string>
  avatars: Map<string, string>

  // Actions
  initSession: (identity: Identity, storageDir: string, opts?: { autoJoinInvite?: { name: string; key: string }[] }) => Promise<void>
  refresh: () => void
  /** Stamps a room as read in the local view, without asking the worklet for anything. */
  markRoomReadLocally: (roomId: string) => void
  /** Marks a room as the one currently on screen, so its own new-message notifications are
   * suppressed while the user is already looking at it (mirrors desktop's document-focus check). */
  setActiveRoomId: (roomId: string | null) => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be inside SessionProvider')
  return ctx
}

interface Props {
  children: ReactNode
}

export function SessionProvider({ children }: Props) {
  const [session, setSession] = useState<SessionProxy | null>(null)
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState('')
  const [bookmarks, setBookmarks] = useState<RoomSummary[]>([])
  const [contacts, setContacts] = useState<ContactEntry[]>([])
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set())
  const [nicknames, setNicknames] = useState<Map<string, string>>(new Map())
  const [avatars, setAvatars] = useState<Map<string, string>>(new Map())
  const [, setTick] = useState(0)
  const nicknamesRef = useRef(nicknames)
  useEffect(() => { nicknamesRef.current = nicknames }, [nicknames])
  const bookmarksRef = useRef(bookmarks)
  useEffect(() => { bookmarksRef.current = bookmarks }, [bookmarks])
  const activeRoomIdRef = useRef<string | null>(null)
  const setActiveRoomId = useCallback((roomId: string | null) => { activeRoomIdRef.current = roomId }, [])

  // App icon badge = count of unread rooms, same "latest message postdates lastReadAt" rule
  // RoomsScreen uses for its own unread dot/filter.
  useEffect(() => {
    const unreadCount = bookmarks.filter((b) => !!b.lastMessageTime && b.lastMessageTime > (b.lastReadAt ?? 0)).length
    void Notifications.setBadgeCountAsync(unreadCount)
  }, [bookmarks])

  const refresh = useCallback(() => {
    if (!session) return
    void (async () => {
      setBookmarks(await session.listRoomSummaries())
      setContacts(await session.listContacts())
      setNickname(await session.getNickname())
      setAvatar(await session.getAvatar())
      setAvatars(await session.listPeerAvatars())
    })().catch(() => { /* a session torn down mid-refresh has nothing to show */ })
  }, [session])

  /** The session the wired-once listeners below act on. They outlive any single login — a failed
   * one used to register another full set, so one retry meant two notifications per message and two
   * room-list rebuilds, three after the next. */
  /**
   * The unread dot and the app badge both read `lastReadAt` off the bookmarks held here, and the
   * worklet persists the same stamp on its own. Asking it to recompute every room's summary, the
   * contact list, both profile fields and the peer-avatar table just to learn a timestamp this
   * side already knows meant five bridge round trips — one of them a walk back through every
   * bookmarked room's messages — on every room open, and again a second after every message that
   * arrived while the room was open.
   */
  const markRoomReadLocally = useCallback((roomId: string) => {
    const now = Date.now()
    setBookmarks((prev) => prev.map((b) => (b.id === roomId ? { ...b, lastReadAt: now } : b)))
  }, [])

  const sessionRef = useRef<SessionProxy | null>(null)
  const eventsWired = useRef(false)
  /** The login currently running, if any. Two of them can be started for the same identity without
   * the user doing anything odd — the unlock screen auto-prompts for biometrics while its passphrase
   * field stays live — and both would have opened a session over the same storage directory, which
   * the second one cannot do: the corestore's lock is held by the first for as long as it is open.
   * Later callers join the login already in flight instead of starting a second one. */
  const loginInFlight = useRef<Promise<void> | null>(null)

  const wireEvents = useCallback(() => {
    if (eventsWired.current) return
    eventsWired.current = true

    bareClient.on('presence', (msg: { userId: string; online: boolean; nickname?: string; avatar?: string }) => {
      if (msg.online) {
        setOnlineUsers((prev) => new Set(prev).add(msg.userId))
      } else {
        setOnlineUsers((prev) => {
          const next = new Set(prev)
          next.delete(msg.userId)
          return next
        })
      }
      if (msg.nickname) setNicknames((prev) => new Map(prev).set(msg.userId, msg.nickname!))
      if (msg.avatar) setAvatars((prev) => new Map(prev).set(msg.userId, msg.avatar!))
    })
    bareClient.on('peerConnected', () => setTick((t) => t + 1))
    bareClient.on('peerDisconnected', (payload: { userId: string }) => {
      setOnlineUsers((prev) => {
        const next = new Set(prev)
        next.delete(payload.userId)
        return next
      })
    })
    bareClient.on('contactsChange', () => setTimeout(() => setTick((t) => t + 1), 0))
    bareClient.on('directoryChange', () => setTick((t) => t + 1))

    // The swarm's socket stays bound to whatever network was active when it was created — a
    // wifi <-> cellular switch otherwise leaves it trying to talk over an interface that no
    // longer routes anywhere, and peers silently stop connecting until the app is restarted.
    // Debounced: turning wifi off fires several type changes in quick succession (wifi -> none ->
    // cellular as the radio actually switches over) — waiting for it to settle avoids resyncing
    // against the momentary "none" state in between.
    let lastNetworkType: string | null = null
    let resyncTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleResync = () => {
      if (resyncTimer) clearTimeout(resyncTimer)
      resyncTimer = setTimeout(() => { resyncTimer = null; void sessionRef.current?.resumeNetwork() }, 800)
    }
    NetInfo.addEventListener((state) => {
      if (lastNetworkType === null) { lastNetworkType = state.type; return }
      if (state.type === lastNetworkType) return
      lastNetworkType = state.type
      scheduleResync()
    })

    // A phone left backgrounded for a while can have its NAT's UDP mapping expire on the
    // router's own idle timeout even though it never left wifi — NetInfo reports no type change,
    // so the listener above never fires. Peers already connected before that stay connected, but
    // a fresh hole-punch to anyone new fails silently until the socket rebinds. Resync on every
    // foreground return to cover it.
    let lastAppState = AppState.currentState
    AppState.addEventListener('change', (next) => {
      if (next === 'active' && lastAppState !== 'active') {
        scheduleResync()
        stopBackgroundConnection()
      } else if (next !== 'active' && lastAppState === 'active') {
        // Only worth holding the process up while there is a session to keep connected.
        if (sessionRef.current) startBackgroundConnection()
      }
      lastAppState = next
    })

    // Debounced refresh for room summaries: replication on startup or peer connect delivers
    // messages in bursts. Coalesce them to avoid dozens of parallel IPC queries.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void sessionRef.current?.listRoomSummaries().then(setBookmarks).catch(() => {})
      }, 250)
    }

    const initTimestamp = Date.now()

    // Refreshes the room-list preview/unread-dot for any room, active or backgrounded, and
    // fires a local notification unless the user is already looking at that exact room.
    bareClient.on('incomingMessage', (payload: { roomId: string; message: ChatMessage }) => {
      const s = sessionRef.current
      if (!s) return
      scheduleRefresh()

      if (AppState.currentState === 'active' && activeRoomIdRef.current === payload.roomId) return

      // Suppress notifications for historical messages synced at startup or older than 60s
      const msgTime = payload.message.timestamp || 0
      const isHistorical = (Date.now() - initTimestamp < 4000) || (Date.now() - msgTime > 60000)
      if (isHistorical) return

      const roomName = bookmarksRef.current?.find((b) => b.id === payload.roomId)?.name ?? 'linda-pear'
      const author = nicknamesRef.current.get(payload.message.authorId) ?? 'Someone'
      const secret = privateModeEnabled()
      void Notifications.scheduleNotificationAsync({
        content: {
          title: secret ? 'linda' : `${author} in ${roomName}`,
          body: secret
            ? 'New message'
            : payload.message.file ? 'Shared an image' : payload.message.body.slice(0, 200),
          sound: 'notification_ping.wav',
        },
        trigger: Platform.OS === 'android' ? { channelId: NOTIFICATION_CHANNEL_ID } : null,
      }).catch(() => {})
    })
    // A room's name/avatar/description edited on another device replicates in, but the local
    // bookmark cache the room list renders from only updates itself in response to this event.
    bareClient.on('bookmarksChange', () => { scheduleRefresh() })
  }, [])

  const openSession = useCallback(async (id: Identity, storageDir: string, opts?: { autoJoinInvite?: { name: string; key: string }[] }) => {
    wireEvents()

    const { session: s, info } = await SessionProxy.create(storageDir, await getDhtPort())
    sessionRef.current = s
    // Deliberately not awaited. Reopening every bookmarked room needs the network for any room
    // this device has not replicated yet, so one unreachable or half-purged room used to hold the
    // unlock screen — and the whole app — hostage behind it. The room list renders from bookmarks
    // and fills in as rooms come up.
    void s.reopenBookmarkedRooms()
      .then(() => s.ensurePersonalVault())
      .then(() => s.listRoomSummaries())
      .then(setBookmarks)
      .catch(() => {})
    // Fire-and-forget: joinRoomByKey can block ~30s waiting on the swarm (see RoomsScreen's
    // handleJoinRoom), and a brand-new identity with no peers yet may not even reach it in
    // time — fine either way, don't hold up onboarding for it. Refreshes bookmarks on success
    // since a join doesn't otherwise emit any change event mobile listens for.
    for (const invite of opts?.autoJoinInvite ?? []) {
      void s.joinRoomByKey(invite.name, invite.key).then(() => s.listRoomSummaries()).then(setBookmarks).catch(() => {})
    }

    setSession(s)
    setIdentity(id)
    setNickname(info.nickname)
    setAvatar(info.avatar)
    setBookmarks(await s.listRoomSummaries())
    setContacts(info.contacts)
    setAvatars(new Map(info.peerAvatars))

    // Deliberately last: the OS permission dialog this triggers (first run after this
    // feature shipped) pauses the Activity, and requesting it while the swarm was still
    // mid-bootstrap raced the DHT announce/lookup — fine on wifi's slack, not on cellular's
    // tighter margins. Firing it only once the session/swarm is already up sidesteps that.
    void Notifications.requestPermissionsAsync()
  }, [wireEvents])

  const initSession = useCallback((id: Identity, storageDir: string, opts?: { autoJoinInvite?: { name: string; key: string }[] }): Promise<void> => {
    const running = loginInFlight.current
    if (running) return running
    const run = openSession(id, storageDir, opts)
    loginInFlight.current = run
    return run.finally(() => {
      if (loginInFlight.current === run) loginInFlight.current = null
    })
  }, [openSession])

  // Without this, every consumer of useSession() — every screen, since every screen reads it —
  // re-renders on every presence/peer event, whether or not the fields it actually reads changed.
  // Native-stack keeps prior screens mounted underneath the active one, so on a chatty P2P
  // connection this was competing with the navigation transition itself for JS thread time.
  const value = useMemo<SessionContextValue>(() => ({
    session,
    identity,
    nickname,
    avatar,
    bookmarks,
    contacts,
    onlineUsers,
    nicknames,
    avatars,
    initSession,
    refresh,
    markRoomReadLocally,
    setActiveRoomId,
  }), [session, identity, nickname, avatar, bookmarks, contacts, onlineUsers, nicknames, avatars, initSession, refresh, markRoomReadLocally, setActiveRoomId])

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  )
}
