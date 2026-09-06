import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  View, Text, FlatList, Pressable, StyleSheet,
  TextInput, Alert, ActionSheetIOS, Platform, Modal,
  SafeAreaView, Keyboard, ScrollView,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useFocusEffect } from '@react-navigation/native'
import * as FileSystem from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import * as Clipboard from 'expo-clipboard'
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import { Ionicons } from '@expo/vector-icons'
import type { RootStackParamList } from '../navigation'
import { useSession } from '../hooks/useSession'
import { useRoom } from '../hooks/useRoom'
import { downloadFile } from '../bare/room-proxy'
import type { ChatMessage, RoomFile } from '@core/rooms/room'
import { formatBytes } from '@core/util/bytes'
import { SvgXml } from 'react-native-svg'
import { wallpaperPatternSvg, wallpaperInk, DEFAULT_WALLPAPER } from '@core/ui/wallpapers'
import ChatBubble, { isAudioFile, isVideoFile } from '../components/ChatBubble'
import VideoPlayerModal from '../components/VideoPlayerModal'
import MessageComposer from '../components/MessageComposer'
import Avatar from '../components/Avatar'
import { extractHashtags, hasHashtag } from '@core/util/hashtag'
import { spacing, radii, typography, shadows, type ThemeColors } from '../theme'
import { useTheme } from '../theme-context'
import { usePrivateMode, redact } from '../private-mode'


