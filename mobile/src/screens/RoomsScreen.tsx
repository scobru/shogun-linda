import React, { useState, useCallback, useMemo, useEffect } from 'react'
import {
  View, Text, FlatList, Pressable, StyleSheet,
  TextInput, Alert, Modal, SafeAreaView, Switch, Linking,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Ionicons } from '@expo/vector-icons'
import type { RootStackParamList } from '../navigation'
import { useSession } from '../hooks/useSession'
import type { RoomSummary } from '../bare/session-proxy'
import { decodeInvite } from '@core/ui/qr-core'
import RoomListItem from '../components/RoomListItem'
import Avatar from '../components/Avatar'
import { spacing, radii, typography, shadows, type ThemeColors } from '../theme'
import { useTheme } from '../theme-context'

type Props = NativeStackScreenProps<RootStackParamList, 'Rooms'>

/** Everything a room row can do, as one object whose identity never changes. */
interface RoomRowActions {
  onOpen(id: string, name: string): void
  onOptions(id: string, name: string, favorite: boolean): void
}

/**
 * Memoised so the list survives this screen's own churn: presence, peer connects and nickname
 * updates all arrive through `useSession`, and each one used to rebuild both row callbacks inline
 * in `renderItem` — which re-rendered every visible room on every one of them.
 */
const RoomRow = React.memo(function RoomRow({
  id, name, avatar, lastMessage, timestamp, unread, favorite, isVault, actions,
}: {
  id: string
  name: string
  avatar?: string
  lastMessage?: string
  timestamp?: number
  unread: boolean
  favorite: boolean
  isVault?: boolean
  actions: RoomRowActions
}) {
  return (
    <RoomListItem
      id={id}
      name={name}
      avatar={avatar}
      lastMessage={lastMessage}
      timestamp={timestamp}
      unread={unread}
      favorite={favorite}
      isVault={isVault}
      onPress={() => actions.onOpen(id, name)}
      onLongPress={() => actions.onOptions(id, name, favorite)}
    />
  )
})

