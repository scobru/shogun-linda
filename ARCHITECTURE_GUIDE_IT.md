# Guida Completa all'Architettura di Linda Pear

Questo documento spiega in modo chiaro, semplice e strutturato come funziona **Linda Pear**, qual è la sua architettura interna, cosa fa ciascun file del progetto e dove trovare le varie funzionalità.

---

## 1. Cos'è Linda Pear (in parole semplici)

**Linda Pear** è un'applicazione di messaggistica e condivisione file **100% Peer-to-Peer (P2P)**, crittografata e **senza alcun server centrale (serverless)**.

A differenza delle app tradizionali (come WhatsApp, Telegram o Signal) o di altre app P2P che usano server di appoggio per inoltrare i messaggi (relay / TURN):
- **Nessun server centrale**: non esiste un database centrale, nessun cloud, nessun login con email o numero di telefono.
- **Nessun relay**: i dati viaggiano esclusivamente da dispositivo a dispositivo (peer-to-peer diretto).
- **Crittografia end-to-end e sovrana**: l'identità dell'utente è una coppia di chiavi crittografiche (derivate da una frase segreta mnemonica di 12 parole).
- **Stack Holepunch**: utilizza le tecnologie open-source create dal team di Holepunch/Keet (*Hypercore*, *Corestore*, *Autobase*, *Hyperbee*, *Hyperswarm*, *Hyperdrive*).

---

## 2. I Pilastri Tecnologici (Lo Stack Holepunch)

Per capire il codice, basta comprendere 6 mattoncini fondamentali:

```
+-------------------------------------------------------------------------+
|                               INTERFACCIA                               |
|  Desktop: Electron *oppure* il runtime Pear + Web Components            |
|           (src/ui/app-shell.ts, src/ui/desktop-host.ts)                 |
|  Mobile:  React Native / Expo + Bare-Kit Worklet (mobile/)              |
+-------------------------------------------------------------------------+
|                          COORDINATORE (SESSION)                         |
|  Gestione stato globale, profili, segnalibri, contatti, canali RPC      |
+------------------------------------+------------------------------------+
|               DATI                 |                RETE                |
|  • Autobase: log ordinato stanze   |  • Hyperswarm: DHT & Holepunching  |
|  • Hyperbee: database chiave/valore|  • Protomux / RPC: typing, ack,    |
|  • Hyperdrive: file & media stream |    richieste scrittura, contatti   |
|  • Corestore: gestore Hypercore    |                                    |
+------------------------------------+------------------------------------+
|                         SICUREZZA & IDENTITÀ                            |
|  • Libsodium / Argon2id: salvataggio locale protetto da passphrase     |
|  • BIP39: 12 parole per backup / recupero account                       |
|  • Epoch Keys: crittografia a rotazione per i messaggi di stanza       |
+-------------------------------------------------------------------------+
```

1. **Hypercore**: un registro (log) a cui si possono solo aggiungere dati in coda (append-only), crittograficamente firmato.
2. **Corestore**: un raccoglitore/gestore che organizza tanti Hypercore sotto diversi nomi/namespace.
3. **Autobase**: coordina più utenti in una stanza. Ciascun membro scrive sul proprio Hypercore; Autobase ordina linearmente tutti i messaggi per creare una cronologia unica e coerente per tutti i partecipanti.
4. **Hyperbee**: un database chiave-valore (simile a un mini-database NoSQL B-Tree) costruito sopra Hypercore o Autobase. Serve per salvare lo stato della stanza, i messaggi, le reazioni, i contatti e i profili.
5. **Hyperswarm & DHT**: la rete distribuita che permette a due nodi di trovarsi su Internet tramite un "topic" (un hash di 32 byte) e aprire una connessione diretta (holepunching NAT), senza passare per server intermedi.
6. **Hyperdrive**: un file-system distribuito P2P. Quando invii un file, questo viene scritto nel tuo drive locale e gli altri membri lo scaricano a blocchi direttamente da te (e chi lo scarica diventa a sua volta seeder).

---

## 3. Mappa dei File e Responsabilità

