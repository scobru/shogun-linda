import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import b4a from 'b4a'
import { generateKeypair } from '../src/identity/keypair.js'
import { Session } from '../src/app/session.js'
import type { Identity } from '../src/identity/index.js'

function makeIdentity(): Identity {
  const kp = generateKeypair()
  return { ...kp, id: b4a.toString(kp.publicKey, 'hex') }
}

test('personal vault: ensurePersonalVault creates sovereign single-writer room with isVault and favorite flags', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linda-vault-test-'))
  const identity = makeIdentity()
  const session = await Session.create(identity, storageDir, {
    transport: { bootstrap: [] }
  })

  try {
    assert.equal(session.listBookmarks().length, 0, 'session starts without bookmarks')

    const vaultRoom = await session.ensurePersonalVault()
    assert.ok(vaultRoom, 'vault room created')
    assert.equal(vaultRoom.name, 'Personal Vault')

    const bookmarks = session.listBookmarks()
    assert.equal(bookmarks.length, 1, 'one bookmark added for vault')
    const bm = bookmarks[0]!
    assert.equal(bm.id, vaultRoom.id)
    assert.equal(bm.name, 'Personal Vault')
    assert.equal(bm.isVault, true, 'bookmark marked as isVault')
    assert.equal(bm.favorite, true, 'bookmark marked as favorite')

    // Calling ensurePersonalVault() again returns same room and does not duplicate bookmark
    const secondCallRoom = await session.ensurePersonalVault()
    assert.equal(secondCallRoom.id, vaultRoom.id)
    assert.equal(session.listBookmarks().length, 1, 'bookmark is not duplicated')

    // Posting a note to vault
    await vaultRoom.send(identity.id, 'My sovereign secret note #ideas')
    assert.equal(vaultRoom.messageCount, 1)
    const msg = await vaultRoom.getMessage(0)
    assert.ok(msg)
    assert.equal(msg.body, 'My sovereign secret note #ideas')

    // Device pairing snapshot preserves isVault flag
    const snapshot = await session.getPairingSnapshot()
    assert.ok(snapshot.bookmarks)
    const snapshotBookmarks = snapshot.bookmarks as Array<{ isVault?: boolean; favorite?: boolean; name: string }>
    assert.equal(snapshotBookmarks[0]?.isVault, true)

    // Pairing into a second device
    const storageDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'linda-vault-paired-'))
    const session2 = await Session.create(identity, storageDir2, {
      transport: { bootstrap: [] }
    })

    try {
      await session2.importPairingSnapshot(snapshot)
      const pairedBookmarks = session2.listBookmarks()
      assert.equal(pairedBookmarks.length, 1)
      const pairedBm = pairedBookmarks[0]!
      assert.equal(pairedBm.isVault, true, 'paired device has isVault: true')
      assert.equal(pairedBm.favorite, true, 'paired device has favorite: true')
      assert.equal(pairedBm.name, 'Personal Vault')
    } finally {
      await session2.close()
      fs.rmSync(storageDir2, { recursive: true, force: true })
    }
  } finally {
    await session.close()
    fs.rmSync(storageDir, { recursive: true, force: true })
  }
})