export default function RoomsScreen({ navigation }: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => createStyles(colors), [colors])
  const { session, identity, nickname, avatar, bookmarks, contacts, avatars, refresh } = useSession()
  const [showCreate, setShowCreate] = useState(false)
  const [newRoomBroadcast, setNewRoomBroadcast] = useState(false)
  const [newRoomPublic, setNewRoomPublic] = useState(false)
  const [showJoin, setShowJoin] = useState(false)
  const [roomName, setRoomName] = useState('')
  const [roomDescription, setRoomDescription] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const [loading, setLoading] = useState(false)

  const incomingCount = contacts.filter((c) => c.status === 'incoming').length

  // Bookmark avatars are a snapshot from when the contact was accepted — they never update
  // again on their own, so a 1:1 room keeps showing a peer's old picture after they change it.
  // `avatars` is kept live via presence, so prefer it here when we can map the room back to them.
  const contactAvatarByRoom = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of contacts) {
      if (c.roomId && c.status === 'accepted') map.set(c.roomId, c.userId)
    }
    return map
  }, [contacts])

  const handleCreateRoom = useCallback(async () => {
    if (!session || !roomName.trim()) return
    setLoading(true)
    try {
      const room = await session.createRoom(roomName.trim(), newRoomPublic, '', roomDescription.trim(), newRoomBroadcast)
      refresh()
      setShowCreate(false)
      setRoomName('')
      setRoomDescription('')
      setNewRoomBroadcast(false)
      setNewRoomPublic(false)
      navigation.navigate('RoomChat', { roomId: room.id, roomName: roomName.trim() })
    } catch (err) {
      Alert.alert('Error', (err as Error).message)
    }
    setLoading(false)
  }, [session, roomName, roomDescription, newRoomPublic, newRoomBroadcast, refresh, navigation])

  // Navigates immediately and lets RoomChatScreen run the actual join in the background —
  // joinRoomByKey can block for up to ~30s waiting on the swarm (see session.ts's
  // openRoomWithRetry), and there's no reason to freeze this modal for that.
  const joinFromInvite = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    // linda-pear:// invite URL, or raw bootstrapKey:inviteCode
    const invite = decodeInvite(trimmed)
    const key = invite?.key ?? trimmed
    const name = invite?.name || 'Joined Room'
    setShowJoin(false)
    setInviteLink('')
    // A contact link is a room invite plus the sender's identity. Joining it as a plain room
    // would leave the two of them sharing a room and still not knowing each other, which is the
    // entire point of the link.
    if (invite?.kind === 'contact' && invite.from && session) {
      const from = invite.from
      void session.acceptContactInvite({ from, name, key })
        .then((room) => navigation.navigate('RoomChat', { roomId: room.id, roomName: name }))
        .catch((err) => Alert.alert('Could not open the invite', (err as Error).message))
      return
    }
    navigation.navigate('RoomChat', { roomName: name, pendingJoin: { name, key } })
  }, [navigation, session])

  const handleJoinRoom = useCallback(() => joinFromInvite(inviteLink), [joinFromInvite, inviteLink])

  // An invite is a `linda-pear://` link, so it can arrive from anywhere the user was handed one —
  // another messenger, the browser, a QR scanner. Without this the app registered no scheme and
  // handled no deep link, so tapping an invite did nothing at all and the only way in was to copy
  // the text and paste it into the join field, which is not something anyone guesses.
  useEffect(() => {
    const onUrl = (url: string | null) => { if (url) joinFromInvite(url) }
    void Linking.getInitialURL().then(onUrl).catch(() => {})
    const sub = Linking.addEventListener('url', (e) => onUrl(e.url))
    return () => sub.remove()
  }, [joinFromInvite])

  const openRoom = useCallback((id: string, name: string) => {
    navigation.navigate('RoomChat', { roomId: id, roomName: name })
  }, [navigation])

  const handleLeaveRoom = useCallback((id: string, name: string) => {
    if (!session) return
    Alert.alert('Leave room?', `You'll need a new invite to rejoin "${name}".`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive', onPress: () => {
          void session.deleteRoom(id).then(refresh)
        },
      },
    ])
  }, [session, refresh])

  // Local-only cutoff (see Session.clearRoomHistory) — hides this device's view of the room's
  // history, doesn't touch the replicated log, so other members/devices are unaffected.
  const handleClearHistory = useCallback((id: string, name: string) => {
    if (!session) return
    Alert.alert(
      'Clear chat history?',
      `This clears all messages in "${name}" from this device only — other members keep their copy.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear', style: 'destructive', onPress: () => {
            void session.clearRoomHistory(id).then(refresh)
          },
        },
      ]
    )
  }, [session, refresh])

  const handleRestoreHistory = useCallback((id: string, name: string) => {
    if (!session) return
    Alert.alert(
      'Restore chat history?',
      `Restore hidden messages in "${name}"? Messages will reappear immediately.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore', onPress: () => {
            void session.restoreRoomHistory(id).then(refresh)
          },
        },
      ]
    )
  }, [session, refresh])

  // A Modal rather than Alert.alert: Android's dialog renders at most three buttons and silently
  // drops the rest, so the fourth — the one that removes the room — was invisible on every phone.
  // A room that cannot be opened and cannot be removed is a dead entry the user is stuck with.
  const [roomOptions, setRoomOptions] = useState<{ id: string; name: string; isFavorite: boolean; isCleared: boolean } | null>(null)

  const handleRoomOptions = useCallback((id: string, name: string, isFavorite: boolean) => {
    const isCleared = (bookmarks.find((b) => b.id === id)?.clearedAt ?? 0) > 0
    setRoomOptions({ id, name, isFavorite, isCleared })
  }, [bookmarks])

  const rowActions = useMemo<RoomRowActions>(() => ({
    onOpen: (id, name) => openRoom(id, name),
    onOptions: (id, name, favorite) => handleRoomOptions(id, name, favorite),
  }), [openRoom, handleRoomOptions])

  const renderRoom = useCallback(({ item }: { item: RoomSummary }) => {
    const peerId = contactAvatarByRoom.get(item.id)
    return (
      <RoomRow
        id={item.id}
        name={item.name}
        avatar={(peerId && avatars.get(peerId)) || item.avatar}
        lastMessage={item.lastMessageText ?? undefined}
        timestamp={item.lastMessageTime ?? undefined}
        unread={!!item.lastMessageTime && item.lastMessageTime > (item.lastReadAt ?? 0)}
        favorite={!!item.favorite}
        isVault={!!item.isVault}
        actions={rowActions}
      />
    )
  }, [contactAvatarByRoom, avatars, rowActions])

  const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'favorites'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredBookmarks = useMemo(() => {
    let list = bookmarks
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter((b) => b.name.toLowerCase().includes(q) || (b.lastMessageText && b.lastMessageText.toLowerCase().includes(q)))
    }
    if (activeFilter === 'unread') {
      list = list.filter((b) => !!b.lastMessageTime && b.lastMessageTime > (b.lastReadAt ?? 0))
    }
    if (activeFilter === 'favorites') {
      list = list.filter((b) => b.favorite)
    }
    return list.slice().sort((a, b) => {
      // Vault is always pinned first
      if (a.isVault && !b.isVault) return -1
      if (!a.isVault && b.isVault) return 1
      // Then favorites
      if (a.favorite && !b.favorite) return -1
      if (!a.favorite && b.favorite) return 1
      // Then newest message
      return (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
    })
  }, [bookmarks, searchQuery, activeFilter])

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header bar with profile + Linda title + BETA badge + header actions */}
      <View style={styles.headerBar}>
        <Pressable onPress={() => navigation.navigate('Profile')} style={styles.profileBtn}>
          <Avatar id={identity?.id || ''} label={nickname} imageUrl={avatar} size="sm" />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.headerTitle}>Linda</Text>
          <View style={styles.betaBadge}>
            <Text style={styles.betaBadgeText}>BETA</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => navigation.navigate('Discover')} style={styles.headerBtn}>
            <Ionicons name="compass-outline" size={20} color={colors.textPrimary} />
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Contacts')} style={styles.headerBtn}>
            <Ionicons name="people-outline" size={20} color={colors.textPrimary} />
            {incomingCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{incomingCount}</Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>

      {/* Keet Filter Pills Row */}
      <View style={styles.filterPillsRow}>
        <Pressable
          onPress={() => setActiveFilter('all')}
          style={[styles.filterPill, activeFilter === 'all' && styles.filterPillActive]}
        >
          <Text style={[styles.filterPillText, activeFilter === 'all' && styles.filterPillTextActive]}>All</Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveFilter('unread')}
          style={[styles.filterPill, activeFilter === 'unread' && styles.filterPillActive]}
        >
          <Text style={[styles.filterPillText, activeFilter === 'unread' && styles.filterPillTextActive]}>Unread</Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveFilter('favorites')}
          style={[styles.filterPill, activeFilter === 'favorites' && styles.filterPillActive]}
        >
          <Text style={[styles.filterPillText, activeFilter === 'favorites' && styles.filterPillTextActive]}>Favorites</Text>
        </Pressable>
      </View>

      {/* Room list */}
      <FlatList
        data={filteredBookmarks}
        keyExtractor={(item) => item.id}
        renderItem={renderRoom}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="chatbubbles-outline" size={48} color={colors.textTertiary} style={styles.emptyEmoji} />
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyText}>Create a room or join one with an invite link</Text>
          </View>
        }
        contentContainerStyle={filteredBookmarks.length === 0 ? styles.emptyList : undefined}
      />

      {/* FAB */}
      <View style={styles.fabRow}>
        <Pressable
          onPress={() => setShowJoin(true)}
          style={({ pressed }) => [styles.fabSecondary, pressed && styles.fabPressed]}
        >
          <Ionicons name="link-outline" size={20} color={colors.textPrimary} />
        </Pressable>
        <Pressable
          onPress={() => setShowCreate(true)}
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        >
          <Ionicons name="add" size={28} color="#061e27" />
        </Pressable>
      </View>

      {/* Create Room Modal */}
      <Modal visible={showCreate} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Create Room</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Room name"
              placeholderTextColor={colors.textTertiary}
              value={roomName}
              onChangeText={setRoomName}
              autoFocus
            />
            {/* Optional, like the desktop's own create form — it becomes the room's topic. */}
            <TextInput
              style={[styles.modalInput, styles.modalInputMultiline]}
              placeholder="Description (optional)"
              placeholderTextColor={colors.textTertiary}
              value={roomDescription}
              onChangeText={setRoomDescription}
              multiline
              maxLength={280}
            />
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Broadcast (only admins can post)</Text>
              <Switch value={newRoomBroadcast} onValueChange={setNewRoomBroadcast} />
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Publish to Discovery Directory</Text>
              <Switch value={newRoomPublic} onValueChange={setNewRoomPublic} />
            </View>
            <View style={styles.modalActions}>
              <Pressable onPress={() => { setShowCreate(false); setRoomName(''); setRoomDescription(''); setNewRoomBroadcast(false); setNewRoomPublic(false) }} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleCreateRoom}
                disabled={loading || !roomName.trim()}
                style={({ pressed }) => [styles.modalConfirm, pressed && styles.buttonPressed]}
              >
                <Text style={styles.modalConfirmText}>{loading ? 'Creating...' : 'Create'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Room options — see handleRoomOptions for why this is not an Alert */}
      <Modal visible={!!roomOptions} transparent animationType="fade" onRequestClose={() => setRoomOptions(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setRoomOptions(null)}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle} numberOfLines={1}>{roomOptions?.name}</Text>

            <Pressable
              style={styles.optionRow}
              onPress={() => {
                const o = roomOptions
                setRoomOptions(null)
                if (o) void session?.setRoomFavorite(o.id, !o.isFavorite).then(refresh)
              }}
            >
              <Ionicons name={roomOptions?.isFavorite ? 'star' : 'star-outline'} size={18} color={colors.textSecondary} />
              <Text style={styles.optionText}>
                {roomOptions?.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
              </Text>
            </Pressable>

            {roomOptions?.isCleared ? (
              <Pressable
                style={styles.optionRow}
                onPress={() => {
                  const o = roomOptions
                  setRoomOptions(null)
                  if (o) handleRestoreHistory(o.id, o.name)
                }}
              >
                <Ionicons name="refresh-outline" size={18} color={colors.cyan} />
                <Text style={[styles.optionText, { color: colors.cyan }]}>Restore Chat History</Text>
              </Pressable>
            ) : null}

            <Pressable
              style={styles.optionRow}
              onPress={() => {
                const o = roomOptions
                setRoomOptions(null)
                if (o) handleClearHistory(o.id, o.name)
              }}
            >
              <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
              <Text style={styles.optionText}>Clear Chat History</Text>
            </Pressable>

            <Pressable
              style={styles.optionRow}
              onPress={() => {
                const o = roomOptions
                setRoomOptions(null)
                if (o) handleLeaveRoom(o.id, o.name)
              }}
            >
              <Ionicons name="trash-outline" size={18} color={colors.error} />
              <Text style={[styles.optionText, { color: colors.error }]}>Leave and Delete Room</Text>
            </Pressable>

            <Pressable style={styles.optionRow} onPress={() => setRoomOptions(null)}>
              <Ionicons name="close" size={18} color={colors.textTertiary} />
              <Text style={[styles.optionText, { color: colors.textTertiary }]}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Join Room Modal */}
      <Modal visible={showJoin} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Join Room</Text>
            <TextInput
              style={[styles.modalInput, styles.inviteInput]}
              placeholder="Paste invite link or key"
              placeholderTextColor={colors.textTertiary}
              value={inviteLink}
              onChangeText={setInviteLink}
              autoFocus
              multiline
              autoCapitalize="none"
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => { setShowJoin(false); setInviteLink('') }} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleJoinRoom}
                disabled={!inviteLink.trim()}
                style={({ pressed }) => [styles.modalConfirm, pressed && styles.buttonPressed]}
              >
                <Text style={styles.modalConfirmText}>Join</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bgPrimary },
  headerBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    backgroundColor: colors.bgSecondary, borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  profileBtn: { marginRight: spacing.md },
  titleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerTitle: {
    fontSize: typography.xl,
    fontWeight: typography.bold,
    color: colors.textPrimary,
  },
  betaBadge: {
    borderWidth: 1,
    borderColor: colors.betaBadge,
    backgroundColor: colors.betaBadgeBg,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.full,
  },
  betaBadgeText: {
    color: colors.betaBadge,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  headerActions: { flexDirection: 'row', gap: spacing.sm },
  headerBtn: { padding: spacing.sm, position: 'relative' },
  badge: {
    position: 'absolute', top: 2, right: 2,
    backgroundColor: colors.cyan, borderRadius: 8,
    minWidth: 16, height: 16, alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 4,
  },
  badgeText: { color: '#061e27', fontSize: 10, fontWeight: typography.bold },
  filterPillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgPrimary,
  },
  filterPill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    borderRadius: radii.full,
    backgroundColor: 'transparent',
  },
  filterPillActive: {
    backgroundColor: colors.accent,
  },
  filterPillText: {
    color: colors.textSecondary,
    fontSize: typography.sm,
    fontWeight: typography.semibold,
  },
  filterPillTextActive: {
    color: '#ffffff',
  },
  empty: { alignItems: 'center', gap: spacing.sm },
  emptyList: { flex: 1, justifyContent: 'center' },
  emptyEmoji: { opacity: 0.4 },
  emptyTitle: { fontSize: typography.lg, fontWeight: typography.semibold, color: colors.textSecondary },
  emptyText: { fontSize: typography.sm, color: colors.textTertiary, textAlign: 'center' },
  fabRow: {
    position: 'absolute', bottom: spacing.xxl, right: spacing.xl,
    flexDirection: 'row', gap: spacing.md, alignItems: 'center',
  },
  fab: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: colors.cyan, alignItems: 'center',
    justifyContent: 'center', elevation: 4,
  },
  fabSecondary: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.bgElevated, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
  },
  fabPressed: { transform: [{ scale: 0.93 }] },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingVertical: spacing.md, paddingHorizontal: spacing.sm,
  },
  optionText: {
    color: colors.textPrimary, fontSize: typography.md,
  },
  modalOverlay: {
    flex: 1, backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.bgSecondary,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: spacing.xxl, gap: spacing.lg,
  },
  modalTitle: {
    fontSize: typography.xl, fontWeight: typography.bold,
    color: colors.textPrimary, textAlign: 'center',
  },
  modalInput: {
    backgroundColor: colors.inputBg, borderRadius: radii.md,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md + 2,
    color: colors.textPrimary, fontSize: typography.md,
    borderWidth: 1, borderColor: colors.border,
  },
  modalInputMultiline: { minHeight: 68, textAlignVertical: 'top' },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  switchLabel: { color: colors.textSecondary, fontSize: typography.sm, flex: 1 },
  inviteInput: { height: 80, textAlignVertical: 'top', fontFamily: 'monospace', fontSize: typography.sm },
  modalActions: { flexDirection: 'row', gap: spacing.md },
  modalCancel: {
    flex: 1, paddingVertical: spacing.md,
    alignItems: 'center', borderRadius: radii.full,
    backgroundColor: colors.bgTertiary,
  },
  modalCancelText: { color: colors.textSecondary, fontSize: typography.md, fontWeight: typography.medium },
  modalConfirm: {
    flex: 1, paddingVertical: spacing.md,
    alignItems: 'center', borderRadius: radii.full,
    backgroundColor: colors.cyan,
  },
  buttonPressed: { transform: [{ scale: 0.98 }] },
  modalConfirmText: { color: '#061e27', fontSize: typography.md, fontWeight: typography.bold },
})