### 📁 Root del Progetto
- [package.json](package.json): Configurazione dipendenze, script di avvio (`npm run start`, `start:a`, `start:b`), test, packaging Pear ed Electron.
- [build.js](build.js): Compilazione con *esbuild*. Dallo stesso `src/` produce tre bundle — `dist/app.js` (CommonJS, Electron), `dist/pear/app.js` (ESM, con i `node:*` riscritti in `bare-*`, per Pear) e `dist/worker.js` (il worker di sessione, vedi `src/worker/`) — e genera `src/version.ts` dalla versione in `package.json`.
- [index.html](index.html): Entry point GUI della build Electron.
- [pear.js](pear.js) e [pear.html](pear.html): entry point della build Pear. Il campo `main` di `package.json` è `pear.js`: da Pear v2 gli entrypoint HTML non esistono più, quindi `pear run` avvia del JS che fa partire `pear-electron` (il runtime dell'interfaccia) e `pear-bridge` (che gli serve `pear.html`).
- [forge.config.cjs](forge.config.cjs): Packaging Electron Forge (`.msix` su Windows, `.zip` su macOS/Linux). L'hook `packageAfterCopy` scrive `main: electron/main.cjs` nella copia pacchettizzata, dato che il `main` di `package.json` appartiene a Pear.
- [style.css](style.css): Foglio di stile CSS completo dell'interfaccia desktop (temi, layout, bolle chat, modali).
- [test.js](test.js): Runner dei test di integrazione basato sul test runner nativo di Node.js.

---

### 📁 `src/` (Il Cuore Condiviso)

Il codice in `src/` contiene tutta la logica di business pura, indipendente dalla piattaforma, ed è
condiviso da tutti e tre i runtime: Electron (Node), Pear (Bare) e il worklet mobile (Bare). Tutto
ciò che usa un builtin `node:` privo di equivalente Bare va **iniettato**, non importato, altrimenti
rompe gli altri due in fase di *bundle* — vedi `SwarmTransport.createLanDiscovery` e il
`createMediaServer` di `Session`, i due casi in cui è già successo.

- [main.ts](src/main.ts): Entry point di entrambi i bundle desktop — avvia il flusso di identità e monta `<app-shell>`.
- `src/types/`: Dichiarazioni ambient scritte a mano per i pacchetti Holepunch che non portano tipi propri (`autobase`, `hyperbee`, il gruppo `holepunch*`), più `pear.d.ts` per le global del runtime Pear e `lan-discovery-deps.d.ts` per `multicast-dns`.

#### 🔐 `src/identity/` (Gestione Identità e Chiavi)
- [index.ts](src/identity/index.ts): Punto di ingresso per creare, sbloccare, recuperare e associare l'identità.
- [keypair.ts](src/identity/keypair.ts): Generazione della coppia di chiavi crittografiche (pubblica/privata Ed25519) usando `hypercore-crypto`.
- [mnemonic.ts](src/identity/mnemonic.ts): Gestione della frase di recupero a 12 parole (standard BIP39). Converte le 12 parole nel seed delle chiavi.
- [storage.ts](src/identity/storage.ts): Salvataggio sicuro su disco di `identity.json`. La chiave privata viene cifrata con algoritmo **Argon2id** (`crypto_pwhash`) + `crypto_secretbox` protetta dalla password dell'utente.
- [pairing.ts](src/identity/pairing.ts): Accoppiamento tra dispositivi via QR Code. Un dispositivo già sbloccato apre un canale temporaneo su Hyperswarm; il nuovo dispositivo scansiona il codice ed eredita l'identità in modo sicuro e cifrato.
- [profile.ts](src/identity/profile.ts): Gestione del profilo base (nickname, avatar).

---

#### 🌐 `src/network/` (Networking P2P e Comunicazione in Tempo Reale)
- [swarm.ts](src/network/swarm.ts): Configura e avvia **Hyperswarm**. Gestisce le connessioni in entrata/uscita e il bootstrap della DHT.
- [rpc.ts](src/network/rpc.ts): Protocollo RPC (`linda-rpc/1`) basato su **Protomux**. Gestisce i messaggi istantanei che non devono essere salvati nello storico (es. "sta scrivendo...", presenza online/offline, ricevute di lettura, richieste di scrittura per entrare in una stanza, annunci stanze pubbliche e scambio chiavi di crittografia).
- [encoding.ts](src/network/encoding.ts): Serializzazione binaria compatta (`compact-encoding`) per tutti i messaggi RPC scambiati via socket.
- [lobby.ts](src/network/lobby.ts): Topic globale ("lobby") su cui i nodi possono opzionalmente annunciare stanze pubbliche per la scoperta automatica.
- [lan-discovery.ts](src/network/lan-discovery.ts): Scoperta mDNS opzionale, per una LAN senza uscita su Internet, in parallelo alla DHT. **Solo Electron**: dipende da `multicast-dns`, che richiede `node:dgram`; nei bundle Pear e mobile viene sostituito da [lan-discovery-stub.ts](src/network/lan-discovery-stub.ts).

---

#### 💬 `src/rooms/` (Gestione Stanze, Messaggi e Permessi)
- [room.ts](src/rooms/room.ts): **Uno dei file più importanti dell'applicazione.**
  - Gestisce la stanza basata su **Autobase** e indicizzata con **Hyperbee**.
  - **Funzione `apply()`**: elabora e valida linearmente tutti gli eventi della stanza (invio messaggi, modifiche, cancellazioni, reazioni emoji, aggiunta scrittori, permessi admin/moderatore/mute/ban, modalità broadcast).
  - **Governance Multi-Admin (stile Keet)**: supporta la promozione/degradazione di più amministratori (`promoteAdmin`, `demoteAdmin`). I co-admin possono autorizzare nuovi scrittori e validare gli inviti anche quando il creatore della stanza è offline.
  - **Crittografia dei messaggi**: supporta la rotazione delle chiavi (*Epoch Keys*) per proteggere i messaggi scambiati nella stanza.
  - **Reazioni & Modifiche**: registra gli "overlay" sui messaggi senza rompere l'immutabilità del registro originale.

---

#### 📁 `src/files/` (Condivisione File e Streaming Audio/Video)
- [drive.ts](src/files/drive.ts): `FileStore` integrato con **Hyperdrive**. Scrive i file sul proprio drive locale per la condivisione P2P.
- [media-range.ts](src/files/media-range.ts): Gestisce le intestazioni HTTP `Range` (es. `bytes=0-1048576`) per consentire la riproduzione istantanea di audio e video con seek temporale.
- [media-server.ts](src/files/media-server.ts): Logica agnostica del mini web-server locale protetto da token segreto di sessione (`/<token>/<driveKey>/<filePath>`).
- [media-server-node.ts](src/files/media-server-node.ts): Implementazione del server HTTP per ambiente Node/Electron su porta loopback locale (`127.0.0.1`).

---

#### 🧠 `src/app/` (Orchestrazione e Stato Utente)
- [session.ts](src/app/session.ts): **Il regista principale dell'applicazione.**
  - Collega identità, rete (`Hyperswarm`), stanze (`Room`), storage file (`Hyperdrive`), profilo e rubrica contatti.
  - Gestisce il ciclo di vita: sblocco, apertura stanze, join tramite link di invito, autorizzazione di nuovi membri (delegata a qualsiasi admin online), invio messaggi e allegati, download file remoti.
  - **Gestione Cronologia Locale**: implementa `clearRoomHistory` (filtro locale `clearedAt` senza toccare il log distribuito) e `restoreRoomHistory` (ripristino istantaneo da storage locale senza riscaricare da rete).
  - **Device Pairing**: esporta e importa snapshot sicuri per clonare l'identità e sincronizzare contatti, stanze e chiavi epoch tra dispositivi.
- [profile-store.ts](src/app/profile-store.ts): Gestione persistente su **Hyperbee** di:
  - Segnalibri delle stanze salvate (`bookmarks`).
  - Lista contatti e richieste pendenti (`contacts`).
  - Chiavi di crittografia delle stanze (`room_keys`).
  - Token di invito (`room_invites`).
  - Avatar personalizzati dei contatti (`peer_avatars`).
  - Preferenze locali (sfondo chat, nickname).
- [session-view.ts](src/app/session-view.ts): L'interfaccia che la UI ha il permesso di vedere. `SessionView` e `RoomView` sono `Pick<>` sulle classi reali: la UI compila contro il sottoinsieme che può sopravvivere al passaggio attraverso un confine RPC, e un membro aggiunto a `Session` senza equivalente sul filo fa fallire il typecheck invece che il runtime.
- [open-session.ts](src/app/open-session.ts) / [open-session-worker.ts](src/app/open-session-worker.ts): I due lanciatori. Il primo apre una `Session` in questo processo (Electron/Pear), il secondo parla con una che gira nel worker. `build.js` scambia l'uno con l'altro a seconda del target, così nessuno dei due finisce mai nel bundle dell'altro.

---

#### ⚙️ `src/worker/` e `src/transport/` (Sessione Fuori Processo)

La sessione può girare fuori dal processo dell'interfaccia — su mobile funziona così da sempre, con
`src/` dentro un worklet Bare e React Native che ci parla via IPC. Queste due cartelle sono quel
confine, condiviso invece che reimplementato per piattaforma.

- [worker/entry.ts](src/worker/entry.ts): Avvia una `Session` dentro il worker e la collega alla pipe.
- [worker/dispatcher.ts](src/worker/dispatcher.ts): Traduce le chiamate dal filo in chiamate a `Session`/`Room` e spinge nella direzione opposta gli eventi (sta scrivendo, ricevute di lettura, peer connessi/disconnessi).
- [transport/frame.ts](src/transport/frame.ts): Il formato di frame condiviso dai due lati — `<lunghezza header 4 byte LE><header JSON><coda binaria>` — così i byte di un file viaggiano sullo stesso canale senza passare per il base64.
- [transport/rpc-client.ts](src/transport/rpc-client.ts): La metà che chiama.
- [transport/remote-session-view.ts](src/transport/remote-session-view.ts) e [remote-room-view.ts](src/transport/remote-room-view.ts): Implementazioni di `SessionView`/`RoomView` appoggiate a quell'RPC, così il codice della UI non può accorgersi se la sessione sia in questo processo o in un altro.

---

#### 🖥️ `src/ui/` (Interfaccia Desktop)
- [app-shell.ts](src/ui/app-shell.ts): Il Web Component principale `<app-shell>` che renderizza l'intera interfaccia desktop: schermata di sblocco/creazione account, lista stanze, area chat, invio messaggi vocali e file, modali di invito, gestione membri e impostazioni.
- [qr.ts](src/ui/qr.ts) e [qr-core.ts](src/ui/qr-core.ts): Generazione e scansione dei QR code (per inviti stanze e pairing dispositivi).
- [desktop-host.ts](src/ui/desktop-host.ts): I comandi finestra che servono alla shell (riduci, ingrandisci, chiudi, stato ingrandito) dietro un'unica interfaccia, con `ElectronHost`, `PearHost` e `WebHost` sotto: i due runtime desktop espongono API completamente diverse per gli stessi tre pulsanti.
- [wallpapers.ts](src/ui/wallpapers.ts): Sfondi chat personalizzabili (gradienti e motivi geometrici).
- [app-backgrounds.ts](src/ui/app-backgrounds.ts): Sfondi della cornice dell'app, distinti da quelli della chat.
- [room-presets.ts](src/ui/room-presets.ts): Icone e descrizioni preimpostate proposte alla creazione di una stanza.

---

#### 🛠️ `src/util/` (Utility Generali)
- [avatar.ts](src/util/avatar.ts): Generazione automatica di avatar colorati basati sull'hash della chiave pubblica.
- [bytes.ts](src/util/bytes.ts): Formattazione della dimensione dei file (es. `KB`, `MB`, `GB`).
- [hashtag.ts](src/util/hashtag.ts): Riconoscimento ed evidenziazione degli hashtag nei messaggi (`extractHashtags`, `hasHashtag`, `splitOnHashtags`, `linkifyHashtags`). Non gestisce menzioni: non esistono.
- [id.ts](src/util/id.ts): Generatore di identificativi casuali sicuri esadecimali.

---

### 🖥️ `electron/` (Involucro Desktop)
- [main.cjs](electron/main.cjs): Processo principale di Electron. Crea la finestra, configura i permessi di sicurezza (microfono per messaggi vocali, cattura schermo, clipboard) e carica `index.html`.
- [preload.cjs](electron/preload.cjs): Script di preload leggero per esporre funzionalità di sistema (es. scrittura appunti).

---

### 📱 `mobile/` (Applicazione Mobile Expo / React Native)
- [App.tsx](mobile/App.tsx): Entry point React Native con provider del tema e navigazione.
- [mobile/worklet/entry.ts](mobile/worklet/entry.ts): Il **cuore P2P mobile**. Esegue l'intero core di `src/` dentro un processo di background nativo (*Bare Kit Worklet*), comunicando con la UI tramite messaggi IPC asincroni serializzati.
- [mobile/worklet/media-server.ts](mobile/worklet/media-server.ts): Server multimediale per lo streaming su mobile basato su `bare-http1`.
- `mobile/src/bare/`: Proxy client e bridge di comunicazione tra l'interfaccia React Native e il worklet Bare.
- `mobile/src/screens/`: Tutte le schermate mobile (Chat, Lista Stanze, Contatti, Profilo, Membri, Pairing QR, Sblocco).
- `mobile/src/components/`: Componenti riutilizzabili (Bolle chat, Player Video/Audio, Avatar, Modali).

---

### 🧪 `test/` (Suite di Test Automatizzati)
Si eseguono con `npm test`, oppure con `LINDA_TEST_DHT=public npm test` per far girare le stesse
verifiche sulla DHT pubblica invece che su quella di test in-process.

- [session.test.ts](test/session.test.ts): Test end-to-end con due nodi `Session` reali che si connettono, scambiano permessi di scrittura e replicano dati su una rete DHT locale di test.
- [room.test.ts](test/room.test.ts): Test approfonditi su Autobase: ordinamento messaggi, modifiche, reazioni, ban, mute e ruoli.
- [security.test.ts](test/security.test.ts): Test di sicurezza e resistenza alle manomissioni (messaggi non autorizzati, tentativi di spoofing).
- [media-stream.test.ts](test/media-stream.test.ts), [media-range.test.ts](test/media-range.test.ts) e [media-transport.test.ts](test/media-transport.test.ts): Streaming a blocchi (Range request) dei file multimediali e trasporto sottostante.
- [room-files.test.ts](test/room-files.test.ts) e [drive-reuse.test.ts](test/drive-reuse.test.ts): Condivisione e indicizzazione dei file nelle stanze, e riuso del drive.
- [contact-invite.test.ts](test/contact-invite.test.ts): Flusso di invito contatti e apertura chat 1-a-1.
- [rejoin-restart.test.ts](test/rejoin-restart.test.ts): Un permesso di scrittura che deve sopravvivere a un riavvio, perché il proprietario non c'era quando l'invito è stato presentato.
- [room-open-retry.test.ts](test/room-open-retry.test.ts): Fissa l'invariante da cui dipende un primo join — un solo `Room.open` per namespace del corestore.
- [worker-bootstrap.test.ts](test/worker-bootstrap.test.ts), [remote-session.test.ts](test/remote-session.test.ts) e [mirror-parity.test.ts](test/mirror-parity.test.ts): Il trasporto verso il worker, le view remote che ci si appoggiano, e il controllo che la superficie rispecchiata non sia andata alla deriva rispetto a `SessionView`.
- [lan-discovery.test.ts](test/lan-discovery.test.ts), [hashtag.test.ts](test/hashtag.test.ts) e [wallpapers.test.ts](test/wallpapers.test.ts): Scoperta mDNS, parsing degli hashtag, sfondi preimpostati.

---

## 4. Come Funzionano i Flussi Chiave

### A. Creazione e Sblocco Identità
1. All'avvio, `storage.ts` controlla se esiste `identity.json`.
2. Se non esiste: `mnemonic.ts` genera 12 parole casuali; da queste si ricava la coppia di chiavi. L'utente sceglie una password locale, che cifra la chiave segreta tramite Argon2id.
3. Se esiste: l'utente inserisce la password, `storage.ts` decifra la chiave privata e inizializza `Session`.

### B. Invio di un Messaggio in una Stanza
1. L'utente digita il testo e preme Invio.
2. La UI invoca `room.send(authorId, body, replyTo?)` ([app-shell.ts](src/ui/app-shell.ts) sul desktop; su mobile la stessa chiamata attraversa prima l'RPC verso il worker).
3. Il messaggio viene cifrato con la chiave segreta della stanza corrente (*Epoch Key*).
4. Viene appeso al log locale Hypercore della stanza tramite **Autobase**.
5. Autobase propaga automaticamente il nuovo blocco attraverso la connessione **Hyperswarm** a tutti i peer connessi.
6. Ciascun peer esegue la funzione deterministica `apply()`, che valida l'autore e indicizza la voce nella vista messaggi linearizzata, poi notifica la UI. `apply()` **non** decifra: quello che viene salvato è il testo cifrato, ed è `getMessage()` a decifrarlo in lettura (vedi `decryptText` in [room.ts](src/rooms/room.ts)).

### C. Condivisione e Streaming di un Video o Canzone
1. L'utente seleziona un file video da inviare.
2. `FileStore` (`drive.ts`) aggiunge il file nel proprio **Hyperdrive** locale.
3. Viene inviato un messaggio di chat contenente i metadati (`driveKey`, percorso, nome, dimensione, tipo MIME).
4. Il file compare sia nella chat sia nella scheda **File della Stanza** — che non è un canale separato ma un indice sugli stessi messaggi: `apply()` ne ricava un record sotto `file/${messageId}` nella vista `state`.
5. Quando un altro peer clicca "Play", il player multimediale locale contatta il server HTTP interno (`media-server.ts`) richiedendo i byte necessari (`Range: bytes=0-...`).
6. Il server legge solo i blocchi richiesti dal drive remoto tramite la connessione P2P esistente, permettendo la riproduzione immediata senza dover scaricare l'intero file in anticipo.

### D. Gestione Multi-Admin e Autorizzazione Scrittura (Peer Model)
1. Il creatore della stanza può promuovere qualsiasi membro ad **Admin** tramite `room.promoteAdmin(identityId)` o a **Moderator** tramite `room.promoteToModerator(identityId)`.
2. L'operazione appende un'entry deterministica (`promoteAdmin`) sul log Autobase. Tutti i peer connessi aggiornano la lista degli admin indicizzata in Hyperbee.
3. Quando un nuovo partecipante si unisce con un link di invito (`bootstrapKey:inviteCode`), invia una richiesta RPC `requestWriteIfNeeded` attraverso Protomux a tutti i peer connessi.
4. Qualsiasi **co-admin attualmente online** verifica che il codice di invito corrisponda a quello registrato nello stato Autobase ed emette `room.addWriter(writerKey, identityId)`.
5. Il nuovo membro riceve i permessi di scrittura e la chiave epoch crittografica anche se l'owner originale è offline, garantendo la totale autonomia e decentralizzazione della stanza.

### E. Pulizia e Ripristino Cronologia (Clear & Restore Chat History)
1. Quando l'utente seleziona "Clear Chat History", viene invocato `session.clearRoomHistory(roomId)`.
2. Il metodo **non tocca il log Autobase/Hypercore** locale né invia comandi di cancellazione agli altri peer: imposta semplicemente `clearedAt = Date.now()` nel segnalibro locale (`RoomBookmark`).
3. L'interfaccia filtra i messaggi visualizzati con `timestamp > clearedAt`, nascondendo la cronologia passata da questo specifico dispositivo.
4. Cliccando **"Restore Chat History"**, `session.restoreRoomHistory(roomId)` rimuove il campo `clearedAt`.
5. I messaggi precedenti riappaiono istantaneamente a schermo, letti direttamente dal database locale senza consumare banda di rete né dipendere dalla presenza online di altri utenti.

### F. Accoppiamento P2P tra Dispositivi (Device Pairing)
1. Il dispositivo primario (già sbloccato) apre la schermata "Pair a Device", generando un token segreto casuale e annunciando un topic effimero su Hyperswarm.
2. Viene mostrato a schermo un codice QR contenente le coordinate del topic e la chiave di cifratura simmetrica.
3. Il nuovo dispositivo inquadra il QR con la fotocamera (`expo-camera` su mobile o scanner su desktop) e si connette al topic Hyperswarm.
4. Il dispositivo primario esporta uno snapshot completo (`getPairingSnapshot`): nickname, avatar, contatti accettati, segnalibri delle stanze e tutte le chiavi crittografiche *Epoch Keys* accumulate.
5. Il nuovo dispositivo importa lo snapshot (`importPairingSnapshot`), escludendo i campi strettamente locali al dispositivo (come `clearedAt` o preferiti locali), e apre le stanze sincronizzate.

### G. Richieste Contatto e Creazione Automatica Chat 1-a-1
1. Un utente crea un link di invito contatto via `session.createContactInvite()`. Il link (`linda-pear://...`) contiene l'ID pubblico dell'autore e la chiave bootstrap di una stanza privata pre-creata.
2. Il destinatario incolla il link e invia una richiesta di contatto (`sendContactRequest`).
3. La richiesta appare nella sezione **Contacts** come "Richiesta in Arrivo".
4. Accettando la richiesta (`respondToContact`), entrambi i client registrano il contatto come `accepted`, scambiano i permessi di scrittura nella stanza 1:1 e aprono la chat privata cifrata end-to-end.

### H. Personal Vault Sovrano (Single-Writer Encrypted Space)
1. Ogni identità dispone di una stanza speciale riservata denominata **Personal Vault** (`isVault: true`, `favorite: true`), creata o recuperata in modo idempotente all'avvio con `session.ensurePersonalVault()`.
2. A differenza delle normali stanze di gruppo o 1:1, il Personal Vault è uno spazio **single-writer**: solo l'utente locale (e i suoi dispositivi associati) possiede la chiave di scrittura su Autobase. Non essendoci scrittori remoti, le operazioni di scrittura sono istantanee, prive di conflitti e completamente offline-first.
3. Nel segnalibro locale (`RoomBookmark`), il campo `isVault: true` assicura che il vault appaia in cima alla lista stanze con badge dorato `🔐 VAULT`.
4. Durante il pairing P2P (`getPairingSnapshot` / `importPairingSnapshot`), il flag `isVault` e `favorite` vengono preservati e replicati sui dispositivi secondari (desktop o smartphone), consentendo un archivio personale di note cifrate, password e file privati accessibile su tutto il proprio hardware.

### I. Viste Adattive dei Messaggi (Chat, Mailbox, Note, File)
1. Una stanza Autobase memorizza un registro immutabile e causale di messaggi (`body`, `file`, `reactions`, `timestamp`).
2. Il livello di presentazione desktop (`app-shell.ts`) proietta questa singola sequenza di dati in 4 prospettive specializzate tramite un selettore a tab:
   - **Chat**: Feed standard a bolle conversazionali.
   - **Mailbox**: Layout asincrono a doppio pannello in stile client email (a sinistra la lista messaggi con anteprima, mittente e data; a destra il riquadro di lettura formale con badge di cifratura E2E, dettagli mittente/destinatari, allegati dedicati e barra di risposta rapida).
   - **Note / Document**: Visualizzazione a documento continuo senza bolle di chat, con divisori per data e tipografia lineare. Ottimale per articoli lunghi, verbali di riunione e per consultare il Personal Vault.
   - **File**: Esploratore dei file multimediali estratti dal log e sincronizzati via Hyperdrive.
3. Questa architettura a proiezioni multiple non richiede alcuna migrazione dello schema di Autobase: le diverse viste sono trasformazioni puramente estetiche e funzionali dello stesso registro crittografato.

### J. Roadmap LindaWeb: Bridge WebSocket Zero-Knowledge e Compagno Headless
1. **Il Vincolo del Browser**: I browser web non possono eseguire socket UDP/TCP grezzi o la tabella DHT di Hyperswarm a causa della sandbox di sicurezza; WebRTC richiede server STUN/TURN centralizzati esterni.
2. **La Soluzione Sovereign**: Un nodo compagno leggero headless (`linda-daemon` o il client desktop stesso) funge da bridge locale/remoto esponendo un endpoint WebSocket autenticato (`linda-bridge`).
3. **Zero-Knowledge sul Filo**:
   - La frase mnemonica di 12 parole e le chiavi Ed25519 risiedono unicamente nel browser (IndexedDB cifrato con WebCrypto).
   - Il client web compila le primitive crittografiche in WASM (`libsodium-wrappers`), cifrando e decifrando tutti i messaggi localmente sul dispositivo dell'utente.
   - Il bridge WebSocket inoltra unicamente frame cifrati e pacchetti di sincronizzazione Hypercore, senza alcuna possibilità di leggere il contenuto delle conversazioni o forgiare firme utente.

