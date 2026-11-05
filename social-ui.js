/* The groups and chat interface.

   Accounts are local-only (localStorage): sign up picks a username and
   password, stored in the browser.  No server, no MQTT for accounts.
   Groups use MQTT for a shared member list; everything else is local.

   Without an account the call screen still works — type a name and join. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const api = window.Rupor && window.Rupor.api;

  const el = {
    social: $('#social'),
    home: $('#home'),
    auth: $('#auth'),
    meName: $('#me-name'),
    meTag: $('#me-tag'),
    meAvatar: $('#me-avatar'),
    btnSignout: $('#btn-signout'),
    btnAccount: $('#btn-account'),
    btnSocial: $('#btn-social'),
    groups: $('#groups'),
    groupsList: $('#groups-list'),
    mainTitle: $('#main-title'),
    groupTab: $('[data-tab="groups"]'),
    sideCalls: $('#side-calls'),
    sideGroups: $('#side-groups'),
    panelGroups: $('#panel-groups'),
    panelChat: $('#panel-chat'),
    chatTitle: $('#chat-title'),
    chatBack: $('#chat-back'),
    chatLog: $('#chat-log-social'),
    chatForm: $('#chat-form-social'),
    chatInput: $('#chat-input-social'),
    invites: $('#invites'),
    invitesWrap: $('#invites-wrap'),
    callOverlay: $('#call-overlay'),
    callBox: $('#call-box'),
    callAvatar: $('#call-avatar'),
    callLabel: $('#call-label'),
    callCaller: $('#call-caller'),
    callGroup: $('#call-group'),
    callAcceptActions: $('#call-accept-actions'),
    callHangupActions: $('#call-hangup-actions'),
    btnCallAccept: $('#btn-call-accept'),
    btnCallDecline: $('#btn-call-decline'),
    btnCallHangup: $('#btn-call-hangup'),
  };

  if (!el.social || !api) return;

  let busy = false;
  let openChatGid = null;
  let chatStream = null;
  let _presenceTimer = null;
  let _presenceMap = Object.create(null);
  let _lastGroups = [];

  // ── SMALL HELPERS ─────────────────────────────────────────────────────────
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function colorFor(id) {
    let h = 0;
    for (let i = 0; i < String(id || '').length; i++) h = (h * 31 + String(id || '').charCodeAt(i)) % 360;
    return 'oklch(72% 0.14 ' + h + ')';
  }

  function note(text) {
    if (window.__rup && typeof window.__rup.toast === 'function') window.__rup.toast(text);
    else console.log(text);
  }

  const ERRORS = {
    BAD_NAME: 'Имя: 3–24 символа, латиница, цифры, . _ -',
    SHORT_PASSWORD: 'Пароль не короче 6 символов.',
    NAME_TAKEN: 'Это имя уже занято. Выберите другое.',
    SIGNIN_FAILED: 'Неверное имя или пароль.',
    NO_SUCH_USER: 'Такого имени нет. Проверьте написание.',
    GROUP_NOT_FOUND: 'Группа с таким кодом не найдена.',
    GROUP_NAME: 'У группы должно быть название.',
    OWNER_CANNOT_LEAVE: 'Организатор не может выйти из своей группы. Её можно только удалить.',
    NOT_OWNER: 'Удалить группу может только организатор.',
    NO_ROOM: 'Сначала создайте комнату.',
  };

  function say(err) {
    const raw = (err && err.message) || String(err);
    return ERRORS[raw] || raw;
  }

  // ── ACCOUNT ───────────────────────────────────────────────────────────────
  function paintMe() {
    const p = api.profile;
    const signedIn = !!p;
    el.meName.textContent = p ? p.display_name : 'Гость';
    el.meTag.textContent = p ? '@' + p.username : 'без аккаунта';
    el.meAvatar.textContent = initials(p ? p.display_name : '?');
    el.meAvatar.style.background = p ? colorFor(p.id) : 'var(--muted)';
    el.btnSignout.hidden = !signedIn;
    el.btnAccount.classList.toggle('hidden', signedIn);
    el.btnSocial.classList.toggle('hidden', !signedIn);
    el.btnAccount.textContent = signedIn ? 'Группы' : 'Войти';
  }

  function openAuth() {
    $('#auth-err').textContent = '';
    $('#auth-pass').value = '';
    el.auth.classList.remove('hidden');
    setTimeout(() => $('#auth-user').focus(), 40);
  }

  function closeAuth() {
    el.auth.classList.add('hidden');
  }

  async function doAuth() {
    if (busy) return;
    const errBox = $('#auth-err');
    errBox.textContent = '';

    const user = $('#auth-user').value.trim();
    const pass = $('#auth-pass').value;

    if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(user)) {
      errBox.textContent = 'Имя: 3–24 символа, латиница, цифры, . _ -';
      return;
    }
    if (pass.length < 6) {
      errBox.textContent = 'Пароль не короче 6 символов.';
      return;
    }

    busy = true;
    const btn = $('#btn-auth-go');
    const was = btn.textContent;
    btn.textContent = 'Подождите…';
    btn.disabled = true;
    try {
      // Try sign-in first; if the name is unknown, sign up instead.
      try {
        await api.signIn(user, pass);
      } catch (e) {
        if (e.message === 'NO_SUCH_USER') {
          const display = user;
          await api.signUp(user, pass, display);
        } else {
          throw e;
        }
      }

      api.startPresence();
      // Subscribe to incoming call invites immediately after sign-in.
      api.onInvite(onIncomingInvite);
      paintMe();
      closeAuth();
      openSocial();
    } catch (e) {
      errBox.textContent = say(e);
    } finally {
      busy = false;
      if (!el.auth.classList.contains('hidden')) btn.textContent = was;
      btn.disabled = false;
    }
  }

  // ── GROUPS ────────────────────────────────────────────────────────────────
  let painting = false;
  let paintAgain = false;

  async function paintGroups() {
    if (painting) { paintAgain = true; return; }
    painting = true;
    try {
      do { paintAgain = false; await paintGroupsOnce(); } while (paintAgain);
    } finally {
      painting = false;
    }
  }

  // Paint immediately from cache (zero network), then refresh from network.
  async function paintGroupsFast() {
    if (api.myGroupsCached) {
      const cached = api.myGroupsCached();
      if (cached.length) renderGroups(cached);
    }
    await paintGroups();
  }

  async function paintGroupsOnce() {
    if (!api.signedIn) { el.groupsList.replaceChildren(); return; }
    let groups;
    try { groups = await api.myGroups(); } catch (e) { note(say(e)); return; }
    renderGroups(groups);
  }

  function renderGroups(groups) {
    _lastGroups = groups || [];
    const box = document.createDocumentFragment();

    if (!groups.length) {
      const p = document.createElement('p');
      p.className = 'social-hint';
      p.textContent = 'Групп пока нет. Создайте или войдите по коду.';
      box.appendChild(p);
      el.groupsList.replaceChildren(box);
      return;
    }

    for (const g of groups) {
      const card = document.createElement('div');
      card.className = 'group-card';

      const head = document.createElement('header');
      const name = document.createElement('b');
      name.textContent = g.name;
      head.appendChild(name);

      const codeEl = document.createElement('span');
      codeEl.className = 'group-code';
      codeEl.textContent = g.invite;
      codeEl.title = 'Скопировать код приглашения';
      codeEl.addEventListener('click', () => {
        copyText(g.invite).then((ok) => note(ok ? 'Код скопирован: ' + g.invite : g.invite));
      });
      head.appendChild(codeEl);

      const chatBtn = document.createElement('button');
      chatBtn.className = 'act';
      chatBtn.type = 'button';
      chatBtn.textContent = 'Чат';
      chatBtn.title = 'Открыть общий чат группы';
      chatBtn.addEventListener('click', () => enterChat(g));
      head.appendChild(chatBtn);

      const callBtn = document.createElement('button');
      callBtn.className = 'act call';
      callBtn.type = 'button';
      callBtn.textContent = 'Начать звонок';
      callBtn.title = 'Создать комнату и пригласить всю группу';
      callBtn.addEventListener('click', () => callGroup(g));
      head.appendChild(callBtn);

      card.appendChild(head);

      const members = document.createElement('div');
      members.className = 'group-members';
      for (const m of g.members) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        if (m.id) {
          const dot = document.createElement('span');
          dot.className = 'presence-dot' + (_presenceMap[m.id] ? ' online' : '');
          dot.dataset.uid = m.id;
          dot.title = _presenceMap[m.id] ? 'В сети' : 'Не в сети';
          chip.appendChild(dot);
        }
        const b = document.createElement('b');
        b.textContent = m.display || m.display_name || '?';
        chip.appendChild(b);
        if (m.id && m.id === g.owner) chip.appendChild(document.createTextNode(' · организатор'));
        members.appendChild(chip);
      }
      card.appendChild(members);

      const actions = document.createElement('div');
      actions.className = 'group-create';
      actions.style.marginTop = '10px';
      const leave = document.createElement('button');
      leave.className = 'side-btn';
      leave.type = 'button';
      leave.textContent = g.role === 'owner' ? 'Удалить группу' : 'Выйти из группы';
      leave.addEventListener('click', () => guard(async () => {
        if (g.role === 'owner') await api.deleteGroup(g.id);
        else await api.leaveGroup(g.id);
        if (openChatGid === g.id) exitChat();
        await paintGroups();
      }));
      actions.appendChild(leave);
      card.appendChild(actions);

      box.appendChild(card);
    }

    el.groupsList.replaceChildren(box);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      t.remove();
      return ok;
    }
  }

  // ── GROUP CHAT ─────────────────────────────────────────────────────────────
  function loadChatHistory(gid) {
    if (!api.loadChatHistory) return;
    const history = api.loadChatHistory(gid);
    if (!history || !history.length) return;
    // Only populate when log is still empty (avoid re-painting live messages).
    if (el.chatLog.children.length) return;
    for (const msg of history) {
      appendChat({
        seq: msg.seq || null,
        at:  msg.at  || null,
        from: msg.from || '',
        name: msg.display || msg.name || '?',
        text: msg.text || '',
      });
    }
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  async function enterChat(group) {
    if (openChatGid === group.id) return;
    exitChat();
    openChatGid = group.id;
    el.chatTitle.textContent = group.name;
    el.chatLog.innerHTML = '';

    el.panelGroups.classList.add('hidden');
    el.panelChat.classList.remove('hidden');

    // Show cached history instantly before the network round-trip.
    loadChatHistory(group.id);

    await api.openChat(group.id);
    chatStream = api.onChat((msg) => {
      if (openChatGid !== group.id) return;
      appendChat(msg);
    });
  }

  function _attrVal(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function appendChat(msg) {
    const body = String(msg.text || '');
    // Our own message is painted the moment it is typed; when the retained
    // copy comes back from the broker it must not appear a second time.
    const key = msg.seq != null
      ? String(msg.seq)
      : msg.at != null
        ? String(msg.at)
        : (msg.from || '') + '|' + body;

    if (el.chatLog.querySelector('[data-msgid="' + _attrVal(key) + '"]')) return;

    if (msg.at != null && msg.from === api.userId) {
      const echo = el.chatLog.querySelector(
        '[data-msgid="' + _attrVal((msg.from || '') + '|' + body) + '"]'
      );
      if (echo) { echo.dataset.msgid = key; return; }
    }

    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.dataset.msgid = key;
    if (api.userId) row.dataset.text = body;

    const who = document.createElement('b');
    who.textContent = (msg.name || '?') + ': ';
    who.style.color = colorFor(msg.from);
    row.appendChild(who);

    const text = document.createElement('span');
    text.textContent = msg.text;
    row.appendChild(text);

    el.chatLog.appendChild(row);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function exitChat() {
    if (chatStream) { chatStream(); chatStream = null; }
    api.closeChat();
    openChatGid = null;
    el.panelChat.classList.add('hidden');
    el.panelGroups.classList.remove('hidden');
  }

  // ── RINGTONE ──────────────────────────────────────────────────────────────
  // Discord-style ring: ascending 3-note motif (D5→G5→B5) for incoming,
  // soft repeating tone for outgoing.  Handles suspended AudioContext with a
  // one-time user-interaction fallback notification.
  class RingTone {
    constructor(outgoing = false) {
      this._ctx = null;
      this._timer = null;
      this._outgoing = outgoing;
      this._stopped = false;
      this._audioWarnShown = false;
    }

    start() {
      if (this._ctx) return;
      this._stopped = false;
      try {
        this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) { return; }

      if (this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
        // Notify user and wire a one-time click handler to unlock audio
        if (!this._audioWarnShown) {
          this._audioWarnShown = true;
          note('Звук заблокирован браузером. Нажмите в любое место страницы для включения звука.');
          const unlock = () => {
            if (this._ctx) this._ctx.resume().catch(() => {});
            document.removeEventListener('click', unlock);
          };
          document.addEventListener('click', unlock, { once: true });
        }
      }

      const play = () => {
        if (this._stopped || !this._ctx) return;
        const ctx = this._ctx;
        const now = ctx.currentTime;

        if (this._outgoing) {
          // Outgoing: soft repeating single tone
          this._playNote(ctx, 440, now,       0.3, 0.12);
          this._playNote(ctx, 440, now + 0.4, 0.3, 0.12);
        } else {
          // Incoming Discord-style: ascending 3-note motif
          this._playNote(ctx, 587.33, now,        0.15, 0.10); // D5
          this._playNote(ctx, 783.99, now + 0.17, 0.15, 0.10); // G5
          this._playNote(ctx, 987.77, now + 0.34, 0.20, 0.12); // B5
        }
      };

      play();
      this._timer = setInterval(play, this._outgoing ? 2500 : 2000);
    }

    _playNote(ctx, freq, startTime, duration, volume) {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
        gain.gain.setValueAtTime(volume, startTime + duration - 0.03);
        gain.gain.linearRampToValueAtTime(0, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration + 0.01);
      } catch (_) {}
    }

    stop() {
      this._stopped = true;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      if (this._ctx) { try { this._ctx.close(); } catch (_) {} this._ctx = null; }
    }
  }

  let _ring = null; // current active ringtone

  function startRing(outgoing) {
    if (_ring) _ring.stop();
    _ring = new RingTone(outgoing);
    _ring.start();
  }

  function stopRing() {
    if (_ring) { _ring.stop(); _ring = null; }
  }

  // ── CALL OVERLAY HELPERS ──────────────────────────────────────────────────
  let _pendingInv = null; // invite being shown to callee

  function showCallOverlay({ label, caller, group, outgoing }) {
    if (!el.callOverlay) return;
    el.callLabel.textContent = label;
    el.callCaller.textContent = caller;
    el.callGroup.textContent = group || '';
    el.callAvatar.textContent = (caller || '?')[0].toUpperCase();
    if (outgoing) {
      el.callBox.classList.add('calling');
      el.callAcceptActions.classList.add('hidden');
      el.callHangupActions.classList.remove('hidden');
    } else {
      el.callBox.classList.remove('calling');
      el.callAcceptActions.classList.remove('hidden');
      el.callHangupActions.classList.add('hidden');
    }
    el.callOverlay.classList.remove('hidden');
  }

  function hideCallOverlay() {
    if (!el.callOverlay) return;
    el.callOverlay.classList.add('hidden');
    el.callBox.classList.remove('calling');
    _pendingInv = null;
  }

  // ── CALLING ───────────────────────────────────────────────────────────────
  function myDisplay() {
    const p = api.profile;
    if (p) return p.display_name;
    return ($('#name').value || '').trim() || 'Гость';
  }

  // Tracks the outgoing call so hangup can dismiss invites on the other side.
  let _outgoingCall = null; // set after inviteToCall succeeds

  async function callGroup(group) {
    const code = window.__rup.createRoom(myDisplay());
    if (!code) { note(ERRORS.NO_ROOM); return; }
    exitChat();
    el.social.classList.add('hidden');
    showCallOverlay({
      label: 'Звонок в группу',
      caller: group.name,
      group: '',
      outgoing: true,
    });
    startRing(true);
    try {
      await api.inviteToCall({ groupId: group.id, room: code });
      _outgoingCall = { room: code };
      note('Комната ' + code + ' создана, группа оповещена');
    } catch (e) {
      note(say(e));
    }
  }

  function joinCode(code) {
    closeSocial();
    if (!window.__rup.joinRoom(code, myDisplay())) return false;
    return true;
  }

  // ── INCOMING CALLS ────────────────────────────────────────────────────────
  // An invitation is written to a retained topic under the invitee's id, so it
  // survives the inviter closing their laptop.  The panel polls while it is
  // open and offers a single button that joins the room.
  let paintingInvites = false;

  // Shared handler for both push and poll paths.
  function onIncomingInvite(inv) {
    if (!inv || !inv.id) return;

    // Caller hung up: stop ringing if this was the invite we were showing.
    if (inv.cancelled) {
      if (_pendingInv && _pendingInv.id === inv.id) {
        stopRing();
        hideCallOverlay();
        if (el.invites) el.invites.replaceChildren();
        if (el.invitesWrap) el.invitesWrap.classList.add('hidden');
      }
      return;
    }

    if (!_pendingInv || _pendingInv.id !== inv.id) {
      _pendingInv = inv;
      showCallOverlay({
        label: 'Входящий звонок',
        caller: inv.name || 'Кто-то',
        group: inv.groupName || '',
        outgoing: false,
      });
      startRing(false);
    }
  }

  async function paintInvites() {
    if (!api.signedIn || !el.invites) return;
    if (paintingInvites) return;
    paintingInvites = true;
    try { await paintInvitesOnce(); } finally { paintingInvites = false; }
  }

  async function paintInvitesOnce() {
    let list;
    try { list = await api.pendingInvites(); } catch (_) { return; }

    if (!list || !list.length) {
      if (el.invitesWrap) el.invitesWrap.classList.add('hidden');
      el.invites.replaceChildren();
      // If the overlay was for an invite that is now gone (accepted elsewhere or
      // dismissed), close it automatically.
      if (_pendingInv && !el.callBox.classList.contains('calling')) {
        stopRing();
        hideCallOverlay();
      }
      return;
    }

    // Show the overlay for the first (most recent) invite immediately.
    const inv = list[0];
    onIncomingInvite(inv);

    // Also keep the sidebar list in sync (hidden behind overlay but useful for
    // multi-invite scenarios and tests).
    if (el.invitesWrap) el.invitesWrap.classList.remove('hidden');
    const box = document.createDocumentFragment();
    for (const inv of list) {
      const row = document.createElement('div');
      row.className = 'invite-row';

      const who = document.createElement('b');
      who.textContent = inv.name || 'Кто-то';
      row.appendChild(who);

      const code = document.createElement('span');
      code.className = 'group-code';
      code.textContent = inv.room;
      row.appendChild(code);

      const go = document.createElement('button');
      go.className = 'side-btn';
      go.type = 'button';
      go.textContent = 'Присоединиться';
      go.addEventListener('click', () => guard(async () => {
        await api.dismissInvite(inv.id);
        stopRing();
        hideCallOverlay();
        joinCode(inv.room);
        await paintInvites();
      }));
      row.appendChild(go);

      const no = document.createElement('button');
      no.className = 'me-out';
      no.type = 'button';
      no.title = 'Отклонить';
      no.textContent = '×';
      no.addEventListener('click', () => guard(async () => {
        await api.dismissInvite(inv.id);
        stopRing();
        hideCallOverlay();
        await paintInvites();
      }));
      row.appendChild(no);

      box.appendChild(row);
    }
    el.invites.replaceChildren(box);
  }

  // ── PRESENCE POLLING ──────────────────────────────────────────────────────
  // Collects UIDs from cached groups and asks api.getPresence when available.
  // Falls back to no-op (dots stay grey) when the API lacks getPresence.
  async function refreshPresence() {
    if (!api.getPresence) return;
    const uids = new Set();
    for (const g of _lastGroups) {
      if (Array.isArray(g.members)) g.members.forEach((m) => { if (m.id) uids.add(m.id); });
    }
    if (!uids.size) return;
    try {
      const map = await api.getPresence(Array.from(uids));
      if (map && typeof map === 'object') {
        _presenceMap = map;
        // Patch existing dots in DOM without full re-render.
        document.querySelectorAll('.presence-dot[data-uid]').forEach((dot) => {
          const online = !!_presenceMap[dot.dataset.uid];
          dot.classList.toggle('online', online);
          dot.title = online ? 'В сети' : 'Не в сети';
        });
      }
    } catch (_) {}
  }

  // ── CSS INJECTION ─────────────────────────────────────────────────────────
  (function injectStyles() {
    if (document.getElementById('social-ui-styles')) return;
    const s = document.createElement('style');
    s.id = 'social-ui-styles';
    s.textContent = [
      '.loading { opacity: 0.6; cursor: wait; }',
      '.presence-dot {',
      '  display: inline-block; width: 10px; height: 10px;',
      '  border-radius: 50%; background: #555;',
      '  margin-right: 4px; vertical-align: middle;',
      '}',
      '.presence-dot.online { background: #43b581; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(s);
  })();

  // ── VIEWS ─────────────────────────────────────────────────────────────────
  function openSocial() {
    el.home.classList.add('hidden');
    el.social.classList.remove('hidden');
    paintMe();
    showGroups();
    if (api.signedIn) api.startPresence();
    paintInvites();
    if (!openSocial.timer) {
      openSocial.timer = setInterval(() => {
        if (el.social.classList.contains('hidden')) return;
        // Push subscription handles instant invite notifications; polling is
        // just a safety net for missed retained messages (e.g. tab was hidden).
        paintInvites();
        if (!openChatGid) paintGroups();
      }, 20000);
    }
    if (!_presenceTimer) {
      refreshPresence();
      _presenceTimer = setInterval(() => {
        if (!el.social.classList.contains('hidden')) refreshPresence();
      }, 30000);
    }
  }

  function closeSocial() {
    exitChat();
    if (openSocial.timer) {
      clearInterval(openSocial.timer);
      openSocial.timer = null;
    }
    if (_presenceTimer) { clearInterval(_presenceTimer); _presenceTimer = null; }
    el.social.classList.add('hidden');
    el.home.classList.remove('hidden');
  }

  function showGroups() {
    el.panelChat.classList.add('hidden');
    el.panelGroups.classList.remove('hidden');
    if (el.sideCalls) el.sideCalls.classList.add('hidden');
    if (el.sideGroups) el.sideGroups.classList.remove('hidden');
    if (el.groupTab) el.groupTab.classList.add('on');
    el.mainTitle.textContent = 'Группы';
    paintGroupsFast();
  }

  async function guard(fn) {
    try { await fn(); }
    catch (e) { note(say(e)); }
  }

  // ── CALL OVERLAY BUTTONS ──────────────────────────────────────────────────
  if (el.btnCallAccept) {
    el.btnCallAccept.addEventListener('click', () => {
      const inv = _pendingInv;
      stopRing();
      hideCallOverlay();
      if (inv) {
        guard(async () => {
          await api.dismissInvite(inv.id);
          joinCode(inv.room);
          await paintInvites();
        });
      }
    });
  }

  if (el.btnCallDecline) {
    el.btnCallDecline.addEventListener('click', () => {
      const inv = _pendingInv;
      stopRing();
      hideCallOverlay();
      if (inv) {
        guard(async () => {
          await api.dismissInvite(inv.id);
          await paintInvites();
        });
      }
    });
  }

  if (el.btnCallHangup) {
    el.btnCallHangup.addEventListener('click', () => {
      stopRing();
      hideCallOverlay();
      _outgoingCall = null;
      if (api.cancelInvites) api.cancelInvites().catch(() => {});
    });
  }

  // ── AUDIO-ONLY BUTTON ─────────────────────────────────────────────────────
  // Injected into the hangup-actions bar; disables video tracks while in call.
  (function addAudioOnlyBtn() {
    const hangupActions = $('#call-hangup-actions');
    if (!hangupActions) return;
    const btn = document.createElement('button');
    btn.id = 'btn-audio-only';
    btn.className = 'call-btn';
    btn.type = 'button';
    btn.title = 'Только аудио';
    btn.style.cssText = 'background:var(--muted,#444);font-size:0.72rem;padding:6px 10px;border-radius:12px;white-space:nowrap;';
    btn.textContent = 'Только аудио';
    let audioOnly = false;
    btn.addEventListener('click', () => {
      audioOnly = !audioOnly;
      // Disable/re-enable local camera tracks via __rup.camStream.
      try {
        const cs = window.__rup && window.__rup.camStream;
        if (cs) cs.getVideoTracks().forEach((t) => { t.enabled = !audioOnly; });
      } catch (_) {}
      btn.textContent = audioOnly ? 'Включить видео' : 'Только аудио';
      btn.style.background = audioOnly ? 'var(--ok,#43b581)' : 'var(--muted,#444)';
    });
    hangupActions.appendChild(btn);
  })();

  // ── WIRING ────────────────────────────────────────────────────────────────
  $('#btn-auth-go').addEventListener('click', doAuth);
  if ($('#btn-auth-cancel')) $('#btn-auth-cancel').addEventListener('click', closeAuth);
  if ($('#auth-pass')) $('#auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });
  if ($('#auth-user')) $('#auth-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#auth-pass').focus(); });

  el.btnAccount.addEventListener('click', () => {
    if (api.signedIn) openSocial();
    else openAuth();
  });

  el.btnSocial.addEventListener('click', openSocial);

  el.btnSignout.addEventListener('click', () => {
    guard(async () => {
      stopRing();
      hideCallOverlay();
      api.stopPresence();
      await api.signOut();
      // Nothing from the previous account may stay on screen: the group list
      // and any pending invitations belong to whoever was signed in before.
      exitChat();
      el.groupsList.replaceChildren();
      el.invites.replaceChildren();
      if (el.invitesWrap) el.invitesWrap.classList.add('hidden');
      paintMe();
    });
  });

  if (el.groupTab) el.groupTab.addEventListener('click', showGroups);
  if (el.chatBack) el.chatBack.addEventListener('click', exitChat);

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    // Show our own message immediately: the retained write takes a round-trip
    // and the log should not appear to have swallowed it.
    appendChat({ from: api.userId, name: myDisplay(), text });
    el.chatInput.value = '';
    el.chatInput.focus();
    Promise.resolve(api.sendChat(text)).then((ok) => {
      if (!ok) note('Не удалось отправить сообщение');
    });
  });

  async function withLoading(btn, fn) {
    if (!btn || btn.disabled) return;
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      await fn();
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  $('#btn-create-group').addEventListener('click', () => {
    const name = ($('#group-name').value || '').trim();
    if (!name) return;
    const btn = $('#btn-create-group');
    withLoading(btn, () => guard(async () => {
      await api.createGroup(name);
      $('#group-name').value = '';
      // Paint from the local cache first so the card appears immediately; the
      // network refresh runs in the background.  Awaiting the network here used
      // to keep the button disabled for several seconds.
      paintGroupsFast();
      note('Группа создана');
    }));
  });

  $('#btn-join-group').addEventListener('click', () => {
    const code = ($('#group-code').value || '').trim();
    if (!code) return;
    const btn = $('#btn-join-group');
    withLoading(btn, () => guard(async () => {
      await api.joinGroup(code);
      $('#group-code').value = '';
      paintGroupsFast();
      note('Вы вступили в группу');
    }));
  });

  if ($('#btn-new-room')) {
    $('#btn-new-room').addEventListener('click', () => {
      closeSocial();
      const code = window.__rup.createRoom(myDisplay());
      if (code) note('Комната ' + code + ' создана');
    });
  }

  // ── START ─────────────────────────────────────────────────────────────────
  paintMe();
  api.restore().then((p) => {
    paintMe();
    if (p) {
      api.startPresence();
      // Subscribe to incoming call invites so the overlay appears instantly.
      api.onInvite(onIncomingInvite);
    }
  }).catch(() => {});

  window.__social = {
    open: openSocial,
    close: closeSocial,
    refresh: async () => { await paintInvites(); await paintGroups(); },
    chat: enterChat,
    dismissOverlay: () => { stopRing(); hideCallOverlay(); },
    get calling() { return el.callBox ? el.callBox.classList.contains('calling') : false; },
    get overlayOpen() { return el.callOverlay ? !el.callOverlay.classList.contains('hidden') : false; },
    get ready() { return api.ready; },
    get signedIn() { return api.signedIn; },
  };

  // Live push updates for group records — repaints the panel immediately when
  // another member joins, leaves, or the owner changes the group name.
  if (api.onGroups) {
    api.onGroups(() => { if (!openChatGid) paintGroupsFast(); });
  }
})();
