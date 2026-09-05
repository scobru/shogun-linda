import React, { useState, useRef, useMemo, useEffect } from 'react'
import {
  View, TextInput, Pressable, Text, StyleSheet,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system'
import * as ImageManipulator from 'expo-image-manipulator'
import * as VideoThumbnails from 'expo-video-thumbnails'
import {
  useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync,
} from 'expo-audio'
import { Ionicons } from '@expo/vector-icons'
import { spacing, radii, typography, type ThemeColors } from '../theme'
import { useTheme } from '../theme-context'

const THUMBNAIL_WIDTH = 360

/** Mirrors desktop's resizeImageToDataUrl (canvas-based) using expo-image-manipulator, the RN equivalent. */
async function makeThumbnail(uri: string): Promise<string | undefined> {
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: THUMBNAIL_WIDTH } }],
      { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    )
    return result.base64 ? `data:image/jpeg;base64,${result.base64}` : undefined
  } catch {
    return undefined
  }
}

/**
 * Poster frame for a video, resized through the same path as an image thumbnail so both travel
 * as one small data URL in the message.
 *
 * Grabbed a second in rather than at frame zero: recordings very often open on a black frame,
 * which would make every video look like a broken image in the chat.
 */
async function makeVideoPoster(uri: string): Promise<string | undefined> {
  try {
    const { uri: frame } = await VideoThumbnails.getThumbnailAsync(uri, { time: 1000, quality: 0.7 })
    return await makeThumbnail(frame)
  } catch {
    // Codecs this device cannot decode, and video too short to seek into, both land here; the
    // message still sends, just without a poster.
    return undefined
  }
}

interface Props {
  onSend: (text: string) => void
  onAttach?: (name: string, mimeType: string, base64: string, thumbnail?: string) => void
  replyTo?: { id: string; body: string; authorName: string } | null
  editingMessage?: { id: string; body: string } | null
  placeholder?: string
  onCancelReply?: () => void
  onCancelEdit?: () => void
  onSubmitEdit?: (id: string, body: string) => void
  onChangeText?: (text: string) => void
}