function getFileIcon(name: string, mimeType?: string): keyof typeof Ionicons.glyphMap {
  if (mimeType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return 'image-outline'
  if (mimeType?.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/i.test(name)) return 'musical-notes-outline'
  if (mimeType?.startsWith('video/') || /\.(mp4|webm|mkv|mov)$/i.test(name)) return 'videocam-outline'
  if (/\.(zip|tar|gz|7z|rar)$/i.test(name)) return 'archive-outline'
  if (/\.pdf$/i.test(name) || mimeType === 'application/pdf') return 'document-text-outline'
  return 'document-outline'
}

type Props = NativeStackScreenProps<RootStackParamList, 'RoomChat'>

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥', '👀', '🎉', '💯', '🙏']

/** What a row can do, as one object whose identity never changes — see `rowActions` below. */
interface RowActions {
  onLongPress(message: ChatMessage): void
  onPress(message: ChatMessage): void
  onReaction(messageId: string, emoji: string): void
  onFilePress(message: ChatMessage): void
  onFileSave(message: ChatMessage): void
  onHashtagPress(tag: string): void
}

interface MessageRowProps {
  item: ChatMessage
  isSelf: boolean
  authorName: string
  replyPreview?: string
  selectionMode: boolean
  selected: boolean
  fileDownloading: boolean
  isAudioPlaying: boolean
  isAudioLoading: boolean
  actions: RowActions
}

/**
 * The one place the per-row closures are built. They used to be built inline in the list's
 * `renderItem`, six of them per row, which handed `ChatBubble` six new props on every render of
 * this screen and made its `React.memo` a no-op: every visible bubble re-rendered whenever
 * anything here changed — and plenty does, since presence, peer connects and nickname updates all
 * flow through `useSession` into this component. Built here instead, against props that are
 * strings, booleans and one stable object, the memo actually holds and a bubble re-renders only
 * when something about that bubble changed.
 */
const MessageRow = React.memo(function MessageRow({
  item, isSelf, authorName, replyPreview, selectionMode, selected, fileDownloading,
  isAudioPlaying, isAudioLoading, actions,
}: MessageRowProps) {
  const selectable = selectionMode && isSelf
  return (
    <ChatBubble
      message={item}
      isSelf={isSelf}
      authorName={authorName}
      replyPreview={replyPreview}
      onLongPress={() => actions.onLongPress(item)}
      onPress={selectable ? () => actions.onPress(item) : undefined}
      selected={selected}
      selectable={selectable}
      onReactionPress={(emoji) => actions.onReaction(item.id, emoji)}
      onFilePress={() => actions.onFilePress(item)}
      onFileSave={() => actions.onFileSave(item)}
      onHashtagPress={(tag) => actions.onHashtagPress(tag)}
      fileDownloading={fileDownloading}
      isAudioPlaying={isAudioPlaying}
      isAudioLoading={isAudioLoading}
    />
  )
})

export default function RoomChatScreen({ route, navigation }: Props) {
  const { colors, isDark } = useTheme()
  const styles = useMemo(() => createStyles(colors), [colors])
  const { roomName, pendingJoin } = route.params
  const [roomId, setRoomId] = useState(route.params.roomId)
  const { session, identity, nicknames, avatars, bookmarks, refresh: refreshSession, markRoomReadLocally, setActiveRoomId } = useSession()
  const { privateMode } = usePrivateMode()
  const room = roomId ? session?.getRoom(roomId) : undefined
  const identityId = identity?.id || ''
  const bookmark = bookmarks.find((b) => b.id === roomId)
  const isVault = bookmark?.isVault ?? false
  const clearedAt = bookmark?.clearedAt ?? 0
  const roomTopic = (bookmark?.description ?? '').trim()

  // Screen navigates in before the join finishes (see RoomsScreen.handleJoinRoom) — run it here
  // instead, in the background. `room` stays undefined until this resolves, so useRoom below
  // just shows its normal loading state in the meantime.
  useEffect(() => {
    if (!pendingJoin || !session) return
    let cancelled = false
    session.joinRoomByKey(pendingJoin.name, pendingJoin.key).then((joined) => {
      if (cancelled) return
      setRoomId(joined.id)
      refreshSession()
    }).catch((err) => {
      if (cancelled) return
      Alert.alert('Could not join room', (err as Error).message, [{ text: 'OK', onPress: () => navigation.goBack() }])
    })
    return () => { cancelled = true }
  }, [pendingJoin, session])
  const { messages, loading, sendMessage, sendFile, editMessage, deleteMessage, toggleReaction, refreshMessages, hasMore, loadOlder, typingUsers, notifyTyping, readBy } = useRoom(room, identityId, clearedAt)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const lastTailIdRef = useRef<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null)
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null)
  const [playingVideo, setPlayingVideo] = useState<{ uri: string; name: string } | null>(null)
  const audioPlayerRef = useRef<AudioPlayer | null>(null)

  // Mirrors desktop's openRoom: stamp read on open, and again for each message that
  // arrives while this screen is focused (mute the badge, not just a one-time clear).
  useEffect(() => {
    if (!session || !roomId) return
    void session.markRoomRead(roomId).catch(() => {})
    markRoomReadLocally(roomId)
  }, [session, roomId, markRoomReadLocally])
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!room || !session) return
    const unsub = room.onMessage(() => {
      if (markReadTimerRef.current) return
      markReadTimerRef.current = setTimeout(() => {
        markReadTimerRef.current = null
        void session.markRoomRead(room.id).catch(() => {})
        markRoomReadLocally(room.id)
      }, 1000)
    })
    return () => {
      unsub()
      if (markReadTimerRef.current) { clearTimeout(markReadTimerRef.current); markReadTimerRef.current = null }
    }
  }, [room, session, roomId, markRoomReadLocally])
  // Suppresses this room's own local notifications while it's the screen actually on top —
  // native-stack keeps it mounted underneath other pushed screens, so mount/unmount alone
  // isn't a reliable signal of visibility.
  useFocusEffect(useCallback(() => {
    setActiveRoomId(roomId ?? null)
    return () => setActiveRoomId(null)
  }, [roomId, setActiveRoomId]))

  const [writable, setWritable] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  // False when muted or in a broadcast room without admin rights — the two cases where the worklet
  // would accept the message and every peer would then drop it while linearizing the log.
  const [canPost, setCanPost] = useState(false)
  const [broadcast, setBroadcast] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'mailbox' | 'document' | 'files'>('chat')
  const [selectedMailboxMessage, setSelectedMailboxMessage] = useState<ChatMessage | null>(null)
  const [mailboxReplyText, setMailboxReplyText] = useState('')
  const [mailboxSending, setMailboxSending] = useState(false)
  const [roomFiles, setRoomFiles] = useState<RoomFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const [downloadingFilePath, setDownloadingFilePath] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    void session.getWallpaper()
      .then((id) => setWallpaperSvg(wallpaperPatternSvg(id || DEFAULT_WALLPAPER, wallpaperInk(isDark))))
      .catch(() => {})
  }, [session, isDark])

  const refreshFiles = useCallback(async () => {
    if (!room) return
    setFilesLoading(true)
    try {
      const list = await room.listFiles()
      setRoomFiles(list)
    } catch {
      // ignore
    } finally {
      setFilesLoading(false)
    }
  }, [room])

  useEffect(() => {
    if (!room) return
    const apply = (s: { writable: boolean; hasKey: boolean; canPost: boolean; broadcast?: boolean }) => {
      setWritable(s.writable)
      setHasKey(s.hasKey)
      setCanPost(s.canPost)
      setBroadcast(s.broadcast ?? false)
    }
    apply(room)
    void room.refreshState().then(apply)
    const unsubState = room.onStateChange(apply)
    const unsubFiles = room.onFilesChange(() => {
      void refreshFiles()
    })
    return () => {
      unsubState()
      unsubFiles()
    }
  }, [room, refreshFiles])

  useEffect(() => {
    if (activeTab === 'files') {
      void refreshFiles()
    }
  }, [activeTab, refreshFiles])

  const handleDownloadFile = useCallback(async (file: RoomFile) => {
    if (!room || !file.driveKey) return
    setDownloadingFilePath(file.path)
    try {
      const base64 = await room.downloadRoomFile(file.path, file.driveKey)
      if (!base64) {
        Alert.alert('Download failed', 'File not available on connected peers')
        return
      }
      const localUri = `${FileSystem.cacheDirectory}${file.name}`
      await FileSystem.writeAsStringAsync(localUri, base64, { encoding: FileSystem.EncodingType.Base64 })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri)
      } else {
        Alert.alert('Downloaded', `Saved to ${file.name}`)
      }
    } catch (err) {
      Alert.alert('Download error', (err as Error).message)
    } finally {
      setDownloadingFilePath(null)
    }
  }, [room])

  const handleDeleteFile = useCallback((file: RoomFile) => {
    if (!room) return
    Alert.alert(`Delete "${file.name}"?`, 'This also removes the chat message that shared it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await room.deleteMessage(file.messageId)
            await refreshFiles()
          } catch (err) {
            Alert.alert('Delete failed', (err as Error).message)
          }
        }
      }
    ])
  }, [room, refreshFiles])

  const filteredRoomFiles = useMemo(() => {
    const q = fileSearchQuery.trim().toLowerCase()
    if (!q) return roomFiles
    return roomFiles.filter((f) => f.name.toLowerCase().includes(q))
  }, [roomFiles, fileSearchQuery])

  const [replyTo, setReplyTo] = useState<{ id: string; body: string; authorName: string } | null>(null)
  const [editingMessage, setEditingMessage] = useState<{ id: string; body: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const flatListRef = useRef<FlatList>(null)
  const [wallpaperSvg, setWallpaperSvg] = useState<string | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  /** Same fact as `showScrollToBottom`, readable from a listener that must not re-subscribe every
   * time the user scrolls. */
  const awayFromBottomRef = useRef(false)
  const handleListScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height
    awayFromBottomRef.current = distanceFromBottom > 300
    setShowScrollToBottom(distanceFromBottom > 300)
  }, [])

  // The keyboard opening shortens the list (Android resizes the window — see windowSoftInputMode
  // in the manifest) without moving its scroll offset, so the newest messages, the ones that were
  // sitting just above the composer, end up behind the keyboard. Re-anchor only for someone who
  // was already at the bottom; anyone reading back through history stays where they were.
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      if (!awayFromBottomRef.current) flatListRef.current?.scrollToEnd({ animated: false })
    })
    return () => shown.remove()
  }, [])

  // Lands on the latest messages when a room first opens. Fires once messages first become
  // non-empty rather than once on `loading` alone — a room whose peer hasn't synced recently (far
  // more common for a quiet 1:1 than an active group) can flip `loading` false with nothing
  // loaded yet, with the real content trickling in afterward via onMessage; keying only off
  // `loading` would then never schedule a scroll at all. The ref makes it fire once per mount,
  // not on every later message. The same short delay handleSend/handleAttach use below: scrolling
  // before the list has actually laid out its rows doesn't reliably reach the true bottom, which
  // onContentSizeChange's own scroll can miss on the very first layout pass.
  const scrolledToTailRef = useRef(false)
  useEffect(() => {
    if (scrolledToTailRef.current || loading || messages.length === 0) return
    scrolledToTailRef.current = true
    const timer = setTimeout(() => flatListRef.current?.scrollToEnd({ animated: false }), 100)
    return () => clearTimeout(timer)
  }, [loading, messages.length])

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }, [])

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return
    Alert.alert(
      `Delete ${selectedIds.size} message${selectedIds.size > 1 ? 's' : ''}?`,
      'This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            for (const id of selectedIds) await deleteMessage(id)
            exitSelectionMode()
          },
        },
      ]
    )
  }, [selectedIds, deleteMessage, exitSelectionMode])

  const [memberCount, setMemberCount] = useState(1)
  const [isOwner, setIsOwner] = useState(false)
  useEffect(() => {
    if (!room) return
    void room.listMembers().then((res) => {
      if (res?.members) setMemberCount(res.members.length)
      setIsOwner(!!res?.ownerId && res.ownerId === identityId)
    })
  }, [room, identityId])

  // Custom header
  useEffect(() => {
    if (selectionMode) {
      navigation.setOptions({
        headerTitle: () => (
          <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '700' }}>
            {selectedIds.size} selected
          </Text>
        ),
        headerLeft: () => (
          <Pressable onPress={exitSelectionMode} style={styles.headerBtn}>
            <Ionicons name="close" size={22} color={colors.textPrimary} />
          </Pressable>
        ),
        headerRight: () => (
          <Pressable onPress={handleBatchDelete} style={styles.headerBtn} disabled={selectedIds.size === 0}>
            <Ionicons name="trash-outline" size={20} color={selectedIds.size === 0 ? colors.textTertiary : colors.error} />
          </Pressable>
        ),
      })
      return
    }
    navigation.setOptions({
      headerLeft: undefined,
      headerTitle: () => (
        <View style={{ alignItems: 'flex-start', justifyContent: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
              {roomName}
            </Text>
            {isVault ? (
              <View style={styles.vaultBadge}>
                <Ionicons name="lock-closed" size={9} color="#f59e0b" />
                <Text style={styles.vaultBadgeText}>VAULT</Text>
              </View>
            ) : (
              <Ionicons name="checkmark-circle" size={14} color="#38bdf8" />
            )}
          </View>
          <Text style={{ color: colors.textTertiary, fontSize: 11 }}>
            {isVault ? 'Single-Writer Sovereign Vault' : `${memberCount} member(s)`}
          </Text>
        </View>
      ),
      headerRight: () => (
        <View style={styles.headerRight}>
          <Pressable onPress={() => setShowSearch(!showSearch)} style={styles.headerBtn}>
            <Ionicons name="search-outline" size={20} color={colors.textPrimary} />
          </Pressable>
          {!isVault && (
            <Pressable
              onPress={() => roomId && navigation.navigate('Members', { roomId, roomName })}
              style={styles.headerBtn}
            >
              <Ionicons name="people-outline" size={20} color={colors.textPrimary} />
            </Pressable>
          )}
          {/* Owner-only: the owner is the only member who runs `redeemInvite`, so a link shared by
              anyone else gets the joiner into the room read-only and stuck there. */}
          {isOwner && !isVault && (
            <Pressable
              onPress={() => roomId && navigation.navigate('Invite', { roomId, roomName })}
              style={styles.headerBtn}
            >
              <Ionicons name="share-outline" size={20} color={colors.textPrimary} />
            </Pressable>
          )}
        </View>
      ),
    })
  }, [navigation, roomId, roomName, showSearch, memberCount, isOwner, isVault, colors, styles, selectionMode, selectedIds, exitSelectionMode, handleBatchDelete])

  const getAuthorName = useCallback((authorId: string) => {
    if (authorId === identityId) return 'You'
    return nicknames.get(authorId) || authorId.slice(0, 8)
  }, [identityId, nicknames])

  // Hashtag notes: every tag used in the room, most-used first, so "buy milk #todo" stays
  // findable later by tapping #todo. Selecting a tag narrows the list; tapping it again clears.
  const hashtagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of messages) {
      if (m.deleted) continue
      for (const tag of extractHashtags(m.body)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [messages])

  // A tag whose last message was deleted must not stay selected, or the list sits empty.
  useEffect(() => {
    if (activeHashtag && !hashtagCounts.some(([tag]) => tag === activeHashtag)) setActiveHashtag(null)
  }, [hashtagCounts, activeHashtag])

  const filteredMessages = useMemo(() => {
    let list = searchQuery
      ? messages.filter((m) => m.body.toLowerCase().includes(searchQuery.toLowerCase()))
      : messages
    if (activeHashtag) list = list.filter((m) => !m.deleted && hasHashtag(m.body, activeHashtag))
    return list
  }, [messages, searchQuery, activeHashtag])

  const mailboxMessages = useMemo(() => {
    return filteredMessages
      .filter((m) => !m.deleted)
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
  }, [filteredMessages])

  const docDayGroups = useMemo(() => {
    const nonDeleted = filteredMessages.filter((m) => !m.deleted)
    const groups: { day: string; items: ChatMessage[] }[] = []
    let currentDay = ''
    let currentItems: ChatMessage[] = []

    for (const m of nonDeleted) {
      const day = new Date(m.timestamp).toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
      if (day !== currentDay) {
        if (currentItems.length > 0) {
          groups.push({ day: currentDay, items: currentItems })
        }
        currentDay = day
        currentItems = [m]
      } else {
        currentItems.push(m)
      }
    }
    if (currentItems.length > 0) {
      groups.push({ day: currentDay, items: currentItems })
    }
    return groups
  }, [filteredMessages])

  const handleSendMailboxReply = useCallback(async () => {
    if (!selectedMailboxMessage || !mailboxReplyText.trim()) return
    setMailboxSending(true)
    try {
      await sendMessage(mailboxReplyText.trim(), selectedMailboxMessage.id)
      setMailboxReplyText('')
      Alert.alert('Sent', 'Reply added to thread.')
    } catch (err) {
      Alert.alert('Failed to send', (err as Error).message)
    } finally {
      setMailboxSending(false)
    }
  }, [selectedMailboxMessage, mailboxReplyText, sendMessage])

  const renderAttachment = useCallback((file: { name: string; size: number; mimeType?: string; path: string; driveKey: string; thumbnail?: string }) => {
    const isDownloading = downloadingFilePath === file.path
    return (
      <View style={styles.attachmentBox}>
        <View style={styles.attachmentIconBox}>
          <Ionicons name={getFileIcon(file.name, file.mimeType || '')} size={22} color={colors.accent} />
        </View>
        <View style={styles.attachmentDetails}>
          <Text style={styles.attachmentName} numberOfLines={1}>{file.name}</Text>
          <Text style={styles.attachmentMeta}>{formatBytes(file.size)}</Text>
        </View>
        <Pressable
          style={styles.attachmentDownloadBtn}
          disabled={isDownloading}
          onPress={() => handleDownloadFile(file as unknown as RoomFile)}
        >
          <Ionicons name={isDownloading ? "hourglass-outline" : "download-outline"} size={18} color={colors.accent} />
        </Pressable>
      </View>
    )
  }, [downloadingFilePath, colors, styles, handleDownloadFile])

  const handleSend = useCallback(async (text: string) => {
    await sendMessage(text, replyTo?.id)
    setReplyTo(null)
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100)
  }, [sendMessage, replyTo])

  const handleAttach = useCallback(async (name: string, mimeType: string, base64: string, thumbnail?: string) => {
    await sendFile(name, mimeType, base64, thumbnail)
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100)
  }, [sendFile])

  const handlePlayAudio = useCallback(async (message: ChatMessage) => {
    if (!message.file || loadingAudioId) return
    if (playingAudioId === message.id) {
      audioPlayerRef.current?.pause()
      setPlayingAudioId(null)
      return
    }
    audioPlayerRef.current?.remove()
    audioPlayerRef.current = null
    setPlayingAudioId(null)
    setLoadingAudioId(message.id)
    try {
      // Streamed from the worklet's media server rather than pulled whole through the IPC
      // bridge: playback starts on the first blocks, and a long recording no longer has to
      // exist as one base64 string in memory before it can be heard.
      const url = await session!.mediaUrl(message.file.driveKey, message.file.path)
      const player = createAudioPlayer(url)
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) setPlayingAudioId(null)
      })
      audioPlayerRef.current = player
      player.play()
      setPlayingAudioId(message.id)
    } catch {
      Alert.alert('Playback failed', 'Could not play this file.')
    } finally {
      setLoadingAudioId(null)
    }
  }, [playingAudioId, loadingAudioId, session])

  useEffect(() => () => { audioPlayerRef.current?.remove() }, [])

  const saveFileToDevice = useCallback(async (message: ChatMessage) => {
    if (!message.file || downloadingId) return
    setDownloadingId(message.id)
    try {
      const base64 = await downloadFile(message.file.driveKey, message.file.path)
      if (!base64) return Alert.alert('File unavailable', 'The peer sharing this file is offline.')
      const dest = FileSystem.cacheDirectory + message.file.name
      await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType.Base64 })
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(dest)
    } catch {
      Alert.alert('Download failed', 'Could not fetch this file.')
    } finally {
      setDownloadingId(null)
    }
  }, [downloadingId])

  const handleFilePress = useCallback(async (message: ChatMessage) => {
    if (!message.file || downloadingId) return
    if (isAudioFile(message.file)) return handlePlayAudio(message)
    if (isVideoFile(message.file)) {
      const file = message.file
      return void session!.mediaUrl(file.driveKey, file.path)
        .then((uri) => setPlayingVideo({ uri, name: file.name }))
        .catch(() => Alert.alert('Playback failed', 'Could not open this video.'))
    }
    return saveFileToDevice(message)
  }, [downloadingId, session, handlePlayAudio, saveFileToDevice])

  const handleEdit = useCallback(async (id: string, body: string) => {
    await editMessage(id, body)
    setEditingMessage(null)
  }, [editMessage])

  const handleLongPress = useCallback((message: ChatMessage) => {
    setSelectedMessage(message)
  }, [])

  const handleAction = useCallback((action: string) => {
    if (!selectedMessage) return

    switch (action) {
      case 'copy':
        void Clipboard.setStringAsync(selectedMessage.body)
        break
      case 'reply':
        setReplyTo({
          id: selectedMessage.id,
          body: selectedMessage.body,
          authorName: getAuthorName(selectedMessage.authorId),
        })
        break
      case 'edit':
        if (selectedMessage.authorId === identityId) {
          setEditingMessage({ id: selectedMessage.id, body: selectedMessage.body })
        }
        break
      case 'delete':
        if (selectedMessage.authorId === identityId) {
          Alert.alert('Delete message?', 'This cannot be undone.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => deleteMessage(selectedMessage.id) },
          ])
        }
        break
    }
    setSelectedMessage(null)
  }, [selectedMessage, identityId, getAuthorName, deleteMessage])

  const messagesById = useMemo(() => {
    const map = new Map<string, ChatMessage>()
    for (const m of messages) map.set(m.id, m)
    return map
  }, [messages])

  const replyMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of messages) map.set(m.id, m.body.slice(0, 100))
    return map
  }, [messages])
  const getReplyPreview = useCallback((replyToId?: string) => {
    return replyToId ? replyMap.get(replyToId) : undefined
  }, [replyMap])

  const confirmDeleteMessage = useCallback((msgId: string) => {
    Alert.alert('Delete message?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (selectedMailboxMessage?.id === msgId) {
            setSelectedMailboxMessage(null)
          }
          await deleteMessage(msgId)
        },
      },
    ])
  }, [deleteMessage, selectedMailboxMessage])

  // The handlers a row calls, read through a ref so the object handed to every row can keep the
  // same identity for the life of the screen while still calling this render's versions.
  const rowHandlers = useRef({ selectionMode, identityId, handleLongPress, toggleSelected, toggleReaction, handleFilePress, saveFileToDevice, setActiveHashtag })
  useEffect(() => {
    rowHandlers.current = { selectionMode, identityId, handleLongPress, toggleSelected, toggleReaction, handleFilePress, saveFileToDevice, setActiveHashtag }
  })
  const rowActions = useMemo<RowActions>(() => ({
    onLongPress: (message) => {
      const h = rowHandlers.current
      if (h.selectionMode) { if (message.authorId === h.identityId) h.toggleSelected(message.id) }
      else h.handleLongPress(message)
    },
    onPress: (message) => {
      const h = rowHandlers.current
      if (h.selectionMode && message.authorId === h.identityId) h.toggleSelected(message.id)
    },
    onReaction: (messageId, emoji) => { void rowHandlers.current.toggleReaction(messageId, emoji) },
    onFilePress: (message) => { void rowHandlers.current.handleFilePress(message) },
    onFileSave: (message) => { void rowHandlers.current.saveFileToDevice(message) },
    onHashtagPress: (tag) => rowHandlers.current.setActiveHashtag((cur) => (cur === tag ? null : tag)),
  }), [])

  const renderMessage = useCallback(({ item }: { item: ChatMessage }) => (
    <MessageRow
      item={item}
      isSelf={item.authorId === identityId}
      authorName={getAuthorName(item.authorId)}
      replyPreview={getReplyPreview(item.replyTo)}
      selectionMode={selectionMode}
      selected={selectedIds.has(item.id)}
      fileDownloading={downloadingId === item.id}
      isAudioPlaying={playingAudioId === item.id}
      isAudioLoading={loadingAudioId === item.id}
      actions={rowActions}
    />
  ), [identityId, getAuthorName, getReplyPreview, selectionMode, selectedIds, downloadingId, playingAudioId, loadingAudioId, rowActions])

  return (
    <SafeAreaView style={styles.safe}>
      {/* Search bar */}
      {showSearch && (
        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            placeholder="Search messages..."
            placeholderTextColor={colors.textTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          <Pressable onPress={() => { setShowSearch(false); setSearchQuery('') }}>
            <Ionicons name="close" size={18} color={colors.textTertiary} />
          </Pressable>
        </View>
      )}

      <View style={styles.tabContainer}>
        <Pressable
          style={[styles.tabButton, activeTab === 'chat' && styles.tabButtonActive]}
          onPress={() => setActiveTab('chat')}
          accessibilityLabel="Chat"
          accessibilityRole="tab"
        >
          <Ionicons
            name={activeTab === 'chat' ? 'chatbubble' : 'chatbubble-outline'}
            size={18}
            color={activeTab === 'chat' ? '#ffffff' : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === 'mailbox' && styles.tabButtonActive]}
          onPress={() => setActiveTab('mailbox')}
          accessibilityLabel="Mailbox"
          accessibilityRole="tab"
        >
          <Ionicons
            name={activeTab === 'mailbox' ? 'mail' : 'mail-outline'}
            size={18}
            color={activeTab === 'mailbox' ? '#ffffff' : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === 'document' && styles.tabButtonActive]}
          onPress={() => setActiveTab('document')}
          accessibilityLabel="Notes"
          accessibilityRole="tab"
        >
          <Ionicons
            name={activeTab === 'document' ? 'document-text' : 'document-text-outline'}
            size={18}
            color={activeTab === 'document' ? '#ffffff' : colors.textSecondary}
          />
        </Pressable>
        <Pressable
          style={[styles.tabButton, activeTab === 'files' && styles.tabButtonActive]}
          onPress={() => setActiveTab('files')}
          accessibilityLabel="Files"
          accessibilityRole="tab"
        >
          <Ionicons
            name={activeTab === 'files' ? 'folder' : 'folder-outline'}
            size={18}
            color={activeTab === 'files' ? '#ffffff' : colors.textSecondary}
          />
        </Pressable>
      </View>

      {activeTab === 'mailbox' ? (
        <View style={{ flex: 1 }}>
          <FlatList
            data={mailboxMessages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.mailboxList}
            renderItem={({ item }) => {
              const lines = item.body.trim().split('\n')
              const subject = lines[0] || (item.file ? item.file.name : 'No subject')
              const snippet = lines.length > 1 ? lines.slice(1).join(' ').trim() : (item.file ? `${item.file.name} (${formatBytes(item.file.size)})` : '')
              const author = getAuthorName(item.authorId)
              const isReply = !!(item.replyTo && messagesById.has(item.replyTo))
              const canDel = item.authorId === identityId || isOwner
              return (
                <Pressable
                  style={({ pressed }) => [styles.mailboxCard, pressed && styles.mailboxCardPressed]}
                  onPress={() => setSelectedMailboxMessage(item)}
                >
                  <View style={styles.mailboxHeaderRow}>
                    <Avatar
                      id={item.authorId}
                      label={author}
                      imageUrl={avatars.get(item.authorId)}
                      size="sm"
                    />
                    <Text style={styles.mailboxAuthor} numberOfLines={1}>{author}</Text>
                    <View style={{ flex: 1 }} />
                    {item.file && <Ionicons name="attach-outline" size={14} color={colors.accent} style={{ marginRight: 4 }} />}
                    <Text style={styles.mailboxTime}>
                      {new Date(item.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </Text>
                    {canDel && (
                      <Pressable
                        hitSlop={8}
                        onPress={() => confirmDeleteMessage(item.id)}
                        style={{ marginLeft: 8, padding: 2 }}
                        accessibilityLabel="Delete email"
                      >
                        <Ionicons name="trash-outline" size={15} color={colors.textTertiary} />
                      </Pressable>
                    )}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    {isReply && (
                      <Ionicons name="arrow-undo-outline" size={13} color={colors.cyan} style={{ marginRight: 4 }} />
                    )}
                    <Text style={styles.mailboxSubject} numberOfLines={1}>
                      {isReply && !subject.toLowerCase().startsWith('re:') ? `Re: ${subject}` : subject}
                    </Text>
                  </View>
                  {snippet ? (
                    <Text style={styles.mailboxSnippet} numberOfLines={2}>{snippet}</Text>
                  ) : null}
                </Pressable>
              )
            }}
            ListEmptyComponent={
              <View style={styles.emptyCenter}>
                <Ionicons name="mail-unread-outline" size={44} color={colors.textSecondary} style={styles.emptyIcon} />
                <Text style={styles.emptyText}>No messages in mailbox</Text>
              </View>
            }
          />
        </View>
      ) : activeTab === 'document' ? (
        <View style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={styles.docCanvas}>
            {docDayGroups.map((group) => (
              <View key={group.day} style={styles.docDaySection}>
                <View style={styles.docDateDivider}>
                  <Text style={styles.docDateText}>{group.day}</Text>
                </View>
                {group.items.map((item) => {
                  const isReply = !!(item.replyTo && messagesById.has(item.replyTo))
                  const quoted = isReply && item.replyTo ? messagesById.get(item.replyTo) : undefined
                  const canDel = item.authorId === identityId || isOwner
                  return (
                    <View key={item.id} style={styles.docEntry}>
                      <View style={styles.docMetaRow}>
                        <Text style={styles.docAuthor}>{getAuthorName(item.authorId)}</Text>
                        <Text style={styles.docTime}>
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                        <View style={{ flex: 1 }} />
                        <Pressable
                          hitSlop={8}
                          onPress={() => {
                            setReplyTo({
                              id: item.id,
                              body: item.body,
                              authorName: getAuthorName(item.authorId),
                            })
                          }}
                          style={{ padding: 4, marginRight: 6 }}
                          accessibilityLabel="Quote note"
                        >
                          <Ionicons name="arrow-undo-outline" size={15} color={colors.textSecondary} />
                        </Pressable>
                        {canDel && (
                          <Pressable
                            hitSlop={8}
                            onPress={() => confirmDeleteMessage(item.id)}
                            style={{ padding: 4 }}
                            accessibilityLabel="Delete note"
                          >
                            <Ionicons name="trash-outline" size={15} color="#f43f5e" />
                          </Pressable>
                        )}
                      </View>
                      {quoted && (
                        <View style={styles.docQuoteCard}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                            <Ionicons name="arrow-undo-outline" size={12} color={colors.cyan} style={{ marginRight: 4 }} />
                            <Text style={styles.docQuoteAuthor}>{getAuthorName(quoted.authorId)}</Text>
                          </View>
                          <Text style={styles.docQuoteSnippet} numberOfLines={2}>
                            {quoted.body || (quoted.file ? quoted.file.name : 'Quoted note')}
                          </Text>
                        </View>
                      )}
                      <Text style={styles.docBody} selectable>
                        {item.body}
                      </Text>
                      {item.file && (
                        <View style={{ marginTop: spacing.xs }}>
                          {renderAttachment(item.file)}
                        </View>
                      )}
                    </View>
                  )
                })}
              </View>
            ))}
            {docDayGroups.length === 0 && (
              <View style={styles.emptyCenter}>
                <Ionicons name="document-text-outline" size={44} color={colors.textSecondary} style={styles.emptyIcon} />
                <Text style={styles.emptyText}>No notes written yet</Text>
              </View>
            )}
          </ScrollView>
          {writable && hasKey && canPost ? (
            <MessageComposer
              onSend={handleSend}
              onAttach={handleAttach}
              onChangeText={notifyTyping}
              placeholder={isVault ? "Write a private note to yourself..." : "Add to notes..."}
            />
          ) : null}
        </View>
      ) : activeTab === 'files' ? (
        <View style={{ flex: 1 }}>
          <View style={styles.filesToolbar}>
            <TextInput
              style={styles.filesSearchInput}
              placeholder="Search files..."
              placeholderTextColor={colors.textTertiary}
              value={fileSearchQuery}
              onChangeText={setFileSearchQuery}
            />
          </View>

          <FlatList
            data={filteredRoomFiles}
            keyExtractor={(item) => item.messageId}
            contentContainerStyle={styles.filesList}
            renderItem={({ item }) => {
              const isMine = item.authorId === identityId
              const isDownloading = downloadingFilePath === item.path
              return (
                <View style={styles.fileCard}>
                  <View style={styles.fileCardIcon}>
                    <Ionicons name={getFileIcon(item.name, item.mimeType)} size={24} color={colors.textSecondary} />
                  </View>
                  <View style={styles.fileCardInfo}>
                    <Text style={styles.fileCardName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.fileCardMeta}>
                      {formatBytes(item.size)} • {getAuthorName(item.authorId)} • {new Date(item.timestamp).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={styles.fileCardActions}>
                    <Pressable
                      style={styles.fileActionBtn}
                      disabled={isDownloading}
                      onPress={() => handleDownloadFile(item)}
                    >
                      <Ionicons
                        name={isDownloading ? 'hourglass-outline' : 'download-outline'}
                        size={18}
                        color={colors.accent}
                      />
                    </Pressable>
                    {isMine && (
                      <Pressable
                        style={styles.fileActionBtn}
                        onPress={() => handleDeleteFile(item)}
                      >
                        <Ionicons name="trash-outline" size={18} color={colors.error} />
                      </Pressable>
                    )}
                  </View>
                </View>
              )
            }}
            ListEmptyComponent={
              <View style={styles.emptyCenter}>
                <Ionicons name="folder-open-outline" size={44} color={colors.textSecondary} style={styles.emptyIcon} />
                <Text style={styles.emptyText}>
                  {filesLoading ? 'Loading files…' : fileSearchQuery ? 'No matching files found' : 'No files shared yet'}
                </Text>
              </View>
            }
          />
        </View>
      ) : (
        <>
          {/* Room topic, pinned above the conversation the way the desktop pins it. Without this the
              description could be written from the phone (Members screen) but never read on it. */}
          {roomTopic ? (
            <View style={styles.topicBanner}>
              <Ionicons name="star" size={12} color={colors.warning} />
              <Text style={styles.topicLabel}>Topic</Text>
              <Text style={styles.topicText} numberOfLines={2}>
                {privateMode ? redact(roomTopic) : roomTopic}
              </Text>
            </View>
          ) : null}

          {/* Hashtag notes — one pill per tag used in this room, filtering the list below. */}
          {hashtagCounts.length > 0 && (
            <View style={styles.hashtagBar}>
              <Ionicons name="pricetags-outline" size={14} color={colors.textTertiary} />
              <FlatList
                horizontal
                showsHorizontalScrollIndicator={false}
                data={hashtagCounts}
                keyExtractor={([tag]) => tag}
                contentContainerStyle={styles.hashtagBarContent}
                renderItem={({ item: [tag, count] }) => {
                  const active = activeHashtag === tag
                  return (
                    <Pressable
                      onPress={() => setActiveHashtag(active ? null : tag)}
                      style={[styles.hashtagPill, active && styles.hashtagPillActive]}
                    >
                      <Text style={[styles.hashtagPillText, active && styles.hashtagPillTextActive]}>
                        #{tag}
                      </Text>
                      <Text style={[styles.hashtagCount, active && styles.hashtagPillTextActive]}>{count}</Text>
                    </Pressable>
                  )
                }}
              />
              {activeHashtag && (
                <Pressable onPress={() => setActiveHashtag(null)} style={styles.hashtagClear}>
                  <Ionicons name="close" size={14} color={colors.textTertiary} />
                </Pressable>
              )}
            </View>
          )}

          {/* Messages. The wallpaper is drawn with react-native-svg behind the list: RN's own
              Image component cannot render SVG, so an ImageBackground showed nothing. */}
          <View style={{ flex: 1 }}>
          {wallpaperSvg && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <SvgXml xml={wallpaperSvg} width="100%" height="100%" />
            </View>
          )}
          <FlatList
            ref={flatListRef}
            data={filteredMessages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.messageList}
            windowSize={7}
            maxToRenderPerBatch={16}
            initialNumToRender={16}
            removeClippedSubviews
            onScroll={handleListScroll}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              const tail = filteredMessages[filteredMessages.length - 1]
              if (tail && tail.id !== lastTailIdRef.current) {
                lastTailIdRef.current = tail.id
                flatListRef.current?.scrollToEnd({ animated: false })
              }
            }}
            ListHeaderComponent={hasMore ? (
              <Pressable
                style={styles.loadEarlier}
                disabled={loadingOlder}
                onPress={async () => {
                  setLoadingOlder(true)
                  try { await loadOlder() } finally { setLoadingOlder(false) }
                }}
              >
                <Text style={styles.loadEarlierText}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</Text>
              </Pressable>
            ) : undefined}
            ListEmptyComponent={
              loading ? (
                <View style={styles.emptyCenter}>
                  <Text style={styles.emptyText}>Loading messages...</Text>
                </View>
              ) : (
                <View style={styles.emptyCenter}>
                  <Ionicons name="chatbubble-outline" size={48} color={colors.textTertiary} style={styles.emptyIcon} />
                  <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
                </View>
              )
            }
          />
          </View>

          {showScrollToBottom && (
            <Pressable
              style={styles.scrollToBottomBtn}
              onPress={() => flatListRef.current?.scrollToEnd({ animated: true })}
            >
              <Ionicons name="chevron-down" size={22} color={colors.textPrimary} />
            </Pressable>
          )}

          {/* Typing / seen-by status */}
          {typingUsers.size > 0 ? (
            <Text style={styles.statusBar}>{[...typingUsers].map(getAuthorName).join(', ')} typing…</Text>
          ) : readBy.size > 0 ? (
            <Text style={styles.statusBar}>Seen by {[...readBy].map(getAuthorName).join(', ')}</Text>
          ) : null}

          {/* Composer, or why there isn't one */}
          {writable && hasKey && canPost ? (
            <MessageComposer
              onSend={handleSend}
              onAttach={handleAttach}
              onChangeText={notifyTyping}
              replyTo={replyTo}
              editingMessage={editingMessage}
              placeholder={isVault ? "Write a private note to yourself..." : "Message"}
              onCancelReply={() => setReplyTo(null)}
              onCancelEdit={() => setEditingMessage(null)}
              onSubmitEdit={handleEdit}
            />
          ) : (
            <View style={styles.composerBlocked}>
              <Ionicons
                name={!writable || !hasKey ? 'time-outline' : broadcast ? 'megaphone-outline' : 'volume-mute-outline'}
                size={15}
                color={colors.textTertiary}
              />
              <Text style={styles.composerBlockedText}>
                {!writable || !hasKey
                  ? 'You do not have write access to this room yet'
                  : broadcast
                    ? 'Only admins can send messages in this broadcast room'
                    : 'You are muted in this room'}
              </Text>
            </View>
          )}
        </>
      )}

      {/* Action sheet modal (cross-platform) */}
      <Modal visible={!!selectedMessage} transparent animationType="fade">
        <Pressable style={styles.actionOverlay} onPress={() => setSelectedMessage(null)}>
          <View style={styles.actionSheet}>
            {!!selectedMessage?.body && (
              <Pressable style={[styles.actionItem, styles.actionRow]} onPress={() => handleAction('copy')}>
                <Ionicons name="copy-outline" size={16} color={colors.textPrimary} />
                <Text style={styles.actionText}>Copy</Text>
              </Pressable>
            )}

            <Pressable style={[styles.actionItem, styles.actionRow]} onPress={() => handleAction('reply')}>
              <Ionicons name="arrow-undo-outline" size={16} color={colors.textPrimary} />
              <Text style={styles.actionText}>Reply</Text>
            </Pressable>

            {selectedMessage?.authorId === identityId && (
              <>
                <Pressable style={[styles.actionItem, styles.actionRow]} onPress={() => handleAction('edit')}>
                  <Ionicons name="pencil-outline" size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>Edit</Text>
                </Pressable>
                <Pressable style={[styles.actionItem, styles.actionRow]} onPress={() => handleAction('delete')}>
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                  <Text style={[styles.actionText, styles.actionDestructive]}>Delete</Text>
                </Pressable>
                <Pressable
                  style={[styles.actionItem, styles.actionRow]}
                  onPress={() => {
                    if (selectedMessage) {
                      setSelectionMode(true)
                      setSelectedIds(new Set([selectedMessage.id]))
                    }
                    setSelectedMessage(null)
                  }}
                >
                  <Ionicons name="checkmark-circle-outline" size={16} color={colors.textPrimary} />
                  <Text style={styles.actionText}>Select multiple</Text>
                </Pressable>
              </>
            )}

            <View style={styles.reactionRow}>
              {REACTION_EMOJIS.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    if (selectedMessage) toggleReaction(selectedMessage.id, emoji)
                    setSelectedMessage(null)
                  }}
                  style={styles.reactionBtn}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </Pressable>
              ))}
            </View>

            <Pressable style={[styles.actionItem, styles.actionCancel]} onPress={() => setSelectedMessage(null)}>
              <Text style={styles.actionCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {playingVideo && (
        <VideoPlayerModal uri={playingVideo.uri} name={playingVideo.name} onClose={() => setPlayingVideo(null)} />
      )}

      {/* Mailbox Reading Pane Modal */}
      <Modal visible={!!selectedMailboxMessage} animationType="slide" onRequestClose={() => setSelectedMailboxMessage(null)}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.readerHeader}>
            <Pressable onPress={() => setSelectedMailboxMessage(null)} style={styles.readerBackBtn}>
              <Ionicons name="arrow-back" size={22} color={colors.textPrimary} />
            </Pressable>
            <Text style={styles.readerHeaderTitle}>Mailbox Message</Text>
            {selectedMailboxMessage && (selectedMailboxMessage.authorId === identityId || isOwner) ? (
              <Pressable
                onPress={() => confirmDeleteMessage(selectedMailboxMessage.id)}
                hitSlop={8}
                style={{ padding: 6 }}
                accessibilityLabel="Delete email"
              >
                <Ionicons name="trash-outline" size={20} color="#f43f5e" />
              </Pressable>
            ) : (
              <View style={{ width: 40 }} />
            )}
          </View>
          {selectedMailboxMessage && (
            <View style={{ flex: 1 }}>
              <ScrollView contentContainerStyle={styles.readerContent}>
                <View style={styles.readerMetaCard}>
                  <Text style={styles.readerSubject}>
                    {selectedMailboxMessage.body.trim().split('\n')[0] || selectedMailboxMessage.file?.name || 'Message'}
                  </Text>
                  <View style={styles.readerRow}>
                    <Avatar
                      id={selectedMailboxMessage.authorId}
                      label={getAuthorName(selectedMailboxMessage.authorId)}
                      imageUrl={avatars.get(selectedMailboxMessage.authorId)}
                      size="sm"
                    />
                    <View style={{ flex: 1, marginLeft: spacing.sm }}>
                      <Text style={styles.readerAuthor}>{getAuthorName(selectedMailboxMessage.authorId)}</Text>
                      <Text style={styles.readerTo}>To: {roomName} • Sovereign P2P</Text>
                    </View>
                    <Text style={styles.readerDate}>
                      {new Date(selectedMailboxMessage.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <View style={styles.readerSecurityBadge}>
                    <Ionicons name="shield-checkmark" size={13} color={colors.cyan} />
                    <Text style={styles.readerSecurityText}>P2P End-to-End Encrypted</Text>
                  </View>
                </View>

                {/* Quoted parent message */}
                {selectedMailboxMessage.replyTo && messagesById.get(selectedMailboxMessage.replyTo) ? (() => {
                  const parent = messagesById.get(selectedMailboxMessage.replyTo)!
                  const pAuthor = getAuthorName(parent.authorId)
                  const pLines = parent.body.trim().split('\n')
                  const pSubj = pLines[0] || (parent.file ? parent.file.name : 'Message')
                  return (
                    <Pressable
                      style={styles.readerReplyBanner}
                      onPress={() => setSelectedMailboxMessage(parent)}
                    >
                      <Ionicons name="arrow-undo-outline" size={15} color={colors.cyan} style={{ marginRight: 6, marginTop: 2 }} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.readerReplyBannerTitle} numberOfLines={1}>
                          In reply to <Text style={{ fontWeight: '700' }}>{pAuthor}</Text>: {pSubj}
                        </Text>
                        {parent.body ? (
                          <Text style={styles.readerReplyBannerSnippet} numberOfLines={1}>
                            {parent.body.slice(0, 80)}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  )
                })() : null}

                <View style={styles.readerBodyContainer}>
                  <Text style={styles.readerBody} selectable>
                    {selectedMailboxMessage.body}
                  </Text>
                  {selectedMailboxMessage.file && (
                    <View style={{ marginTop: spacing.md }}>
                      {renderAttachment(selectedMailboxMessage.file)}
                    </View>
                  )}
                </View>

                {/* Thread replies */}
                {(() => {
                  const threadReplies = mailboxMessages.filter((m) => m.replyTo === selectedMailboxMessage.id)
                  if (threadReplies.length === 0) return null
                  return (
                    <View style={styles.readerThreadSection}>
                      <Text style={styles.readerThreadTitle}>Replies in this thread ({threadReplies.length})</Text>
                      {threadReplies.map((r) => {
                        const rAuthor = getAuthorName(r.authorId)
                        return (
                          <Pressable
                            key={r.id}
                            style={styles.readerThreadItem}
                            onPress={() => setSelectedMailboxMessage(r)}
                          >
                            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                              <Text style={styles.readerThreadAuthor}>{rAuthor}</Text>
                              <Text style={styles.readerThreadTime}>
                                {new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </Text>
                            </View>
                            <Text style={styles.readerThreadSnippet} numberOfLines={2}>
                              {r.body || (r.file ? r.file.name : 'Reply')}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )
                })()}
              </ScrollView>

              {/* Quick Reply Bar */}
              <View style={styles.mailboxReplyBar}>
                <TextInput
                  style={styles.mailboxReplyInput}
                  placeholder="Reply in this thread..."
                  placeholderTextColor={colors.textTertiary}
                  value={mailboxReplyText}
                  onChangeText={setMailboxReplyText}
                />
                <Pressable
                  style={[styles.mailboxReplySendBtn, (!mailboxReplyText.trim() || mailboxSending) && { opacity: 0.5 }]}
                  disabled={!mailboxReplyText.trim() || mailboxSending}
                  onPress={handleSendMailboxReply}
                >
                  <Ionicons name="send" size={16} color="#061e27" />
                </Pressable>
              </View>
            </View>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  )
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bgPrimary },
  headerRight: { flexDirection: 'row', gap: spacing.sm },
  headerBtn: { padding: spacing.xs },
  headerBtnText: { fontSize: 18 },
  searchBar: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bgSecondary, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, gap: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  searchInput: {
    flex: 1, backgroundColor: colors.inputBg,
    borderRadius: radii.md, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, color: colors.textPrimary,
    fontSize: typography.md,
  },
  searchClose: { color: colors.textTertiary, fontSize: 18, padding: spacing.xs },
  messageList: { paddingVertical: spacing.sm, flexGrow: 1 },
  loadEarlier: { alignItems: 'center', paddingVertical: spacing.sm },
  loadEarlierText: { color: colors.textTertiary, fontSize: typography.sm },
  emptyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  scrollToBottomBtn: {
    position: 'absolute', right: spacing.lg, bottom: 90,
    width: 42, height: 42, borderRadius: radii.full,
    backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
    ...shadows.md,
  },
  emptyIcon: { opacity: 0.5, marginBottom: spacing.sm },
  emptyText: { color: colors.textTertiary, fontSize: typography.md },
  statusBar: {
    color: colors.textTertiary, fontSize: typography.xs,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    backgroundColor: colors.bgSecondary,
  },
  composerBlocked: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  composerBlockedText: {
    color: colors.textTertiary, fontSize: typography.sm, textAlign: 'center',
  },
  actionOverlay: {
    flex: 1, backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  actionSheet: {
    backgroundColor: colors.bgSecondary,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingVertical: spacing.md,
  },
  actionItem: {
    paddingVertical: spacing.md, paddingHorizontal: spacing.xxl,
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actionText: { color: colors.textPrimary, fontSize: typography.md },
  actionDestructive: { color: colors.error },
  reactionRow: {
    flexDirection: 'row', justifyContent: 'center',
    gap: spacing.sm, paddingVertical: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.border,
    marginTop: spacing.sm,
  },
  reactionBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center', justifyContent: 'center',
  },
  reactionEmoji: { fontSize: 20 },
  actionCancel: {
    borderTopWidth: 1, borderTopColor: colors.border,
    marginTop: spacing.sm, paddingTop: spacing.lg,
  },
  actionCancelText: { color: colors.textTertiary, fontSize: typography.md, textAlign: 'center' },
  topicBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  topicLabel: {
    color: colors.warning, fontSize: typography.xs, fontWeight: typography.semibold,
    textTransform: 'uppercase', letterSpacing: 1,
  },
  topicText: { flex: 1, color: colors.textSecondary, fontSize: typography.sm },
  hashtagBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  hashtagBarContent: { gap: spacing.xs, alignItems: 'center' },
  hashtagPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hashtagPillActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  hashtagPillText: {
    color: colors.textSecondary,
    fontSize: typography.xs,
    fontWeight: typography.semibold,
  },
  hashtagPillTextActive: { color: '#fff' },
  hashtagCount: { color: colors.textTertiary, fontSize: 10 },
  hashtagClear: { padding: 2 },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    padding: 3,
    marginHorizontal: spacing.md,
    marginVertical: spacing.xs,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
  },
  tabButtonActive: {
    backgroundColor: colors.accent,
  },
  filesToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filesSearchInput: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.sm,
  },
  filesList: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  fileCardIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileCardInfo: {
    flex: 1,
    minWidth: 0,
  },
  fileCardName: {
    color: colors.textPrimary,
    fontSize: typography.sm,
    fontWeight: '600',
  },
  fileCardMeta: {
    color: colors.textTertiary,
    fontSize: typography.xs,
    marginTop: 2,
  },
  fileCardActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  fileActionBtn: {
    padding: spacing.xs,
  },
  vaultBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(234, 179, 8, 0.15)',
    borderColor: 'rgba(234, 179, 8, 0.4)',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.full,
  },
  vaultBadgeText: {
    color: '#eab308',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  mailboxList: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  mailboxCard: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  mailboxCardPressed: {
    backgroundColor: colors.bgTertiary,
  },
  mailboxHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mailboxAuthor: {
    color: colors.textPrimary,
    fontSize: typography.sm,
    fontWeight: '600',
  },
  mailboxTime: {
    color: colors.textTertiary,
    fontSize: typography.xs,
  },
  mailboxSubject: {
    color: colors.accent,
    fontSize: typography.sm,
    fontWeight: '600',
    marginTop: 2,
  },
  mailboxSnippet: {
    color: colors.textSecondary,
    fontSize: typography.xs,
    lineHeight: 18,
  },
  docCanvas: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  docDaySection: {
    marginBottom: spacing.lg,
  },
  docDateDivider: {
    alignSelf: 'center',
    backgroundColor: colors.bgTertiary,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  docDateText: {
    color: colors.textTertiary,
    fontSize: typography.xs,
    fontWeight: '600',
  },
  docEntry: {
    backgroundColor: colors.bgSecondary,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  docMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  docAuthor: {
    color: colors.accent,
    fontSize: typography.xs,
    fontWeight: '600',
  },
  docTime: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  docBody: {
    color: colors.textPrimary,
    fontSize: typography.sm,
    lineHeight: 20,
  },
  readerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  readerBackBtn: {
    padding: spacing.xs,
  },
  readerHeaderTitle: {
    color: colors.textPrimary,
    fontSize: typography.md,
    fontWeight: '600',
  },
  readerContent: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
  },
  readerMetaCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  readerSubject: {
    color: colors.textPrimary,
    fontSize: typography.lg,
    fontWeight: '700',
  },
  readerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  readerAuthor: {
    color: colors.textPrimary,
    fontSize: typography.sm,
    fontWeight: '600',
  },
  readerTo: {
    color: colors.textTertiary,
    fontSize: typography.xs,
    marginTop: 1,
  },
  readerDate: {
    color: colors.textTertiary,
    fontSize: typography.xs,
  },
  readerSecurityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderColor: 'rgba(6, 182, 212, 0.3)',
    borderWidth: 1,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  readerSecurityText: {
    color: colors.cyan,
    fontSize: 10,
    fontWeight: '500',
  },
  readerBodyContainer: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    minHeight: 180,
  },
  readerBody: {
    color: colors.textPrimary,
    fontSize: typography.md,
    lineHeight: 24,
  },
  mailboxReplyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  mailboxReplyInput: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    color: colors.textPrimary,
    fontSize: typography.sm,
  },
  mailboxReplySendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readerReplyBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.bgTertiary,
    borderLeftWidth: 3,
    borderLeftColor: colors.cyan,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  readerReplyBannerTitle: {
    color: colors.textPrimary,
    fontSize: typography.xs,
  },
  readerReplyBannerSnippet: {
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 2,
  },
  readerThreadSection: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  readerThreadTitle: {
    color: colors.textSecondary,
    fontSize: typography.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  readerThreadItem: {
    backgroundColor: colors.bgTertiary,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  readerThreadAuthor: {
    color: colors.textPrimary,
    fontSize: typography.xs,
    fontWeight: '600',
  },
  readerThreadTime: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  readerThreadSnippet: {
    color: colors.textSecondary,
    fontSize: typography.xs,
    marginTop: 2,
  },
  docQuoteCard: {
    backgroundColor: colors.bgTertiary,
    borderLeftWidth: 3,
    borderLeftColor: colors.cyan,
    borderRadius: radii.sm,
    padding: spacing.xs,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
  },
  docQuoteAuthor: {
    color: colors.cyan,
    fontSize: typography.xs,
    fontWeight: '600',
  },
  docQuoteSnippet: {
    color: colors.textSecondary,
    fontSize: 11,
  },
  attachmentBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  attachmentIconBox: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.bgSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentDetails: {
    flex: 1,
    minWidth: 0,
  },
  attachmentName: {
    color: colors.textPrimary,
    fontSize: typography.sm,
    fontWeight: '500',
  },
  attachmentMeta: {
    color: colors.textTertiary,
    fontSize: typography.xs,
    marginTop: 2,
  },
  attachmentDownloadBtn: {
    padding: spacing.xs,
  },
})
