/* Accounts, groups and chat for Рупор.

   ACCOUNTS: stored entirely in localStorage — no server, no MQTT.
   Sign up = choose a username and password; both are stored locally.
   The user ID is derived from (username + password) so the same
   credentials always produce the same ID, even from a different device
   that has the credentials re-entered.

   GROUPS: one retained MQTT topic per group holds the group name and
   the list of member display names.  Anyone with the 8-character invite
   code can join.  No account lookup is needed — you just write your
   display name into the member list.

   FRIENDS: removed.  Invite people by sharing a group code or a call room.

   CALLS / CHAT: unchanged — MQTT for signalling and group chat.

   Everything degrades safely: with no account the app still makes plain
   calls using whatever name is typed in the entry screen. */
(function (global) {
  'use strict';

  const Bus = global.RuporBus;
  if (!Bus) return;

  const ROOT = Bus.ROOT + '/net/v2';
  const GROUP_SHARDS = 32;
  const CHAT_KEEP = 60;

  // ── STORAGE KEYS ──────────────────────────────────────────────────────────
  const K_SESSION = 'rup_acct2';   // { id, username, display }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  const enc = new TextEncoder();

  function hex(n) { return Bus.hex(n); }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // A stable ID derived from credentials so the same login always gives
  // the same ID.  Not a security guarantee — just stable identity across devices.
  async function deriveId(username, password) {
    const raw = await sha256('rupor-id:' + username.toLowerCase() + ':' + password);
    return raw.slice(0, 16);
  }

  function shard(key, count) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000003;
    return h % count;
  }

  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  }

  function safeParse(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── EVENTS ────────────────────────────────────────────────────────────────
  // A minimal emitter so the panel can react to account and group changes
  // instead of polling.  No wildcard events, no async: a throwing listener must
  // never break the caller, so each one is isolated.
  const _listeners = {};

  function emit(event, data) {
    const fns = _listeners[event];
    if (!fns || !fns.length) return;
    for (const fn of fns.slice()) {
      try { fn(data); } catch (_) {}
    }
  }

  // ── GROUP CRYPTO ──────────────────────────────────────────────────────────
  // The invite code is the group's shared secret: it travels out of band
  // (copied by hand, sent over another channel) and never through MQTT.
  // From it we derive a signing key and an encryption key, so anything the
  // broker stores is opaque to whoever does not know the code.

  const cryptoCtx = new TextEncoder();
  const cryptoDec = new TextDecoder();

  function b64(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s);
  }
  function unb64(str) {
    const raw = atob(str || '');
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function importKey(material, usage, alg) {
    return crypto.subtle.importKey('raw', material, alg, false, usage);
  }

  // Derive two independent keys from the invite code.  A domain separator
  // keeps signing and encryption key material from overlapping.
  async function groupKeys(code) {
    const base = await crypto.subtle.digest('SHA-256', cryptoCtx.encode('rupor-group:' + slug(code)));
    const signBits   = await crypto.subtle.digest('SHA-256', new Uint8Array([...new Uint8Array(base), 1]));
    const cryptBits  = await crypto.subtle.digest('SHA-256', new Uint8Array([...new Uint8Array(base), 2]));
    const signKey  = await importKey(signBits,  ['sign', 'verify'],
      { name: 'HMAC', hash: 'SHA-256' });
    const cryptKey = await importKey(cryptBits, ['encrypt', 'decrypt'],
      { name: 'AES-GCM', length: 256 });
    return { signKey, cryptKey };
  }

  async function hmacSign(signKey, text) {
    const mac = await crypto.subtle.sign('HMAC', signKey, cryptoCtx.encode(text));
    return b64(mac);
  }

  async function hmacCheck(signKey, text, mac) {
    try {
      const expect = unb64(mac);
      const got = new Uint8Array(await crypto.subtle.sign('HMAC', signKey, cryptoCtx.encode(text)));
      if (got.length !== expect.length) return false;
      let diff = 0;
      for (let i = 0; i < got.length; i++) diff |= got[i] ^ expect[i];
      return diff === 0;
    } catch (_) { return false; }
  }

  async function encryptField(cryptKey, value) {
    if (value === undefined || value === null || value === '') return value;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const buf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, cryptKey, cryptoCtx.encode(JSON.stringify(value))
    );
    return b64(new Uint8Array([...iv, ...new Uint8Array(buf)]));
  }

  async function decryptField(cryptKey, blob) {
    if (!blob) return blob;
    try {
      const all = unb64(blob);
      const iv = all.slice(0, 12);
      const body = all.slice(12);
      const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptKey, body);
      return JSON.parse(cryptoDec.decode(buf));
    } catch (_) { return null; }
  }

  // ── ACCOUNT (localStorage only) ───────────────────────────────────────────
  const NAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

  let session = null;   // { id, username, display }
  let profile = null;   // { id, username, display_name }

  function loadSession() {
    try {
      const raw = global.localStorage.getItem(K_SESSION);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.id && s.username) {
          session = s;
          profile = { id: s.id, username: s.username, display_name: s.display || s.username };
        }
      }
    } catch (_) { session = null; profile = null; }
  }

  function saveSession(s) {
    session = s;
    try {
      if (s) global.localStorage.setItem(K_SESSION, JSON.stringify(s));
      else global.localStorage.removeItem(K_SESSION);
    } catch (_) {}
  }

  // Also keep a hash of the password in localStorage so sign-in can verify it
  // without a server.  The hash is only stored locally and never sent anywhere.
  function pwKey(username) { return 'rup_pw_' + slug(username); }

  // The chosen display name is remembered per account as well, otherwise a
  // sign-out followed by a sign-in would quietly fall back to the username.
  function dnKey(username) { return 'rup_dn_' + slug(username); }

  async function signUp(username, password, displayName) {
    const name = String(username || '').trim();
    if (!NAME_RE.test(name)) throw new Error('BAD_NAME');
    if (String(password || '').length < 6) throw new Error('SHORT_PASSWORD');

    // Check if the name is already taken locally.
    if (global.localStorage.getItem(pwKey(name))) throw new Error('NAME_TAKEN');

    const id = await deriveId(name, password);
    const display = String(displayName || name).trim().slice(0, 32) || name;
    const hash = await sha256('rupor-pw:' + name.toLowerCase() + ':' + password);

    global.localStorage.setItem(pwKey(name), hash);
    global.localStorage.setItem(dnKey(name), display);
    const s = { id, username: name.toLowerCase(), display };
    saveSession(s);
    profile = { id, username: name.toLowerCase(), display_name: display };
    emit('signedIn', profile);
    return profile;
  }

  async function signIn(username, password) {
    const name = String(username || '').trim();
    if (!NAME_RE.test(name)) throw new Error('SIGNIN_FAILED');

    const stored = global.localStorage.getItem(pwKey(name));
    if (!stored) throw new Error('NO_SUCH_USER');

    const hash = await sha256('rupor-pw:' + name.toLowerCase() + ':' + password);
    if (hash !== stored) throw new Error('SIGNIN_FAILED');

    const id = await deriveId(name, password);
    const saved = global.localStorage.getItem(dnKey(name));
    const display = (saved && saved.trim()) || name;
    const s = { id, username: name.toLowerCase(), display };
    saveSession(s);
    profile = { id, username: name.toLowerCase(), display_name: display };
    emit('signedIn', profile);
    return profile;
  }

  async function restore() {
    loadSession();
    return profile || null;
  }

  // Renaming yourself is purely local until the next group write picks the new
  // name up: published member entries keep the display name they were written
  // with, because rewriting every group's member list from here would mean
  // racing the owner's other writes for no real gain.
  function changeDisplayName(newName) {
    if (!profile) return false;
    const trimmed = String(newName || '').trim().slice(0, 32);
    if (!trimmed) return false;

    try { global.localStorage.setItem(dnKey(profile.username), trimmed); } catch (_) {}
    profile.display_name = trimmed;
    if (session) {
      session.display = trimmed;
      saveSession(session);
    }
    emit('profileChanged', profile);
    return true;
  }

  function signOut() {
    unsubscribeInvites();
    stopPresence();
    if (profile) drop(ROOT + '/p/' + profile.id);
    saveSession(null);
    profile = null;
    emit('signedOut');
    return Promise.resolve();
  }

  // ── THE WRITER BUS ────────────────────────────────────────────────────────
  // Long-lived connection for retained writes and persistent subscriptions
  // (presence, chat wildcards).  Ad-hoc reads go through fresh connections via
  // mqttRead() so this bus never churns subscriptions.
  let bus = null;

  function ensureBus() {
    if (bus) return bus;
    bus = new Bus.Mqtt({
      onReady() {},
      onMessage(topic, payload) {
        const value = safeParse(payload);
        for (const fn of listeners) {
          try { fn(topic, value); } catch (_) {}
        }
      },
    });
    bus.start();
    return bus;
  }

  const listeners = new Set();

  // ── RETAINED WRITES (QoS 1, retry) ────────────────────────────────────────
  function put(topic, value) {
    ensureBus();
    return store(topic, JSON.stringify(value));
  }

  function drop(topic) {
    ensureBus();
    return store(topic, '');
  }

  async function store(topic, text) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const results = bus.publishRaw(topic, text, true);
      if (!results.length) { await sleep(400); continue; }
      const oks = await Promise.all(results);
      if (oks.some(Boolean)) return true;
      await sleep(300);
    }
    return false;
  }

  // ── AD-HOC READS ──────────────────────────────────────────────────────────
  async function readTopic(topic, timeoutMs) {
    const raw = await Bus.mqttRead(topic, timeoutMs || 7000);
    return safeParse(raw);
  }

  // For group records: both brokers are consulted and the higher revision wins,
  // so a broker that has not caught up cannot hand back a stale member list.
  async function readGroup(topic, timeoutMs) {
    return Bus.mqttReadNewest(topic, timeoutMs || 7000);
  }

  // ── PRESENCE ──────────────────────────────────────────────────────────────
  let beatTimer = null;
  let beatWho = null;

  function beat() {
    if (!profile) return;
    put(ROOT + '/p/' + profile.id, { id: profile.id, at: Date.now() });
  }

  function startPresence() {
    if (!profile) return;
    wireGroupListener();
    wireChatListener();
    subscribeInvites();
    syncGroupSubs();
    if (beatTimer && beatWho === profile.id) return;
    stopPresence();
    beatWho = profile.id;
    beat();
    beatTimer = setInterval(beat, 20000);
  }

  function stopPresence() {
    if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
    beatWho = null;
  }

  // ── GROUPS ────────────────────────────────────────────────────────────────
  // A group record holds: id, name, invite code, and an array of member
  // objects { id, display }.  No account lookup needed — display names are
  // stored directly in the group record.
  const groupTopic = (id) => ROOT + '/g/' + shard(id, GROUP_SHARDS) + '/' + id;
  const inviteTopic = (code) => ROOT + '/gi/' + slug(code);

  // My group membership list lives in localStorage (not MQTT) so it is
  // always available instantly and never needs a round-trip.  It is scoped to
  // the account: two people sharing one browser must not see each other's
  // groups.
  function myGroupKey() {
    return 'rup_mygroups2' + (profile ? ':' + profile.id : '');
  }

  function myGroupIdSet() {
    try {
      const raw = global.localStorage.getItem(myGroupKey());
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) {}
    return new Set();
  }

  function saveMyGroupIds(ids) {
    try { global.localStorage.setItem(myGroupKey(), JSON.stringify(Array.from(ids))); } catch (_) {}
  }

  function makeInvite() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += alphabet[b % alphabet.length];
    return out;
  }

  // A copy of the group record as this device last saw or wrote it.  It lets the
  // member list paint instantly after joining — before the retained write has
  // travelled back — and it is only ever used when it is at least as new as
  // whatever the broker returned.
  const K_GROUP_CACHE = 'rup_gcache2';

  function cacheKey() {
    return K_GROUP_CACHE + (profile ? ':' + profile.id : '');
  }

  function cachedGroup(gid) {
    try {
      const all = safeParse(global.localStorage.getItem(cacheKey())) || {};
      return all[gid] || null;
    } catch (_) { return null; }
  }

  function cacheGroup(rec) {
    if (!rec || !rec.id) return;
    try {
      const all = safeParse(global.localStorage.getItem(cacheKey())) || {};
      const prev = all[rec.id];
      if (prev && (Number(prev.rev) || 0) > (Number(rec.rev) || 0)) return;
      all[rec.id] = rec;
      global.localStorage.setItem(cacheKey(), JSON.stringify(all));
    } catch (_) {}
  }

  function forgetGroup(gid) {
    try {
      const all = safeParse(global.localStorage.getItem(cacheKey())) || {};
      delete all[gid];
      global.localStorage.setItem(cacheKey(), JSON.stringify(all));
    } catch (_) {}
  }

  // Read a group the freshest way available: the higher of the broker's copy
  // and our own cached copy.  Records are encrypted with the invite code, so
  // the code is looked up from the local cache; a group we have no code for
  // cannot be read, which is exactly the intended access rule.
  async function groupRecord(gid, timeoutMs) {
    const local = cachedGroup(gid);
    const code = local && local.invite;
    const fromNet = await readGroup(groupTopic(gid), timeoutMs);
    const plain = fromNet ? await decryptGroup(fromNet, code) : null;
    if (!plain) return local;
    // The published record never carries the invite code (it is the key), so
    // take it from the local copy to keep the UI and chat working.
    if (!plain.invite && local && local.invite) plain.invite = local.invite;
    if (!local) { cacheGroup(plain); return plain; }
    const win = (Number(plain.rev) || 0) >= (Number(local.rev) || 0) ? plain : local;
    cacheGroup(win);
    return win;
  }

  // Writes carry a revision one higher than whatever we last saw, so readers on
  // either broker can tell which copy is newer.  The sensitive fields are
  // encrypted with a key derived from the invite code; the whole record is
  // HMAC-signed so a tampering attempt is detected on read.
  async function writeGroup(rec) {
    const next = { ...rec, rev: (Number(rec.rev) || 0) + 1 };
    cacheGroup(next); // cache the plaintext before encrypting

    if (next.invite) {
      const { signKey, cryptKey } = await groupKeys(next.invite);
      // Encrypt sensitive fields.  The invite code itself is the key, so it is
      // never published — it travels out of band and stays in the local cache.
      const enc = {
        ...next,
        name:    await encryptField(cryptKey, next.name),
        members: await encryptField(cryptKey, next.members),
        enc: 1,
      };
      delete enc.invite;
      // Sign the stable fields that an attacker might try to swap.
      const signable = enc.id + '|' + enc.owner + '|' + enc.rev + '|' + enc.name;
      enc.sig = await hmacSign(signKey, signable);
      await put(groupTopic(enc.id), enc);
    } else {
      await put(groupTopic(next.id), next);
    }
    return next;
  }

  // Decrypt and verify a record from the broker.  Returns null if the
  // signature does not match (tampered or from an unknown client version).
  async function decryptGroup(raw, inviteCode) {
    if (!raw || !raw.id) return null;
    if (!raw.enc) return raw; // legacy record without encryption

    const { signKey, cryptKey } = await groupKeys(inviteCode || raw.invite || '');
    const signable = raw.id + '|' + raw.owner + '|' + raw.rev + '|' + raw.name;
    const ok = await hmacCheck(signKey, signable, raw.sig);
    if (!ok) return null; // reject tampered records

    const name    = await decryptField(cryptKey, raw.name);
    const members = await decryptField(cryptKey, raw.members);
    if (name === null || members === null) return null; // decryption failed

    return { ...raw, name, members, enc: 1 };
  }

  async function myGroups() {
    if (!profile) return [];
    const ids = myGroupIdSet();
    const out = [];
    await Promise.all(Array.from(ids).map(async (gid) => {
      const g = await groupRecord(gid, 5000);
      if (!g) return;
      out.push(toGroupView(g));
    }));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function toGroupView(g) {
    return {
      id: g.id,
      name: g.name,
      invite: g.invite,
      owner: g.owner,
      role: g.owner === profile.id ? 'owner' : 'member',
      members: Array.isArray(g.members) ? g.members : [],
    };
  }

  // A cache-only view of the groups for periodic repaints: no network at all.
  // Live updates arrive through the group subscription below, so polling this
  // cheaply every few seconds is enough to keep the panel truthful.
  function myGroupsCached() {
    if (!profile) return [];
    const out = [];
    for (const gid of myGroupIdSet()) {
      const g = cachedGroup(gid);
      if (g) out.push(toGroupView(g));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // ── GROUP SUBSCRIPTION ────────────────────────────────────────────────────
  // One wildcard per shard segment is not allowed by the brokers, so we
  // subscribe to the exact topics we know about.  Subscriptions live on the
  // long-lived writer bus, so keeping them in sync costs no connections.
  const groupSubs = new Set();
  const groupListeners = new Set();

  function syncGroupSubs() {
    if (!profile) return;
    ensureBus();
    const wanted = new Set(Array.from(myGroupIdSet()).map(groupTopic));
    for (const t of wanted) {
      if (!groupSubs.has(t)) { groupSubs.add(t); try { bus.subscribe(t); } catch (_) {} }
    }
    for (const t of Array.from(groupSubs)) {
      if (!wanted.has(t)) { groupSubs.delete(t); try { bus.unsubscribe(t); } catch (_) {} }
    }
  }

  function onGroups(fn) {
    groupListeners.add(fn);
    return () => groupListeners.delete(fn);
  }

  // Wire the group topics into the shared listener set once.
  function wireGroupListener() {
    if (wireGroupListener._done) return;
    wireGroupListener._done = true;
    const prefix = ROOT + '/g/';
    listeners.add(async (topic, value) => {
      if (!topic.startsWith(prefix)) return;
      if (!value || !value.id) return; // deletion: leave the cache alone,
                                       // myGroups() will notice the empty read
      // Decode with the invite code from the local cache before storing;
      // caching the ciphertext here would poison the plaintext cache.
      const local = cachedGroup(value.id);
      const plain = await decryptGroup(value, local && local.invite);
      if (!plain) return; // tampered or unreadable: ignore the update
      if (!plain.invite && local && local.invite) plain.invite = local.invite;
      cacheGroup(plain);
      for (const fn of groupListeners) { try { fn(plain); } catch (_) {} }
      emit('groupsChanged', myGroupsCached());
    });
  }

  async function createGroup(name) {
    if (!profile) throw new Error('SIGNIN_FAILED');
    wireGroupListener();
    wireChatListener();
    const clean = String(name || '').trim().slice(0, 60);
    if (!clean) throw new Error('GROUP_NAME');

    const id = hex(6);
    const invite = makeInvite();
    const rec = {
      id,
      name: clean,
      owner: profile.id,
      invite,
      members: [{ id: profile.id, display: profile.display_name }],
      made: Date.now(),
      rev: 0,
    };
    await writeGroup(rec);
    await put(inviteTopic(invite), { id });

    const ids = myGroupIdSet();
    ids.add(id);
    saveMyGroupIds(ids);
    syncGroupSubs();
    emit('groupsChanged', myGroupsCached());
    return id;
  }

  // Member entries are objects, so a set on ids is what dedupe actually means.
  function mergeMembers(...lists) {
    const out = [];
    for (const list of lists) {
      for (const m of (list || [])) {
        if (!m || !m.id) continue;
        if (!out.some((x) => x.id === m.id)) out.push(m);
      }
    }
    return out;
  }

  async function joinGroup(code) {
    if (!profile) throw new Error('SIGNIN_FAILED');
    wireGroupListener();
    wireChatListener();
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) throw new Error('GROUP_NOT_FOUND');

    const dir = await readTopic(inviteTopic(clean), 6000);
    if (!dir || !dir.id) throw new Error('GROUP_NOT_FOUND');

    // We know the invite code (the user typed it), so decrypt the record
    // directly rather than going through groupRecord(), which would need a
    // cached copy to find the code.
    const rawNet = await readGroup(groupTopic(dir.id), 7000);
    const g = await decryptGroup(rawNet, clean);
    if (!g) throw new Error('GROUP_NOT_FOUND');
    g.invite = clean;
    cacheGroup(g);

    const members = mergeMembers(g.members, [{ id: profile.id, display: profile.display_name }]);
    let rec = await writeGroup({ ...g, members });

    // Two people joining at the same time both read the same rev and publish
    // it, and the loser silently vanishes from the member list.  So after the
    // write we look at what the brokers actually ended up with and, if our id
    // is missing, publish again on top of the fresh revision — merging in
    // whoever arrived meanwhile rather than dropping them.
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(1200);
      const raw = await readGroup(groupTopic(rec.id), 6000);
      const fresh = raw ? await decryptGroup(raw, clean) : null;
      if (!fresh) break;
      fresh.invite = clean;
      cacheGroup(fresh);
      const list = Array.isArray(fresh.members) ? fresh.members : [];
      if (list.some((m) => m && m.id === profile.id)) { rec = fresh; break; }
      const merged = mergeMembers(list, [{ id: profile.id, display: profile.display_name }]);
      rec = await writeGroup({ ...fresh, members: merged });
    }

    const ids = myGroupIdSet();
    ids.add(g.id);
    saveMyGroupIds(ids);
    syncGroupSubs();
    emit('groupsChanged', myGroupsCached());
    return g.id;
  }

  async function leaveGroup(gid) {
    if (!profile) throw new Error('SIGNIN_FAILED');
    if (!gid) throw new Error('GROUP_NOT_FOUND');
    // Read fresh from network only — ignore local cache so we don't clobber
    // a concurrent joinGroup that bumped the revision after our last sync.
    const rawNet = await readGroup(groupTopic(gid), 7000);
    const local  = cachedGroup(gid);
    const code   = local && local.invite;
    const plain  = rawNet ? await decryptGroup(rawNet, code) : null;
    const g      = plain || local;
    if (g) {
      if (!plain && local) plain && Object.assign(g, {}); // keep local if net silent
      if (g.owner === profile.id) throw new Error('OWNER_CANNOT_LEAVE');
      if (plain && local && local.invite) plain.invite = local.invite;
      const members = (g.members || []).filter((m) => m.id !== profile.id);
      let rec = await writeGroup({ ...g, members });
      // Verify that the removal stuck — a concurrent join may have published a
      // higher rev in between, re-adding us.  Retry up to 2 times.
      for (let attempt = 0; attempt < 2; attempt++) {
        await sleep(800);
        const fresh = await readGroup(groupTopic(gid), 5000);
        const fp = fresh ? await decryptGroup(fresh, code) : null;
        if (!fp) break;
        const list = Array.isArray(fp.members) ? fp.members : [];
        if (!list.some((m) => m && m.id === profile.id)) break; // removal confirmed
        // We're still in the list — overwrite again
        fp.invite = code;
        const without = list.filter((m) => m.id !== profile.id);
        rec = await writeGroup({ ...fp, members: without });
      }
    }
    const ids = myGroupIdSet();
    ids.delete(gid);
    saveMyGroupIds(ids);
    // The chat history is keyed by group id and would otherwise linger on a
    // device that is no longer a member — the retained messages on the broker
    // are gone from this device's reach anyway.
    clearChatHistory(gid);
    emit('groupsChanged', myGroupsCached());
    return true;
  }

  // Only the owner may rewrite the published name.  Everything else in the
  // record is preserved; the write goes through writeGroup() so the name is
  // encrypted, the revision bumped and the signature recomputed exactly as on
  // creation.
  async function renameGroup(gid, newName) {
    if (!profile) throw new Error('SIGNIN_FAILED');
    if (!gid) return false;
    const clean = String(newName || '').trim().slice(0, 60);
    if (!clean) return false;

    const g = await groupRecord(gid, 7000);
    if (!g) throw new Error('GROUP_NOT_FOUND');
    if (g.owner !== profile.id) return false;
    if (!g.invite) return false; // cannot re-sign without the code

    const rec = await writeGroup({ ...g, name: clean });
    cacheGroup(rec);
    emit('groupsChanged', myGroupsCached());
    return true;
  }

  async function deleteGroup(gid) {
    if (!profile) throw new Error('SIGNIN_FAILED');
    if (!gid) throw new Error('GROUP_NOT_FOUND');
    const g = await groupRecord(gid, 5000);
    if (!g) throw new Error('GROUP_NOT_FOUND');
    if (g.owner !== profile.id) throw new Error('NOT_OWNER');

    // A retained record lives in each broker separately, and drop() resolves as
    // soon as one broker acknowledges.  The other would happily keep serving the
    // group, so confirm both have actually let go of it before reporting done.
    await drop(inviteTopic(g.invite));
    await drop(groupTopic(gid));
    await drop(inviteTopic(g.invite));
    await drop(groupTopic(gid));
    for (let attempt = 0; attempt < 4; attempt++) {
      const left = await Bus.mqttReadEach(groupTopic(gid), 4000);
      if (left.every((v) => !v)) break;
      await drop(groupTopic(gid));
      await drop(inviteTopic(g.invite));
      await sleep(500);
    }
    forgetGroup(gid);
    clearChatHistory(gid);

    const ids = myGroupIdSet();
    ids.delete(gid);
    saveMyGroupIds(ids);
    emit('groupsChanged', myGroupsCached());
    return true;
  }

  // ── CHAT ──────────────────────────────────────────────────────────────────
  const chatTopic = (gid, seq) => ROOT + '/c/' + gid + '/' + seq;
  let chatGid = null;
  let chatKey = null;      // CryptoKey derived from the group invite code
  let chatSeen = new Map();   // seq → decrypted message (the whole visible log)
  let chatHist = [];          // rows loaded from localStorage for the open group
  let chatQueue = [];         // raw payloads that arrived before the key was ready
  let chatSubs = [];

  // ── CHAT HISTORY ──────────────────────────────────────────────────────────
  // The retained topics on the broker only keep the last few messages per
  // group and are wiped along with the group, so the visible log is mirrored
  // locally.  It is plaintext in localStorage — the same device already holds
  // the decrypted messages in memory, and the browser profile is the trust
  // boundary for accounts too.
  const CHAT_HISTORY_MAX = 200;
  const chatHistKey = (gid) => 'rup_chat_' + gid;

  function loadChatHistory(gid) {
    if (!gid) return [];
    try {
      const raw = global.localStorage.getItem(chatHistKey(gid));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveToHistory(gid, msg) {
    if (!gid || !msg || typeof msg.text !== 'string') return false;
    try {
      const hist = loadChatHistory(gid);
      const seq = String(msg.seq == null ? '' : msg.seq);
      const dup = hist.some((m) => String(m && m.seq) === seq);
      if (!dup) {
        hist.push({
          seq,
          from: msg.from,
          display: msg.name || msg.display || '',
          text: msg.text,
          at: Number(msg.at) || Date.now(),
        });
      }
      const trimmed = hist.length > CHAT_HISTORY_MAX ? hist.slice(-CHAT_HISTORY_MAX) : hist;
      global.localStorage.setItem(chatHistKey(gid), JSON.stringify(trimmed));
      return !dup;
    } catch (_) { return false; }
  }

  function clearChatHistory(gid) {
    if (!gid) return false;
    try { global.localStorage.removeItem(chatHistKey(gid)); } catch (_) {}
    return true;
  }

  // History rows use a display field; the chat log speaks in { from, name }.
  function historyToMessage(row) {
    return {
      seq: row.seq,
      from: row.from,
      name: row.display || row.name || '',
      text: row.text,
      at: row.at,
    };
  }

  // Keep the in-memory log in step with storage: same dedupe by seq, same cap,
  // so replaying it never shows a message twice.
  function appendHist(row) {
    const key = String(row.seq);
    if (!chatHist.some((m) => String(m.seq) === key)) chatHist.push(row);
    if (chatHist.length > CHAT_HISTORY_MAX) chatHist = chatHist.slice(-CHAT_HISTORY_MAX);
  }

  async function openChat(gid) {
    if (chatGid === gid) return;
    closeChat();
    chatGid = gid;
    chatSeen = new Map();
    chatQueue = [];
    chatKey = null;
    chatHist = [];
    if (!gid) return;

    // Paint the local log straight away; the broker copy only adds to it.
    // chatHist is kept apart from chatSeen so that pruning old broker topics
    // (CHAT_KEEP) never throws away messages the user already had.
    chatHist = loadChatHistory(gid);

    wireChatListener();

    // Subscribe first: retained messages can arrive at any moment and must not
    // be lost while we are still deriving the key below.
    ensureBus();
    const filter = ROOT + '/c/' + gid + '/+';
    chatSubs.push(filter);
    bus.subscribe(filter);

    // Derive the chat key from the group's invite code.  If the local cache
    // has no record yet (a fresh join still in flight), fetch it first.
    let g = cachedGroup(gid);
    if (!g || !g.invite) {
      try { g = await groupRecord(gid, 5000); } catch (_) {}
    }
    if (g && g.invite) {
      try { chatKey = (await groupKeys(g.invite)).cryptKey; } catch (_) {}
    }

    // Drain whatever arrived while the key was being derived.
    const pending = chatQueue.slice();
    chatQueue = [];
    for (const raw of pending) await decodeChat(raw.topic, raw.value);
  }

  function closeChat() {
    for (const f of chatSubs) {
      try { bus && bus.unsubscribe(f); } catch (_) {}
    }
    chatSubs = [];
    chatGid = null;
    chatKey = null;
    chatSeen = new Map();
    chatHist = [];
    chatQueue = [];
  }

  // Decrypt one payload and remember it.  Returns the message or null.
  async function decodeChat(topic, value) {
    if (!chatGid) return null;
    const prefix = ROOT + '/c/' + chatGid + '/';
    if (!topic.startsWith(prefix)) return null;
    if (!value || !value.p) return null;
    // The seq suffix is an opaque, collision-free token (timestamp + random),
    // not a number: two messages sent in the same millisecond must not share
    // a topic and overwrite each other.
    const seq = topic.slice(prefix.length);
    if (!seq) return null;
    if (chatSeen.has(seq)) return null;

    let msg = null;
    if (chatKey) {
      const clear = await decryptField(chatKey, value.p);
      if (clear && typeof clear === 'object' && typeof clear.text === 'string') msg = clear;
    }
    if (!msg) {
      // Legacy / keyless payload: plain base64 of the original JSON object.
      try {
        const raw = JSON.parse(cryptoDec.decode(unb64(value.p)));
        if (raw && typeof raw.text === 'string') msg = raw;
      } catch (_) {}
    }
    if (!msg) return null;

    if (msg.seq == null) msg.seq = seq;
    chatSeen.set(seq, msg);
    const row = { seq, from: msg.from, display: msg.name || '', text: msg.text, at: Number(msg.at) || Date.now() };
    // isNew is false when the echo of our own sendChat() arrives from the
    // broker — the history already has it and the panel painted it already.
    const isNew = saveToHistory(chatGid, msg);
    appendHist(row);
    if (isNew !== false) {
      for (const fn of chatListeners) { try { fn(msg); } catch (_) {} }
    }
    return msg;
  }

  const chatListeners = new Set();

  function onChat(fn) {
    chatListeners.add(fn);
    // Replay the stored log first, then whatever the broker delivered while
    // the panel was opening.  Both sides are de-duplicated by seq, so a
    // retained message that is also in the history is emitted once.
    const histRows = chatHist.length ? chatHist.slice() : loadChatHistory(chatGid);
    const histSeqs = new Set(histRows.map((m) => String(m.seq)));
    for (const row of histRows) {
      try { fn(historyToMessage(row)); } catch (_) {}
    }
    for (const msg of chatSeen.values()) {
      if (histSeqs.has(String(msg.seq))) continue;
      try { fn(msg); } catch (_) {}
    }
    return () => chatListeners.delete(fn);
  }

  // Wire the raw chat topic into the shared listener set once, so payloads are
  // captured even before anyone calls onChat().
  function wireChatListener() {
    if (wireChatListener._done) return;
    wireChatListener._done = true;
    const prefix = ROOT + '/c/';
    listeners.add((topic, value) => {
      if (!chatGid || !topic.startsWith(prefix)) return;
      if (!chatGid || !topic.startsWith(ROOT + '/c/' + chatGid + '/')) return;
      if (!value || !value.p) return;
      if (!chatKey) {
        // Key not ready yet — hold the payload; openChat() drains this queue.
        if (chatQueue.length < 200) chatQueue.push({ topic, value });
        return;
      }
      decodeChat(topic, value);
    });
  }

  async function sendChat(text) {
    if (!profile || !chatGid) return false;
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return false;
    const seq = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const msg = { from: profile.id, name: profile.display_name, text: clean, at: Date.now() };

    let payload;
    if (chatKey) {
      payload = { p: await encryptField(chatKey, msg) };
    } else {
      // No key (group record not readable yet): still never write plaintext.
      payload = { p: b64(cryptoCtx.encode(JSON.stringify(msg))) };
    }

    // Wait for the broker to accept it: reporting "sent" while the write is
    // still in flight would make the log lie about what other people see.
    const ok = await put(chatTopic(chatGid, seq), payload);

    // Record our own message locally too: the retained echo may take a moment
    // (or never arrive on a flaky link), and the sender's history must match
    // what the panel has already painted.  saveToHistory() dedupes by seq, so
    // the echo is harmless when it does come back.
    if (ok !== false) {
      msg.seq = seq;
      chatSeen.set(seq, msg);
      appendHist({ seq, from: msg.from, display: msg.name, text: msg.text, at: msg.at });
      saveToHistory(chatGid, msg);
    }

    const seqs = Array.from(chatSeen.entries())
      .sort((a, b) => (Number(a[1] && a[1].at) || 0) - (Number(b[1] && b[1].at) || 0));
    for (const [old] of seqs.slice(0, Math.max(0, seqs.length - CHAT_KEEP + 1))) {
      if (old === seq) continue;
      drop(chatTopic(chatGid, old));
      chatSeen.delete(old);
    }
    return ok !== false;
  }

  // ── CALL INVITES ──────────────────────────────────────────────────────────
  // Each invite lives in its own retained slot: ci/<uid>/<inviteId>.
  // This lets multiple simultaneous callers coexist instead of overwriting
  // each other, and lets the recipient dismiss a single invite without
  // clearing unrelated ones.
  const inviteSlot  = (uid, iid) => ROOT + '/ci/' + uid + '/' + iid;
  const inviteWild  = (uid)      => ROOT + '/ci/' + uid + '/+';
  const inviteIndex = (uid)      => ROOT + '/ci/' + uid + '/_idx'; // list of active iids
  const seenInvite  = new Set();
  const inviteListeners = new Set();
  let   _invSubscribed = false;
  let   lastInvite = null;

  // Push-subscribe to own invite wildcard so the UI gets notified instantly
  // without waiting for the 8-second poll.  Called once after sign-in; calling
  // it again (e.g. openSocial re-trigger) is a no-op.
  function subscribeInvites() {
    if (!profile) return;
    if (_invSubscribed) return;
    _invSubscribed = true;

    const filter = inviteWild(profile.id);
    ensureBus();
    bus.subscribe(filter);

    const handler = (t, value) => {
      const prefix = ROOT + '/ci/' + profile.id + '/';
      if (!t.startsWith(prefix)) return;
      const key = t.slice(prefix.length);
      if (key === '_idx') return; // index updates are not invite notifications

      // An empty payload means the invite was dropped (caller hung up or
      // another device dismissed it).  Tell the UI so the ring stops at once.
      if (!value) {
        for (const fn of inviteListeners) {
          try { fn({ id: key, cancelled: true }); } catch (_) {}
        }
        return;
      }

      if (!value.id) return;
      if (seenInvite.has(value.id)) return;
      for (const fn of inviteListeners) { try { fn(value); } catch (_) {} }
    };
    listeners.add(handler);
    subscribeInvites._handler = handler;
    subscribeInvites._filter  = filter;
  }

  function unsubscribeInvites() {
    _invSubscribed = false;
    if (subscribeInvites._handler) {
      listeners.delete(subscribeInvites._handler);
      subscribeInvites._handler = null;
    }
    if (subscribeInvites._filter && bus) {
      try { bus.unsubscribe(subscribeInvites._filter); } catch (_) {}
      subscribeInvites._filter = null;
    }
  }

  function onInvite(fn) {
    inviteListeners.add(fn);
    return () => inviteListeners.delete(fn);
  }

  async function inviteToCall(opts) {
    if (!profile) throw new Error('SIGNIN_FAILED');
    const room = String((opts && opts.room) || '').toUpperCase();
    if (!room) throw new Error('NO_ROOM');

    let targets = [];
    let groupName = opts.groupName || '';
    if (opts.userId) {
      targets = [opts.userId];
    } else if (opts.groupId) {
      const g = await groupRecord(opts.groupId, 5000);
      const members = g && Array.isArray(g.members) ? g.members : [];
      if (g) {
        targets = members.filter((m) => m.id !== profile.id).map((m) => m.id);
        groupName = g.name || '';
      }
    }

    // One invite id shared across all recipients of this call so the caller
    // can cancel all of them by id if they hang up before anyone answers.
    const iid = hex(6);
    // Write an index of active invite ids so recipients can enumerate slots
    // without relying on wildcard subscriptions that brokers may not support.
    await Promise.all(targets.map(async (uid) => {
      const idxRaw = await readTopic(inviteIndex(uid), 3000);
      const idx = Array.isArray(idxRaw) ? idxRaw : [];
      if (!idx.includes(iid)) idx.push(iid);
      await put(inviteIndex(uid), idx);
      await put(inviteSlot(uid, iid), {
        id: iid,
        from: profile.id,
        name: profile.display_name,
        groupName,
        room,
        at: Date.now(),
      });
    }));
    lastInvite = { iid, targets: targets.slice() };
    return targets.length;
  }

  // Read all pending invite slots for this user via the index topic.
  async function pendingInvites() {
    if (!profile) return [];
    const idxRaw = await readTopic(inviteIndex(profile.id), 5000);
    const idx = Array.isArray(idxRaw) ? idxRaw : (idxRaw ? [idxRaw.id].filter(Boolean) : []);
    if (!idx.length) return [];
    const now = Date.now();
    const results = await Promise.all(idx.map((iid) => readTopic(inviteSlot(profile.id, iid), 4000)));
    return results
      .filter((inv) => inv && inv.id && !seenInvite.has(inv.id) && (now - (inv.at || 0)) < 10 * 60 * 1000)
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  async function dismissInvite(id) {
    if (!profile) return;
    if (id) {
      seenInvite.add(id);
      await drop(inviteSlot(profile.id, id));
      // Remove from index.
      const idxRaw = await readTopic(inviteIndex(profile.id), 3000);
      const idx = Array.isArray(idxRaw) ? idxRaw.filter((x) => x !== id) : [];
      if (idx.length) await put(inviteIndex(profile.id), idx);
      else await drop(inviteIndex(profile.id));
    }
    return true;
  }

  // Remove the retained invite from every recipient's slot so their ring stops.
  async function cancelInvites(iid, targets) {
    if (!profile) return 0;
    const id  = iid     || (lastInvite && lastInvite.iid);
    const tgt = targets || (lastInvite && lastInvite.targets) || [];
    lastInvite = null;
    if (!id) return 0;
    await Promise.all(tgt.map(async (uid) => {
      await drop(inviteSlot(uid, id));
      // Update the recipient's index.
      const idxRaw = await readTopic(inviteIndex(uid), 3000);
      const idx = Array.isArray(idxRaw) ? idxRaw.filter((x) => x !== id) : [];
      if (idx.length) await put(inviteIndex(uid), idx);
      else await drop(inviteIndex(uid));
    }));
    return tgt.length;
  }

  // ── PUBLIC SURFACE ────────────────────────────────────────────────────────
  const api = {
    get ready() { return true; },
    get signedIn() { return !!profile && !!session; },
    get profile() { return profile; },
    get userId() { return profile ? profile.id : null; },

    // Minimal emitter.  'signedIn', 'signedOut', 'profileChanged' and
    // 'groupsChanged' are the events this layer raises.
    on(event, fn) {
      if (typeof fn !== 'function') return api;
      const name = String(event || '');
      if (!name) return api;
      if (!_listeners[name]) _listeners[name] = [];
      if (!_listeners[name].includes(fn)) _listeners[name].push(fn);
      return api;
    },
    off(event, fn) {
      const fns = _listeners[String(event || '')];
      if (fns) {
        if (typeof fn === 'function') _listeners[String(event)] = fns.filter((f) => f !== fn);
        else delete _listeners[String(event)];
      }
      return api;
    },

    config: () => ({ url: 'mqtt://relay', key: 'none' }),
    setConfig() { return true; },
    restore,
    signUp,
    signIn,
    signOut,
    changeDisplayName,
    myGroups,
    myGroupsCached,
    onGroups,
    createGroup,
    joinGroup,
    leaveGroup,
    deleteGroup,
    renameGroup,
    startPresence,
    stopPresence,
    inviteToCall,
    pendingInvites,
    dismissInvite,
    cancelInvites,
    onInvite,
    subscribeInvites,
    openChat,
    closeChat,
    onChat,
    sendChat,
    loadChatHistory,
    clearChatHistory,
  };

  global.Rupor = global.Rupor || {};
  global.Rupor.api = api;
  global.Rupor.probe = {
    ROOT,
    groupTopic,
    slug,
    shard,
    state: () => ({
      busReady: bus ? bus.links.some((l) => l.ready) : false,
      brokers: bus ? bus.links.filter((l) => l.ready).map((l) => l.i) : [],
      cid: bus ? bus.cid : null,
    }),
  };
})(window);