export default function MessageComposer({
  onSend, onAttach, replyTo, editingMessage, placeholder, onCancelReply, onCancelEdit, onSubmitEdit, onChangeText,
}: Props) {
  const { colors } = useTheme()
  const styles = useMemo(() => createStyles(colors), [colors])
  const [attaching, setAttaching] = useState(false)
  const inputRef = useRef<TextInput>(null)

  /**
   * What is actually in the field. The field itself is uncontrolled on purpose: a `value` prop
   * fights Android's predictive keyboard, because while the IME holds a composing region
   * `onChangeText` arrives late, React then re-renders with the older value and rewrites the field
   * back to it. Typed words vanished mid-sentence ("Ciao ciao" reverting to "Ciao"), and the
   * control beside them — which used to switch between send and mic on that same lagging state —
   * changed meaning under the user's thumb: taps meant for send started a voice recording.
   *
   * A press event is delivered after every keystroke event already queued ahead of it, so this ref
   * is up to date by the time a handler reads it even when the rendered button is behind.
   */
  const textRef = useRef(editingMessage?.body ?? '')
  /** Drives the send button's look only. Allowed to lag; nothing destructive hangs off it. */
  const [hasText, setHasText] = useState((editingMessage?.body ?? '').trim().length > 0)
  /** Bumped to remount the field on the one path where the app itself has to put text into it:
   * entering edit mode. `setNativeProps` is not available under the new architecture, a remount
   * with a fresh `defaultValue` is — while clearing after a send uses the native `clear()` command,
   * which keeps focus and the keyboard up. */
  const [inputGeneration, setInputGeneration] = useState(0)

  // When editingMessage changes, put its body in the field
  React.useEffect(() => {
    if (!editingMessage) return
    textRef.current = editingMessage.body
    setHasText(editingMessage.body.trim().length > 0)
    setInputGeneration((generation) => generation + 1)
  }, [editingMessage?.id])

  // Separate from the effect above so it runs after the remount that effect asks for, which is
  // what drops the focus in the first place.
  React.useEffect(() => {
    if (editingMessage) inputRef.current?.focus()
  }, [inputGeneration])

  const handleSend = () => {
    const trimmed = textRef.current.trim()
    if (!trimmed) return

    // Emptied before the send handler runs, not after it resolves: a second tap on a send that has
    // not visibly completed then finds nothing left to send. Four identical one-letter messages in
    // a row is what the old ordering looked like on a busy JS thread.
    textRef.current = ''
    setHasText(false)
    inputRef.current?.clear()

    if (editingMessage) {
      onSubmitEdit?.(editingMessage.id, trimmed)
    } else {
      onSend(trimmed)
    }
  }

  // Voice messages ride the same path as any other attachment — the receiving side already
  // recognises audio by extension and renders a player for it (see ChatBubble's isAudioFile).
  // expo-audio types RecordingPresets as Record<string, RecordingOptions>, so
  // noUncheckedIndexedAccess sees HIGH_QUALITY as possibly undefined — it isn't, it's a fixed
  // export of the library.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY!)
  const [recording, setRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setRecordSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [recording])

  const startRecording = async () => {
    try {
      const permission = await requestRecordingPermissionsAsync()
      if (!permission.granted) {
        Alert.alert('Microphone blocked', 'Allow microphone access to record a voice message.')
        return
      }
      // Without this the recorder is silent on iOS, where capture is off by default.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      recorder.record()
      setRecordSeconds(0)
      setRecording(true)
    } catch (err) {
      Alert.alert('Could not start recording', (err as Error).message)
    }
  }

  const stopRecording = async (send: boolean) => {
    setRecording(false)
    try {
      await recorder.stop()
      // Restores playback routing — left on, the earpiece stays selected and playback is quiet.
      await setAudioModeAsync({ allowsRecording: false })
      const uri = recorder.uri
      if (!send || !uri) return
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
      const name = `voice-${new Date().toISOString().replace(/[:.]/g, '-')}.m4a`
      onAttach?.(name, 'audio/m4a', base64)
    } catch (err) {
      Alert.alert('Could not save recording', (err as Error).message)
    }
  }

  const handleAttach = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
    const asset = result.assets?.[0]
    if (result.canceled || !asset) return
    setAttaching(true)
    try {
      const mimeType = asset.mimeType || 'application/octet-stream'
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
      const thumbnail = mimeType.startsWith('image/')
        ? await makeThumbnail(asset.uri)
        : mimeType.startsWith('video/')
          ? await makeVideoPoster(asset.uri)
          : undefined
      onAttach?.(asset.name, mimeType, base64, thumbnail)
    } finally {
      setAttaching(false)
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Reply banner */}
      {replyTo && (
        <View style={styles.banner}>
          <View style={styles.bannerContent}>
            <Text style={styles.bannerLabel}>Replying to {replyTo.authorName}</Text>
            <Text style={styles.bannerPreview} numberOfLines={1}>{replyTo.body}</Text>
          </View>
          <Pressable onPress={onCancelReply} style={styles.bannerClose}>
            <Ionicons name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        </View>
      )}

      {/* Edit banner */}
      {editingMessage && (
        <View style={[styles.banner, styles.bannerEdit]}>
          <View style={styles.bannerContent}>
            <Text style={styles.bannerLabel}>Editing message</Text>
            <Text style={styles.bannerPreview} numberOfLines={1}>{editingMessage.body}</Text>
          </View>
          <Pressable onPress={onCancelEdit} style={styles.bannerClose}>
            <Ionicons name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        </View>
      )}

      {/* Recording row — replaces the composer while a voice message is being captured */}
      {recording ? (
        <View style={styles.container}>
          <Pressable onPress={() => void stopRecording(false)} style={styles.attachButton}>
            <Ionicons name="trash-outline" size={20} color={colors.error} />
          </Pressable>
          <View style={styles.recordingStatus}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>
              Recording  {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, '0')}
            </Text>
          </View>
          <Pressable onPress={() => void stopRecording(true)} style={[styles.sendButton, styles.sendButtonPressed]}>
            <Ionicons name="send" size={16} color="#061e27" />
          </Pressable>
        </View>
      ) : (
      /* Input row */
      <View style={styles.container}>
        {onAttach && !editingMessage && (
          <Pressable
            onPress={handleAttach}
            disabled={attaching}
            style={({ pressed }) => [styles.attachButton, pressed && styles.attachButtonPressed]}
          >
            {attaching ? <Text style={styles.attachIcon}>...</Text> : <Ionicons name="add" size={22} color={colors.textPrimary} />}
          </Pressable>
        )}
        <TextInput
          key={inputGeneration}
          ref={inputRef}
          style={styles.input}
          defaultValue={textRef.current}
          onChangeText={(t) => {
            textRef.current = t
            // Returning the same value skips the render: this fires on every keystroke, and the
            // button only cares whether the field crossed between empty and non-empty.
            const filled = t.trim().length > 0
            setHasText((was) => (was === filled ? was : filled))
            onChangeText?.(t)
          }}
          placeholder={placeholder || "Message"}
          placeholderTextColor={colors.textTertiary}
          multiline
          maxLength={4000}
        />
        {/* Mic and send are two buttons rather than one that swaps between them. The swap was
            decided by whether the field looked empty to React, so whenever that lagged behind the
            keyboard the control under the user's thumb quietly became the other one. */}
        {onAttach && !editingMessage && (
          <Pressable
            onPress={() => void startRecording()}
            style={({ pressed }) => [styles.micButton, pressed && styles.attachButtonPressed]}
          >
            <Ionicons name="mic" size={18} color={colors.textSecondary} />
          </Pressable>
        )}
        <Pressable
          onPress={handleSend}
          // Deliberately never `disabled`: `hasText` is allowed to lag, and a send that ignores a
          // tap because React has not caught up yet is the bug this file is fixing. handleSend
          // reads the field's real contents and does nothing when they are empty.
          style={({ pressed }) => [
            styles.sendButton,
            !hasText && styles.sendButtonIdle,
            pressed && styles.sendButtonPressed,
          ]}
        >
          <Ionicons name={editingMessage ? 'checkmark' : 'send'} size={16} color={hasText ? '#061e27' : colors.textTertiary} />
        </Pressable>
      </View>
      )}
    </KeyboardAvoidingView>
  )
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.inputBg,
    borderRadius: radii.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : 6,
    color: colors.textPrimary,
    fontSize: typography.md,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  recordingStatus: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.inputBg,
    borderRadius: radii.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  recordingDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.error,
  },
  recordingText: {
    color: colors.textSecondary,
    fontSize: typography.md,
    fontVariant: ['tabular-nums'],
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Nothing typed yet: the button stays there and stays tappable, it just recedes. */
  sendButtonIdle: {
    backgroundColor: 'transparent',
    opacity: 0.4,
  },
  micButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonPressed: {
    backgroundColor: colors.cyanLight,
    transform: [{ scale: 0.95 }],
  },
  sendIcon: {
    color: '#061e27',
    fontSize: 16,
    fontWeight: typography.bold,
  },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    // Was a hardcoded dark navy — in light mode that left a near-invisible dark icon
    // (colors.textPrimary, near-black in light mode) sitting on an equally dark button.
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButtonPressed: {
    opacity: 0.5,
  },
  attachIcon: {
    fontSize: 20,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgTertiary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  bannerEdit: {
    borderLeftColor: colors.warning,
  },
  bannerContent: {
    flex: 1,
  },
  bannerLabel: {
    color: colors.accentLight,
    fontSize: typography.xs,
    fontWeight: typography.semibold,
  },
  bannerPreview: {
    color: colors.textSecondary,
    fontSize: typography.sm,
    marginTop: 1,
  },
  bannerClose: {
    padding: spacing.sm,
  },
  bannerCloseText: {
    color: colors.textTertiary,
    fontSize: 16,
  },
})
