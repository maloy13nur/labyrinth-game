/* Signalling transport for Рупор.

   The PeerJS public cloud answers every request with a Cloudflare block
   (HTTP 403).  An MQTT broker is a plain public relay: no account, no
   quota, carrying only the small SDP blobs two browsers need to find each
   other.  Video and audio travel directly between browsers and never
   touch it.

   A public relay drops frames, so the handshake is self-healing: offers
   and answers are repeated until the peer connection reaches "connected",
   a repeated offer always draws a repeated answer, and a failed peer
   connection is redialled from scratch.

   All signalling flows through a single broadcast topic per room.  Every
   message carries a `to` field so the right peer picks it up; others
   ignore it.  One subscription per room is simpler for the broker to
   maintain than one per peer, which improves delivery reliability. */
(function (global) {
  'use strict';

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];
  const ROOT = 'rupor/v3';
  const ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Public TURN relays.  They are unreachable from some filtered networks
    // (this one rewrites DNS for openrelay.metered.ca and blocks TURN), but
    // they work for most ordinary connections and cost nothing to try.
    // A private relay can be added at runtime via `iceServers()` below.
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  const ICE_CAP = 4000;
  const RETRY = [0, 1500, 3500, 6000, 9000];

  // The first offer goes out before the other side may have subscribed, so it
  // is repeated over the first few seconds until an answer comes back.
  const OFFER_RETRY = [1200, 3000, 6000, 10000, 15000];

  // Extra ICE servers may be supplied at runtime without rebuilding the file:
  //   localStorage.rup_ice = '[{"urls":"turn:1.2.3.4:80","username":"u","credential":"p"}]'
  // Lets a blocked or expired relay be swapped from a browser console.
  function iceServers() {
    try {
      const raw = global.localStorage && global.localStorage.getItem('rup_ice');
      if (raw) {
        const extra = JSON.parse(raw);
        if (Array.isArray(extra)) return ICE.concat(extra);
      }
    } catch (_) {}
    return ICE;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function hex(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    let s = '';
    for (const x of b) s += x.toString(16).padStart(2, '0');
    return s;
  }

  function varint(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  }

  function packet(first, body) {
    return new Uint8Array([first, ...varint(body.length), ...body]);
  }

  function utf8(s) {
    return Array.from(enc.encode(s));
  }

  // Resolves when ICE gathering completes or the cap expires.  Sending a
  // complete SDP removes the need for trickled candidates.
  function waitIce(pc, cap) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, cap);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // ── minimal MQTT 3.1.1 client over WebSocket ───────────────────────────────
  //
  // ROOT CAUSE: public brokers (emqx ~12, hivemq ~8) stop delivering PUBACKs
  // after rapid subscription churn on the same connection.  The socket stays
  // open but writes get no acknowledgement and retained data stops arriving.
  //
  // FIX: separate the write path from the read path entirely.
  //
  //   Mqtt (writer) — long-lived, dials both brokers, holds only persistent
  //   subscriptions (signalling room, presence, chat wildcards).  Never
  //   unsubscribes.  All retained writes go here.  Because it never churns
  //   subscriptions it always gets PUBACKs.
  //
  //   MqttReader — one-shot connection to a single broker for a single topic.
  //   Opens, subscribes, takes the retained value (or empty after settle
  //   window), then closes itself.  No subscription ever accumulates across
  //   reads, so churn is impossible.
  //
  // The two classes share the low-level framing helpers but are otherwise
  // independent.

  // ── MqttReader ─────────────────────────────────────────────────────────────
  // Opens a fresh WebSocket to one broker, subscribes to one topic, waits
  // for the retained payload or empty, then closes.  Returns a Promise that
  // resolves to the raw payload string or null.
  //
  // Used by social.js for every ad-hoc read (name lookup, user record,
  // friendship, etc.).  Each read gets its own connection so no subscription
  // accumulates between reads.
  function MqttReader(url, topic, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let settleTimer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(outTimer);
        clearTimeout(settleTimer);
        try { ws.send(new Uint8Array([0xe0, 0x00])); } catch (_) {}
        try { ws.close(); } catch (_) {}
        resolve(value);
      };
      const outTimer = setTimeout(() => finish(null), timeoutMs || 7000);

      let ws;
      try { ws = new WebSocket(url, ['mqtt']); } catch (_) { clearTimeout(outTimer); resolve(null); return; }
      ws.binaryType = 'arraybuffer';
      let buf = new Uint8Array(0);

      ws.onopen = () => {
        const idb = utf8('rdr' + hex(5));
        const body = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c,
                      0x00, idb.length, ...idb];
        try { ws.send(packet(0x10, body)); } catch (_) {}
      };
      ws.onerror = () => {};
      ws.onclose = () => { if (!done) finish(null); };

      ws.onmessage = (ev) => {
        if (done) return;
        const c = new Uint8Array(ev.data instanceof ArrayBuffer ? ev.data : ev.data.buffer || new ArrayBuffer(0));
        const m = new Uint8Array(buf.length + c.length);
        m.set(buf); m.set(c, buf.length); buf = m;

        for (;;) {
          const b = buf;
          if (b.length < 2) break;
          let mul = 1, len = 0, i = 1, byte = 0;
          do {
            if (i >= b.length) return;
            byte = b[i++]; len += (byte & 0x7f) * mul; mul *= 128;
            if (i > 4) return;
          } while (byte & 0x80);
          if (b.length < i + len) break;
          const type = b[0] >> 4, flags = b[0] & 0x0f;
          const body = b.slice(i, i + len);
          buf = b.slice(i + len);

          if (type === 2) {          // CONNACK
            if (body.length > 1 && body[1] !== 0) { finish(null); return; }
            // Subscribe QoS 0 — no PUBACK flow at all, just delivery.
            const t = utf8(topic);
            try { ws.send(packet(0x82, [0x00, 0x01, 0x00, t.length, ...t, 0x00])); } catch (_) {}
          } else if (type === 9) {   // SUBACK — settle window then declare empty
            settleTimer = setTimeout(() => finish(null), 700);
          } else if (type === 3) {   // PUBLISH
            const qos = (flags >> 1) & 3;
            const tlen = (body[0] << 8) | body[1];
            if (body.length < 2 + tlen) break;
            const t = dec.decode(body.subarray(2, 2 + tlen));
            if (t === topic) {
              let at = 2 + tlen;
              if (qos > 0) at += 2;
              finish(dec.decode(body.subarray(at)));
            }
          }
        }
      };
    });
  }

  // Read a topic from the first broker that answers, trying both in parallel.
  // Returns the payload string or null.
  function mqttRead(topic, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      Promise.all(
        BROKERS.map((url) =>
          MqttReader(url, topic, timeoutMs || 7000).then((v) => { if (v !== null) finish(v); return v; })
        )
      ).then((results) => {
        // Both returned null — topic is empty (or unreachable).
        if (!settled) finish(null);
      });
    });
  }

  // Read a topic and wait for BOTH brokers to answer, then return the newest
  // value by its `rev` field.  mqttRead takes whichever broker replies first,
  // which right after a write can be the one that has not caught up yet and so
  // hands back a stale record.  Group records carry a revision counter, so this
  // picks the fresher copy instead of the faster one.  Records written before
  // the counter existed are treated as revision 0.
  function mqttReadEach(topic, timeoutMs) {
    return Promise.all(BROKERS.map((url) => MqttReader(url, topic, timeoutMs || 7000)));
  }

  function mqttReadNewest(topic, timeoutMs) {
    return mqttReadEach(topic, timeoutMs).then((results) => {
      const parsed = results
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => { try { return JSON.parse(v); } catch (_) { return null; } })
        .filter(Boolean);
      if (!parsed.length) return null;
      return parsed.reduce((newest, rec) =>
        (Number(rec.rev) || 0) >= (Number(newest.rev) || 0) ? rec : newest);
    });
  }

  // ── Mqtt (writer / persistent-subscriber) ─────────────────────────────────
  // Every broker is dialled at once rather than one after another.  A retained
  // message lives inside the broker that stores it, so a client that wrote only
  // to broker A is invisible to a client that happened to land on broker B.
  // Reaching both at the same time means the two always meet, and it also means
  // one relay being down costs nothing.
  //
  // This class is only used for:
  //   - signalling room subscription (Peer)
  //   - persistent subscriptions added by social.js (presence, chat wildcards)
  //   - all retained writes (QoS 1)
  //
  // It NEVER calls unsubscribe or resubscribe, so subscription count stays low
  // and PUBACKs keep flowing.
  class Mqtt {
    constructor(hooks) {
      this.hooks = hooks;
      this.dead = false;
      this.cid = 'rup' + hex(6);
      this.subs = new Set();
      this.pid = 0;
      this.everReady = false;
      this.raw = [];
      this.links = BROKERS.map((url, i) => ({
        url,
        i,
        ws: null,
        ready: false,
        buf: new Uint8Array(0),
        queue: [],
        pingTimer: null,
        retryTimer: null,
        pubResolve: new Map(),     // packet id -> settle callback, until PUBACK
      }));
    }

    // One live relay is enough to work.
    get ready() { return this.links.some((l) => l.ready); }

    _log(what) {
      this.raw.push(Date.now() % 1000000 + ' ' + what);
      if (this.raw.length > 60) this.raw.shift();
    }

    start() { for (const link of this.links) this._open(link); }

    _open(link) {
      if (this.dead) return;
      link.buf = new Uint8Array(0);
      let ws;
      try { ws = new WebSocket(link.url, ['mqtt']); } catch (_) { this._retry(link); return; }
      ws.binaryType = 'arraybuffer';
      link.ws = ws;

      ws.onopen = () => {
        if (link.ws !== ws) return;
        this._log('open broker=' + link.i);
        const idb = utf8(this.cid);
        const body = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c,
                      0x00, idb.length, ...idb];
        try { ws.send(packet(0x10, body)); } catch (_) {}
      };

      ws.onmessage = (ev) => {
        if (link.ws !== ws) return;
        const d = ev.data;
        if (d instanceof ArrayBuffer) this._feed(link, new Uint8Array(d));
        else if (d && d.buffer) this._feed(link, new Uint8Array(d.buffer));
        else if (typeof d === 'string') this._feed(link, enc.encode(d));
      };

      ws.onclose = (e) => {
        if (link.ws !== ws) return;
        this._log('close broker=' + link.i + ' ' + (e && e.code));
        link.ready = false;
        this._stopPing(link);
        if (!this.dead) this._retry(link);
      };

      ws.onerror = () => {};
    }

    _retry(link) {
      if (this.dead || link.retryTimer) return;
      link.retryTimer = setTimeout(() => {
        link.retryTimer = null;
        this._open(link);
      }, 1500);
    }

    _feed(link, chunk) {
      const merged = new Uint8Array(link.buf.length + chunk.length);
      merged.set(link.buf);
      merged.set(chunk, link.buf.length);
      link.buf = merged;
      for (;;) {
        const p = this._next(link);
        if (!p) break;
        this._handle(link, p);
        if (this.dead || !link.ws) break;
      }
    }

    _next(link) {
      const b = link.buf;
      if (b.length < 2) return null;
      let mul = 1, len = 0, i = 1, byte = 0;
      do {
        if (i >= b.length) return null;
        byte = b[i++];
        len += (byte & 0x7f) * mul;
        mul *= 128;
        if (i > 4) return null;
      } while (byte & 0x80);
      if (b.length < i + len) return null;
      const out = { type: b[0] >> 4, flags: b[0] & 0x0f, body: b.slice(i, i + len) };
      link.buf = b.slice(i + len);
      return out;
    }

    _handle(link, p) {
      const { type, flags, body } = p;
      if (type === 2) {                        // CONNACK
        const rc = body.length > 1 ? body[1] : 1;
        if (rc !== 0) { this._retry(link); return; }
        link.ready = true;
        this._log('connack broker=' + link.i);
        for (const topic of this.subs) this._sub(link, topic);
        const queued = link.queue;
        link.queue = [];
        for (const fn of queued) { try { fn(); } catch (_) {} }
        this._startPing(link);
        const first = !this.everReady;
        this.everReady = true;
        if (this.hooks.onReady) this.hooks.onReady(first);
        return;
      }
      if (type === 4) {                        // PUBACK (QoS 1)
        if (body.length < 2) return;
        const id = (body[0] << 8) | body[1];
        const settle = link.pubResolve.get(id);
        if (settle) { link.pubResolve.delete(id); settle(true); }
        return;
      }
      if (type === 3) {                        // PUBLISH
        if (body.length < 2) return;
        const qos = (flags >> 1) & 3;
        const tlen = (body[0] << 8) | body[1];
        if (body.length < 2 + tlen) return;
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        let at = 2 + tlen;
        if (qos > 0) at += 2;
        const payload = dec.decode(body.subarray(at));
        this._log('pub ' + topic.split('/').pop());
        if (this.hooks.onMessage) this.hooks.onMessage(topic, payload);
      }
      // SUBACK (type 9) is not needed here: this class never waits on SUBACKs.
    }

    subscribe(topic) {
      if (this.subs.has(topic)) return;
      this.subs.add(topic);
      for (const link of this.links) {
        if (link.ready) this._sub(link, topic);
      }
    }

    _sub(link, topic) {
      const t = utf8(topic);
      if (t.length > 250) return;
      const id = ++this.pid & 0xffff || 1;
      const body = [id >> 8, id & 0xff, 0x00, t.length, ...t, 0x00];
      try { link.ws.send(packet(0x82, body)); } catch (_) {}
    }

    publish(topic, obj) {
      this.publishRaw(topic, JSON.stringify(obj), false);
    }

    // retain=true asks the broker to keep this payload and hand it to every
    // later subscriber.  That turns a plain public relay into a tiny key-value
    // store, which is what the account layer is built on.  An empty payload
    // with retain=true deletes the stored value.  Every write goes to every
    // relay, so a reader finds it whichever one they reached.
    //
    // The publish is QoS 1.  At QoS 0 the broker acknowledges nothing and a
    // dropped frame is invisible — writes simply vanish.  QoS 1 makes the
    // broker answer with PUBACK.
    //
    // Returns one promise per relay: true when that relay acknowledged.
    publishRaw(topic, text, retain) {
      const t = utf8(topic);
      if (t.length > 250) return [];
      const payload = utf8(text == null ? '' : String(text));
      const packetType = retain ? 0x33 : 0x32;   // PUBLISH with QoS 1
      return this.links.map((link) => this._publishOn(link, t, payload, packetType));
    }

    _publishOn(link, topicBytes, payload, packetType) {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const send = () => {
          if (!link.ready) return finish(false);
          const id = (++this.pid) & 0xffff || 1;
          link.pubResolve.set(id, finish);
          const body = [0x00, topicBytes.length, ...topicBytes, id >> 8, id & 0xff, ...payload];
          try { link.ws.send(packet(packetType, body)); }
          catch (_) { link.pubResolve.delete(id); finish(false); }
        };
        const timer = setTimeout(() => finish(false), 6000);
        if (link.ready) send();
        else {
          link.queue.push(send);
          if (link.queue.length > 12) link.queue.shift();
        }
      });
    }

    // unsubscribe is intentionally kept but social.js no longer calls it for
    // ad-hoc reads.  It is only used if a persistent subscription (e.g. a chat
    // room the user leaves) should be torn down.
    unsubscribe(topic) {
      this.subs.delete(topic);
      const t = utf8(topic);
      if (t.length > 250) return;
      for (const link of this.links) {
        if (!link.ready) continue;
        const id = (++this.pid) & 0xffff || 1;
        const body = [id >> 8, id & 0xff, t.length >> 8, t.length & 0xff, ...t];
        try { link.ws.send(packet(0xa2, body)); } catch (_) {}
      }
    }

    _startPing(link) {
      this._stopPing(link);
      link.pingTimer = setInterval(() => {
        try { link.ws.send(new Uint8Array([0xc0, 0x00])); } catch (_) {}
      }, 30000);
    }

    _stopPing(link) {
      if (link.pingTimer) { clearInterval(link.pingTimer); link.pingTimer = null; }
    }

    close() {
      this.dead = true;
      for (const link of this.links) {
        this._stopPing(link);
        if (link.retryTimer) { clearTimeout(link.retryTimer); link.retryTimer = null; }
        try { link.ws.send(new Uint8Array([0xe0, 0x00])); } catch (_) {}
        try { link.ws.close(); } catch (_) {}
      }
    }
  }

  // ── connection objects ─────────────────────────────────────────────────────
  class BaseConn {
    constructor(peer, remoteId) {
      this._peer = peer;
      this.peer = remoteId;
      this.sid = null;
      this.kind = '';
      this.pc = null;
      this.closed = false;
      this.open = false;
      this.answerSdp = null;
      this.failTimer = null;
      this._h = Object.create(null);
    }

    on(ev, fn) {
      (this._h[ev] || (this._h[ev] = [])).push(fn);
      if (ev === 'open' && this.open) setTimeout(fn, 0);
      return this;
    }

    _emit(ev, arg) {
      const list = this._h[ev];
      if (!list) return;
      for (const fn of list.slice()) { try { fn(arg); } catch (e) { console.error(e); } }
    }

    close() {
      if (this.closed) return;
      this._peer._pub(this.peer, { t: 'bye', from: this._peer.id, sid: this.sid });
      this._peer._drop(this);
    }
  }

  class DataConn extends BaseConn {
    constructor(peer, remoteId) {
      super(peer, remoteId);
      this.kind = 'data';
      this.dc = null;
    }
    send(obj) {
      if (!this.dc || this.dc.readyState !== 'open') return;
      try { this.dc.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  class MediaConn extends BaseConn {
    constructor(peer, remoteId) {
      super(peer, remoteId);
      this.kind = 'media';
      this.localStream = null;
      this.remoteSdp = null;
      this._started = false;
      this._tries = 0;
    }
    get peerConnection() { return this.pc; }
    answer(stream) { this.localStream = stream; this._start(); }
    _start() {
      if (!this.localStream || !this.remoteSdp || !this.pc) return;
      if (this._started) {
        // Already negotiated. Only a recovery offer may re-enter here, and
        // only while ICE is actually unhealthy — otherwise a stale repeat
        // would tear down a working call.
        const st = this.pc.iceConnectionState;
        if (st !== 'disconnected' && st !== 'failed') return;
        if (this.pc.signalingState !== 'stable') return;
      }
      this._started = true;
      const pc = this.pc;
      const stream = this.localStream;
      (async () => {
        try {
          await pc.setRemoteDescription({ type: 'offer', sdp: this.remoteSdp });
          // addTrack throws on a re-offer: the transceivers already exist.
          // replaceTrack keeps the existing senders carrying the same sources.
          const senders = pc.getSenders();
          for (const t of stream.getTracks()) {
            const sender = senders.find((s) => s.track && s.track.kind === t.kind);
            if (sender) { try { await sender.replaceTrack(t); } catch (_) {} }
            else { try { pc.addTrack(t, stream); } catch (_) {} }
          }
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          await waitIce(pc, ICE_CAP);
          if (this.closed || this._peer.destroyed) return;
          this.answerSdp = pc.localDescription.sdp;
          this._peer._repeatAnswer(this);
        } catch (_) { this._peer._drop(this); }
      })();
    }
  }

  // ── Peer ───────────────────────────────────────────────────────────────────
  class Peer {
    constructor(id, opts) {
      this.id = String(id);
      this.opts = opts || {};
      this.room = (this.id.split('-')[1] || '').toUpperCase();
      this.destroyed = false;
      this._opened = false;

      this.handlers = { open: [], connection: [], call: [], error: [] };
      this._all = new Set();
      this._bySid = new Map();
      this._out = new Map();
      this._trace = [];

      if (typeof RTCPeerConnection !== 'function') {
        setTimeout(() => this._emit('error', { type: 'browser-incompatible' }), 0);
        return;
      }

      this.mqtt = new Mqtt({
        onReady: (first) => this._onReady(first),
        onMessage: (topic, payload) => this._onPayload(topic, payload),
      });
      this.mqtt.start();

      // If neither public relay has answered by now, a room genuinely
      // cannot be opened.  Saying so is more useful than blaming the
      // user's connection.
      this.relayTimer = setTimeout(() => {
        if (this._opened || this.destroyed) return;
        this._emit('error', { type: 'relay-down' });
      }, 15000);
    }

    on(ev, fn) { if (this.handlers[ev]) this.handlers[ev].push(fn); return this; }

    _emit(ev, arg) {
      for (const fn of this.handlers[ev] || []) { try { fn(arg); } catch (e) { console.error(e); } }
    }

    _tr(kind, detail) {
      this._trace.push({ t: Date.now() % 100000, kind, detail });
      if (this._trace.length > 60) this._trace.shift();
    }

    // One broadcast topic per room — both peers subscribe to it.
    topicFor() { return ROOT + '/' + this.room; }

    // Send a signalling message through the WebRTC data channel when one is
    // open.  A direct data channel is far more reliable than the public MQTT
    // broker and bypasses it entirely.  Returns true when the message was sent.
    _sendViaData(peerId, msg) {
      for (const conn of this._all) {
        if (conn.kind !== 'data' || conn.peer !== peerId) continue;
        if (!conn.open || !conn.dc || conn.dc.readyState !== 'open') continue;
        try {
          conn.dc.send(JSON.stringify({ ...msg, __sig: true }));
          return true;
        } catch (_) {}
      }
      return false;
    }

    _pub(peerId, msg) {
      if (this.destroyed) return;
      const m = { ...msg, cid: this.mqtt.cid };
      if (!m.to) m.to = peerId;
      this._tr('pub', m.t + (m.kind ? '/' + m.kind : '') + ' to=' + (m.to || '').slice(-6) + ' sid=' + (m.sid || '').slice(0, 6));
      if (this._sendViaData(peerId, m)) return;
      this.mqtt.publish(this.topicFor(), m);
    }

    _onDcSignal(m) {
      if (!m || typeof m !== 'object') return;
      this._tr('dc', (m.t || '?') + (m.kind ? '/' + m.kind : '') + ' sid=' + (m.sid || '').slice(0, 6));
      if (m.t === 'offer') return this._inOffer(m);
      if (m.t === 'answer') return this._inAnswer(m);
      if (m.t === 'bye') return this._inBye(m);
    }

    _sendAnswer(conn) {
      if (this.destroyed || conn.closed || !conn.answerSdp) return;
      this._pub(conn.peer, { t: 'answer', from: this.id, sid: conn.sid, sdp: conn.answerSdp });
    }

    _repeatAnswer(conn) {
      for (const delay of RETRY) {
        setTimeout(() => {
          if (this.destroyed || conn.closed || !conn.answerSdp) return;
          if (conn.pc && (conn.pc.connectionState === 'connected' || conn.pc.signalingState === 'stable')) return;
          this._sendAnswer(conn);
        }, delay);
      }
    }

    _onReady(first) {
      this.mqtt.subscribe(this.topicFor());
      this._tr('ready', 'first=' + first);
      if (this.relayTimer) { clearTimeout(this.relayTimer); this.relayTimer = null; }

      if (!this._opened) {
        this._opened = true;
        this._emit('open', this.id);
        return;
      }

      for (const conn of Array.from(this._out.values())) {
        if (conn.closed) continue;
        if (conn.pc && conn.pc.connectionState === 'connected') continue;
        this._offer(conn);
      }
      for (const conn of Array.from(this._all)) {
        if (conn.closed || !conn.answerSdp) continue;
        if (conn.pc && conn.pc.connectionState === 'connected') continue;
        this._sendAnswer(conn);
      }
    }

    _newPc() {
      return new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    }

    connect(peerId) {
      const conn = new DataConn(this, String(peerId));
      this._dial(conn, null);
      return conn;
    }

    call(peerId, stream) {
      const mc = new MediaConn(this, String(peerId));
      this._dial(mc, stream);
      return mc;
    }

    _dial(target, stream) {
      target.sid = hex(6);
      target.pc = this._newPc();
      target._isDialer = true;
      this._all.add(target);
      this._bySid.set(target.sid, target);
      this._out.set(target.peer + '|' + target.kind, target);

      const pc = target.pc;

      if (target.kind === 'data') {
        this._bindDc(target, pc.createDataChannel('d', { ordered: true }));
      } else {
        this._wireTracks(target);
        for (const t of stream.getTracks()) { try { pc.addTrack(t, stream); } catch (_) {} }
        // An ICE restart re-gathers candidates and asks for renegotiation.
        // The initial offer is sent before this handler can fire, so the
        // first firing is the one we already handled in the block below.
        pc.onnegotiationneeded = () => {
          if (target.closed || this.destroyed) return;
          if (!pc.currentRemoteDescription) return;  // initial exchange not complete yet
          if (pc.signalingState !== 'stable') return;
          (async () => {
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              await waitIce(pc, ICE_CAP);
              if (target.closed || this.destroyed) return;
              // A fresh sid makes the remote side treat this as a new offer
              // rather than replaying the previous answer.
              const oldSid = target.sid;
              target.sid = hex(6);
              this._bySid.delete(oldSid);
              this._bySid.set(target.sid, target);
              this._offer(target);
            } catch (_) {}
          })();
        };
      }

      (async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await waitIce(pc, ICE_CAP);
          if (target.closed || this.destroyed) return;
          this._offer(target);
        } catch (_) { this._drop(target); }
      })();
    }

    _offer(target) {
      if (this.destroyed || target.closed || !target.pc) return;
      if (!target.pc.localDescription) return;
      const send = () => {
        if (this.destroyed || target.closed || !target.pc) return;
        if (target.pc.connectionState === 'connected') return;
        this._pub(target.peer, {
          t: 'offer',
          from: this.id,
          sid: target.sid,
          kind: target.kind,
          sdp: target.pc.localDescription.sdp,
        });
      };

      // A single offer is a single chance.  The other side may not have been
      // subscribed yet — a room created a moment ago, or a relay still
      // connecting — and a lost offer used to cost the whole call.  Repeating
      // is safe: a duplicate offer for a known sid just replays the answer.
      send();
      for (const delay of OFFER_RETRY) setTimeout(send, delay);

      if (target.failTimer) clearTimeout(target.failTimer);
      target.failTimer = setTimeout(() => {
        if (target.closed || (target.pc && target.pc.connectionState === 'connected')) return;
        this._drop(target);
      }, 30000);
    }

    _onPayload(topic, payload) {
      if (topic !== this.topicFor()) return;
      let m;
      try { m = JSON.parse(payload); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      // Ignore our own echoes.
      if (m.cid === this.mqtt.cid) return;

      this._tr('recv', (m.t || '?') + (m.kind ? '/' + m.kind : '') + ' to=' + (m.to || '').slice(-6) + ' sid=' + (m.sid || '').slice(0, 6));

      if (m.t === 'offer') return this._inOffer(m);
      if (m.t === 'answer') return this._inAnswer(m);
      if (m.t === 'bye') return this._inBye(m);
    }

    _inOffer(m) {
      if (m.to !== this.id) return;

      const known = this._bySid.get(m.sid);
      if (known) {
        if (known.answerSdp && !known.closed) this._sendAnswer(known);
        return;
      }

      const mine = this._out.get(m.from + '|' + m.kind);
      if (mine && mine.sid && mine.sid < m.sid) return;
      if (mine) this._drop(mine);

      const pc = this._newPc();

      if (m.kind === 'data') {
        const conn = new DataConn(this, m.from);
        conn.sid = m.sid;
        conn.pc = pc;
        this._all.add(conn);
        this._bySid.set(m.sid, conn);
        pc.ondatachannel = (ev) => {
          if (ev.channel.label === 'd') this._bindDc(conn, ev.channel);
        };
        this._emit('connection', conn);
        this._answerData(conn, m.sdp);
        return;
      }

      const mc = new MediaConn(this, m.from);
      mc.sid = m.sid;
      mc.pc = pc;
      mc.remoteSdp = m.sdp;
      this._wireTracks(mc);
      this._all.add(mc);
      this._bySid.set(m.sid, mc);
      this._emit('call', mc);
    }

    async _answerData(conn, sdp) {
      try {
        await conn.pc.setRemoteDescription({ type: 'offer', sdp });
        const ans = await conn.pc.createAnswer();
        await conn.pc.setLocalDescription(ans);
        await waitIce(conn.pc, ICE_CAP);
        if (conn.closed || this.destroyed) return;
        conn.answerSdp = conn.pc.localDescription.sdp;
        this._repeatAnswer(conn);
      } catch (_) { this._drop(conn); }
    }

    _inAnswer(m) {
      if (m.to !== this.id) return;
      const target = this._bySid.get(m.sid);
      if (!target || target.closed || !target.pc) return;
      if (target.pc.signalingState !== 'have-local-offer') return;
      if (target.failTimer) { clearTimeout(target.failTimer); target.failTimer = null; }
      this._tr('apply', 'sid=' + (m.sid || '').slice(0, 6));
      target.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp })
        .catch(() => this._drop(target));
    }

    _inBye(m) {
      if (m.to !== this.id) return;
      const target = this._bySid.get(m.sid);
      if (target) this._drop(target);
    }

    _bindDc(conn, dc) {
      conn.dc = dc;
      dc.onopen = () => { conn.open = true; conn._emit('open'); };
      dc.onclose = () => this._drop(conn);
      dc.onerror = () => {};
      dc.onmessage = (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch (_) { return; }
        conn._emit('data', d);
      };
      if (dc.readyState === 'open') {
        conn.open = true;
        setTimeout(() => conn._emit('open'), 0);
      }
    }

    _wireTracks(mc) {
      mc.remoteStream = new MediaStream();
      mc.pc.ontrack = (ev) => {
        try { mc.remoteStream.addTrack(ev.track); } catch (_) {}
        mc._emit('stream', mc.remoteStream);
      };
      mc.pc.onconnectionstatechange = () => {
        if (mc.pc.connectionState !== 'failed') return;
        if (mc.closed || this.destroyed) return;
        this._redialMedia(mc);
      };
      mc.pc.oniceconnectionstatechange = () => {
        if (mc.pc.iceConnectionState !== 'disconnected') return;
        if (mc.closed || this.destroyed) return;
        const pc = mc.pc;
        setTimeout(() => {
          if (mc.closed || this.destroyed) return;
          if (pc.iceConnectionState !== 'disconnected') return;
          if (pc.signalingState !== 'stable') return;
          // Caller: restartIce() triggers onnegotiationneeded → new offer sent.
          // Answerer: restartIce() has no offer path; fall back to full redial.
          if (mc._isDialer) {
            try { pc.restartIce(); } catch (_) {}
          } else {
            this._redialMedia(mc);
          }
        }, 2000);
      };
    }

    _redialMedia(old) {
      const remote = old.peer;
      const stream = old.localStream;
      const tries = (old._tries || 0) + 1;
      this._drop(old);
      if (tries > 3 || !stream) {
        this._emit('error', { type: 'media-failed', peer: remote });
        return;
      }
      const mc = new MediaConn(this, remote);
      mc._tries = tries;
      this._dial(mc, stream);
    }

    _drop(target) {
      if (!target || target.closed) return;
      target.closed = true;
      target.open = false;
      this._all.delete(target);
      if (target.sid) this._bySid.delete(target.sid);
      const key = target.peer + '|' + target.kind;
      if (this._out.get(key) === target) this._out.delete(key);
      if (target.failTimer) { clearTimeout(target.failTimer); target.failTimer = null; }
      try { target.dc && target.dc.close(); } catch (_) {}
      try { target.pc && target.pc.close(); } catch (_) {}
      target._emit('close');
    }

    destroy() {
      this.destroyed = true;
      if (this.relayTimer) { clearTimeout(this.relayTimer); this.relayTimer = null; }
      try { this.mqtt.close(); } catch (_) {}
      for (const t of Array.from(this._all)) this._drop(t);
      this._all.clear();
      this._bySid.clear();
      this._out.clear();
    }
  }

  global.Peer = Peer;
  // The account layer opens its own connection to the same relay.  Sharing one
  // connection would couple sign-in to whatever room happens to be open.
  global.RuporBus = {
    Mqtt,
    MqttReader,
    mqttRead,
    mqttReadNewest,
    mqttReadEach,
    ROOT: 'rupor/v3',
    hex,
    // Diagnostic values for integration tests
    ICE_CAP,
    ICE_SERVERS: ICE,
  };
})(window);
