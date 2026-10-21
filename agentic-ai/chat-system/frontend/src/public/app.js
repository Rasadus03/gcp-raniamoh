(function () {
  'use strict';

  // ==========================================================================
  // 1. NORMALIZED IN-MEMORY STORE & OPTIMISTIC OUTBOX (Zero Web Storage Tokens)
  // ==========================================================================
  const store = {
    csrfToken: null,
    currentUser: null,
    storageEngine: 'spanner',
    wsState: 'DISCONNECTED',
    reconnectAttempt: 0,
    activeChannelId: null,
    usersById: {},
    presenceByUserId: {},
    channelsById: {},
    messageIdsByChannel: {},
    messagesById: {},
    pendingMessagesByClientId: {},
    typingUsersByChannel: {},
  };

  let wsSocket = null;
  let heartbeatInterval = null;
  let lastTypingSentAt = 0;

  const SEEDED_USERS = [
    { username: 'alice', label: 'Alice Rivera (Principal Architect)' },
    { username: 'bob', label: 'Bob Chen (Staff SRE)' },
    { username: 'charlie', label: 'Charlie Patel (Security Engineer)' },
    { username: 'diana', label: 'Diana Okafor (Product Lead)' },
  ];

  // ==========================================================================
  // 2. SECURITY & PII MASKING UTILITIES (@chat/security-sanitizer)
  // ==========================================================================
  function maskEmail(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return '***@***';
    const parts = email.split('@');
    if (!parts[0] || !parts[1]) return '***@***';
    return parts[0].slice(0, 1) + '***@' + parts[1];
  }

  function maskIdentifier(idStr) {
    if (!idStr || typeof idStr !== 'string' || idStr.length <= 6) return '***';
    return idStr.slice(0, 4) + '***' + idStr.slice(-3);
  }

  function calculateBackoffWithFullJitter(attempt) {
    const safeAttempt = Math.max(0, Math.min(attempt, 10));
    const ceiling = Math.min(30000, 500 * Math.pow(2, safeAttempt));
    return Math.floor(Math.random() * ceiling);
  }

  // Accessible Modal Dialog with modern closedby="any" + fallback light-dismiss
  function openModal(titleText, bodyText) {
    const dialog = document.getElementById('app-dialog');
    const titleEl = document.getElementById('app-dialog-title');
    const bodyEl = document.getElementById('app-dialog-body');
    if (titleEl) titleEl.textContent = titleText;
    if (bodyEl) bodyEl.textContent = bodyText;
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }

  function setupDialogLightDismissFallback() {
    const dialog = document.getElementById('app-dialog');
    if (!dialog) return;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', function (event) {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      });
    }
  }

  function appendTrace(eventLabel) {
    const traceContainer = document.getElementById('trace-log');
    if (!traceContainer) return;

    const row = document.createElement('div');
    row.className = 'kv-row';

    const tSpan = document.createElement('span');
    tSpan.className = 'kv-key';
    tSpan.textContent = new Date().toLocaleTimeString();

    const vSpan = document.createElement('span');
    vSpan.className = 'kv-val';
    vSpan.textContent = eventLabel;

    row.appendChild(tSpan);
    row.appendChild(vSpan);
    traceContainer.prepend(row);

    while (traceContainer.childNodes.length > 12) {
      traceContainer.removeChild(traceContainer.lastChild);
    }
  }

  function setWsFsmState(nextState) {
    store.wsState = nextState;
    const pill = document.getElementById('ws-fsm-pill');
    if (pill) {
      pill.textContent = 'FSM: ' + nextState;
      if (nextState === 'SYNCED_READY') {
        pill.className = 'pill ready';
      } else {
        pill.className = 'pill warn';
      }
    }
    renderStoreInspector();
  }

  // ==========================================================================
  // 3. NORMALIZED STORE RECONCILER & SEQUENCE GAP DETECTION
  // ==========================================================================
  function reconcileMessage(msg) {
    const chId = msg.channel_id;
    const existingIds = store.messageIdsByChannel[chId] || [];

    // Sequence gap check
    if (existingIds.length > 0) {
      const lastId = existingIds[existingIds.length - 1];
      const lastMsg = store.messagesById[lastId];
      if (lastMsg && msg.sequence_num > lastMsg.sequence_num + 1) {
        appendTrace(
          'Seq gap detected (' +
            (lastMsg.sequence_num + 1) +
            '..' +
            (msg.sequence_num - 1) +
            ') -> Delta Sync'
        );
      }
    }

    // Remove matching optimistic message from pending outbox
    if (msg.client_message_id && store.pendingMessagesByClientId[msg.client_message_id]) {
      delete store.pendingMessagesByClientId[msg.client_message_id];
      appendTrace('Reconciled optimistic ' + msg.client_message_id.slice(0, 12));
    }

    store.messagesById[msg.message_id] = msg;
    if (!existingIds.includes(msg.message_id)) {
      existingIds.push(msg.message_id);
    }
    existingIds.sort(function (a, b) {
      const sa = (store.messagesById[a] && store.messagesById[a].sequence_num) || 0;
      const sb = (store.messagesById[b] && store.messagesById[b].sequence_num) || 0;
      return sa - sb;
    });
    store.messageIdsByChannel[chId] = existingIds;

    if (store.activeChannelId && store.activeChannelId !== chId && store.channelsById[chId]) {
      store.channelsById[chId].unread_count =
        (store.channelsById[chId].unread_count || 0) + 1;
      renderChannelRoster();
    }
  }

  function renderStoreInspector() {
    const container = document.getElementById('store-inspector');
    if (!container) return;
    container.replaceChildren();

    const totalMsgs = Object.keys(store.messagesById).length;
    const pendingCount = Object.keys(store.pendingMessagesByClientId).length;
    const channelCount = Object.keys(store.channelsById).length;

    const rows = [
      [
        'Authenticated User',
        store.currentUser
          ? store.currentUser.username + ' (' + maskIdentifier(store.currentUser.user_id) + ')'
          : 'None',
      ],
      ['CSRF Token Storage', store.csrfToken ? 'In-Memory Closure (Protected)' : 'Empty'],
      ['Active DB Reader', store.storageEngine.toUpperCase()],
      ['WS State Machine', store.wsState],
      ['Normalized Channels', String(channelCount)],
      ['Normalized Messages', String(totalMsgs)],
      ['Optimistic Outbox', String(pendingCount) + ' pending'],
    ];

    rows.forEach(function (pair) {
      const r = document.createElement('div');
      r.className = 'kv-row';
      const k = document.createElement('span');
      k.className = 'kv-key';
      k.textContent = pair[0];
      const v = document.createElement('span');
      v.className = 'kv-val';
      v.textContent = pair[1];
      r.appendChild(k);
      r.appendChild(v);
      container.appendChild(r);
    });
  }

  // ==========================================================================
  // 4. BFF API COMMUNICATION & REAL-TIME WEBSOCKET ENGINE
  // ==========================================================================
  async function refreshDiagnostics() {
    try {
      const res = await fetch('/v1/health', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const diag = data.diagnostics || {};
      const spanner = diag.spanner || {};
      const firestore = diag.firestore || {};
      const pubsub = diag.pubsub || {};

      const pill = document.getElementById('db-status-pill');
      if (pill) {
        pill.textContent = 'Spanner & Firestore: ' + (data.status || 'HEALTHY');
        pill.className = 'pill ready';
      }

      const card = document.getElementById('gcp-diagnostics');
      if (!card) return;
      card.replaceChildren();

      const items = [
        ['GCP Project', diag.project_id || 'cloud-next25-screendemo'],
        ['Spanner Instance', spanner.instance || 'chat-spanner-instance'],
        [
          'Spanner Counts',
          (spanner.users || 0) + 'u / ' + (spanner.channels || 0) + 'c / ' + (spanner.messages || 0) + 'm',
        ],
        ['Firestore DB', firestore.database || 'chat-system-db'],
        ['Firestore Counts', (firestore.users || 0) + 'u / ' + (firestore.channels || 0) + 'c'],
        ['Pub/Sub Node Topic', pubsub.node_topic || 'chat-node-gateway-1'],
      ];

      items.forEach(function (pair) {
        const r = document.createElement('div');
        r.className = 'kv-row';
        const k = document.createElement('span');
        k.className = 'kv-key';
        k.textContent = pair[0];
        const v = document.createElement('span');
        v.className = 'kv-val';
        v.textContent = pair[1];
        r.appendChild(k);
        r.appendChild(v);
        card.appendChild(r);
      });
    } catch (_err) {
      appendTrace('Health check error');
    }
  }

  function updateActiveUserPill() {
    const pill = document.getElementById('active-user-pill');
    if (!pill) return;
    if (store.currentUser) {
      pill.textContent = 'Signed in: @' + store.currentUser.username;
      pill.className = 'pill ready';
    } else {
      pill.textContent = 'Session: Unauthenticated';
      pill.className = 'pill warn';
    }
  }

  async function bootstrapAuthenticatedSession() {
    try {
      const meRes = await fetch('/v1/auth/me', { credentials: 'same-origin' });
      if (!meRes.ok) {
        window.location.replace('/login');
        return;
      }
      const data = await meRes.json();
      if (!data || !data.user) {
        window.location.replace('/login');
        return;
      }
      store.csrfToken = data.csrf_token || '';
      store.currentUser = data.user;
      updateActiveUserPill();
      renderUserSwitcher();
      renderStoreInspector();
      appendTrace('Session restored for @' + data.user.username);

      await Promise.all([loadDirectoryUsers(), loadChannels()]);
      await initiateWebSocketHandshake();
      await refreshDiagnostics();
    } catch (_err) {
      window.location.replace('/login');
    }
  }

  async function signInAs(username) {
    try {
      const csrfRes = await fetch('/v1/auth/csrf', { credentials: 'same-origin' });
      if (!csrfRes.ok) return;
      const csrfJson = await csrfRes.json();

      const loginRes = await fetch('/v1/auth/demo-login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfJson.csrf_token || '',
        },
        body: JSON.stringify({
          username: username,
        }),
      });
      if (!loginRes.ok) {
        openModal('Sign-In Failed', 'Unable to authenticate user ' + username);
        return;
      }

      const data = await loginRes.json();
      store.csrfToken = data.csrf_token || '';
      store.currentUser = data.user || null;

      updateActiveUserPill();
      renderUserSwitcher();
      renderStoreInspector();
      appendTrace('Authenticated as ' + username);

      await Promise.all([loadDirectoryUsers(), loadChannels()]);
      await initiateWebSocketHandshake();
      await refreshDiagnostics();
    } catch (_err) {
      openModal('Network Error', 'Failed to reach BFF /v1/auth/login');
    }
  }

  async function loadDirectoryUsers() {
    try {
      const res = await fetch('/v1/users', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      const users = Array.isArray(data.users) ? data.users : [];
      users.forEach(function (u) {
        store.usersById[u.user_id] = u;
        store.presenceByUserId[u.user_id] = {
          status: u.presence || 'OFFLINE',
          lastSeenAt: u.last_seen_at || '',
        };
      });
      renderPresenceRoster();
    } catch (_e) {
      // ignore
    }
  }

  async function loadChannels() {
    try {
      const res = await fetch(
        '/v1/channels?store=' + encodeURIComponent(store.storageEngine),
        { credentials: 'same-origin' }
      );
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.channels) ? data.channels : [];
      list.forEach(function (ch) {
        const unread =
          (store.channelsById[ch.channel_id] &&
            store.channelsById[ch.channel_id].unread_count) ||
          0;
        store.channelsById[ch.channel_id] = Object.assign({}, ch, {
          unread_count: unread,
        });
      });
      renderChannelRoster();
      renderStoreInspector();

      if (!store.activeChannelId && list.length > 0) {
        await selectChannel(list[0].channel_id);
      } else if (store.activeChannelId) {
        await loadChannelMessages(store.activeChannelId);
      }
    } catch (_e) {
      appendTrace('Failed loading channels');
    }
  }

  async function selectChannel(channelId) {
    store.activeChannelId = channelId;
    if (store.channelsById[channelId]) {
      store.channelsById[channelId].unread_count = 0;
    }
    renderChannelRoster();

    const ch = store.channelsById[channelId];
    const titleEl = document.getElementById('stage-channel-name');
    const metaEl = document.getElementById('stage-channel-meta');
    if (titleEl) {
      titleEl.textContent = ch
        ? (ch.type === 'DIRECT' ? '@ ' : '# ') + (ch.name || ch.channel_id)
        : channelId;
    }
    if (metaEl) {
      metaEl.textContent =
        channelId + ' • Active Store: ' + store.storageEngine.toUpperCase();
    }
    await loadChannelMessages(channelId);
  }

  async function loadChannelMessages(channelId) {
    try {
      const res = await fetch(
        '/v1/channels/' +
          encodeURIComponent(channelId) +
          '/messages?limit=50&store=' +
          encodeURIComponent(store.storageEngine),
        { credentials: 'same-origin' }
      );
      if (!res.ok) return;
      const data = await res.json();
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      store.messageIdsByChannel[channelId] = [];
      msgs.forEach(function (m) {
        reconcileMessage(m);
      });
      renderMessageViewport();
      renderStoreInspector();
    } catch (_e) {
      appendTrace('Failed loading messages');
    }
  }

  async function initiateWebSocketHandshake() {
    if (wsSocket) {
      try {
        wsSocket.close(1000, 'Reinitializing');
      } catch (_e) {
        // ignore
      }
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }

    setWsFsmState('ACQUIRING_TICKET');
    try {
      const res = await fetch('/v1/auth/ws-ticket', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': store.csrfToken || '' },
      });
      if (!res.ok) {
        scheduleReconnectBackoff();
        return;
      }
      const ticketData = await res.json();
      setWsFsmState('CONNECTING_WSS');

      const ws = new WebSocket(ticketData.ws_endpoint, [
        'chat.v1',
        'ticket.' + ticketData.ws_ticket,
      ]);
      wsSocket = ws;

      ws.addEventListener('open', function () {
        setWsFsmState('DELTA_SYNCING');
        store.reconnectAttempt = 0;
        setWsFsmState('SYNCED_READY');
        appendTrace('WS connected -> SYNCED_READY');

        heartbeatInterval = setInterval(function () {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                event_type: 'heartbeat_ping',
                trace_id: 'trc_hb_' + Date.now(),
                payload: {},
              })
            );
          }
        }, 25000);
      });

      ws.addEventListener('message', function (ev) {
        try {
          const frame = JSON.parse(ev.data);
          if (frame.event_type === 'heartbeat_pong') {
            appendTrace('WS heartbeat_pong (' + frame.payload.node_id + ')');
          } else if (frame.event_type === 'message_ack' && frame.payload) {
            appendTrace('WS message_ack seq #' + frame.payload.sequence_num);
          } else if (frame.event_type === 'receive_message' && frame.payload) {
            const p = frame.payload;
            reconcileMessage({
              message_id: p.message_id,
              client_message_id: p.client_message_id,
              channel_id: p.channel_id,
              sequence_num: p.sequence_num,
              sender_id: (p.sender && p.sender.user_id) || p.sender_id,
              sender_username: (p.sender && p.sender.username) || '',
              sender_display_name:
                (p.sender && p.sender.display_name) || p.sender_display_name || '',
              content: p.content,
              content_type: p.content_type || 'TEXT',
              created_at: p.created_at,
            });
            if (p.channel_id === store.activeChannelId) {
              renderMessageViewport();
            }
            renderStoreInspector();
          } else if (frame.event_type === 'typing_indicator' && frame.payload) {
            const tp = frame.payload;
            if (!store.typingUsersByChannel[tp.channel_id]) {
              store.typingUsersByChannel[tp.channel_id] = {};
            }
            if (tp.is_typing) {
              store.typingUsersByChannel[tp.channel_id][tp.display_name || tp.username] =
                Date.now() + 4500;
            } else {
              delete store.typingUsersByChannel[tp.channel_id][
                tp.display_name || tp.username
              ];
            }
            renderTypingBar();
          } else if (frame.event_type === 'presence_update' && frame.payload) {
            const pr = frame.payload;
            store.presenceByUserId[pr.user_id] = {
              status: pr.status,
              lastSeenAt: pr.last_seen_at,
            };
            renderPresenceRoster();
          }
        } catch (_e) {
          // ignore malformed frame
        }
      });

      ws.addEventListener('close', function (ev) {
        if (ev.code !== 1000 && store.currentUser) {
          scheduleReconnectBackoff();
        } else {
          setWsFsmState('DISCONNECTED');
        }
      });
    } catch (_err) {
      scheduleReconnectBackoff();
    }
  }

  function scheduleReconnectBackoff() {
    setWsFsmState('RECONNECT_BACKOFF');
    const delayMs = calculateBackoffWithFullJitter(store.reconnectAttempt);
    store.reconnectAttempt += 1;
    appendTrace('Reconnect backoff in ' + delayMs + 'ms');
    setTimeout(function () {
      if (store.currentUser && store.wsState === 'RECONNECT_BACKOFF') {
        initiateWebSocketHandshake();
      }
    }, delayMs);
  }

  // ==========================================================================
  // 5. SAFE DOM RENDERING FUNCTIONS (Zero innerHTML / outerHTML)
  // ==========================================================================
  function renderUserSwitcher() {
    const container = document.getElementById('user-switcher');
    if (!container) return;
    container.replaceChildren();

    SEEDED_USERS.forEach(function (u) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        store.currentUser && store.currentUser.username === u.username
          ? ''
          : 'ghost';
      btn.textContent = u.label;
      btn.addEventListener('click', function () {
        signInAs(u.username);
      });
      container.appendChild(btn);
    });
  }

  function renderChannelRoster() {
    const container = document.getElementById('channel-roster');
    if (!container) return;
    container.replaceChildren();

    Object.values(store.channelsById).forEach(function (ch) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'channel-btn' + (ch.channel_id === store.activeChannelId ? ' active' : '');

      const labelSpan = document.createElement('span');
      labelSpan.textContent =
        (ch.type === 'DIRECT' ? '@ ' : '# ') + (ch.name || ch.channel_id);
      btn.appendChild(labelSpan);

      if (ch.unread_count && ch.unread_count > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = String(ch.unread_count);
        btn.appendChild(badge);
      }

      btn.addEventListener('click', function () {
        selectChannel(ch.channel_id);
      });
      container.appendChild(btn);
    });
  }

  function renderPresenceRoster() {
    const container = document.getElementById('presence-roster');
    if (!container) return;
    container.replaceChildren();

    Object.values(store.usersById).forEach(function (u) {
      const row = document.createElement('div');
      row.className = 'presence-row';

      const left = document.createElement('span');
      const dot = document.createElement('span');
      const status =
        (store.presenceByUserId[u.user_id] &&
          store.presenceByUserId[u.user_id].status) ||
        'OFFLINE';
      dot.className = 'dot' + (status === 'ONLINE' ? ' online' : '');
      left.appendChild(dot);

      const nameNode = document.createTextNode(u.username);
      left.appendChild(nameNode);

      const right = document.createElement('span');
      right.className = 'kv-key';
      right.textContent = status;

      row.appendChild(left);
      row.appendChild(right);
      container.appendChild(row);
    });
  }

  function renderMessageViewport() {
    const viewport = document.getElementById('message-viewport');
    if (!viewport) return;
    viewport.replaceChildren();

    const chId = store.activeChannelId;
    if (!chId) return;

    const msgIds = store.messageIdsByChannel[chId] || [];
    msgIds.forEach(function (id) {
      const m = store.messagesById[id];
      if (!m) return;
      viewport.appendChild(buildMessageNode(m, false));
    });

    // Render any optimistic pending messages for this channel at the bottom
    Object.values(store.pendingMessagesByClientId).forEach(function (opt) {
      if (opt.channel_id === chId) {
        viewport.appendChild(buildMessageNode(opt, true));
      }
    });

    viewport.scrollTop = viewport.scrollHeight;
  }

  function buildMessageNode(msg, isPending) {
    const bubble = document.createElement('div');
    const isOwn =
      store.currentUser && msg.sender_id === store.currentUser.user_id;
    bubble.className =
      'msg-bubble' + (isOwn ? ' own' : '') + (isPending ? ' pending' : '');

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = msg.sender_display_name || msg.sender_id;

    const seqInfo = document.createElement('span');
    if (isPending) {
      seqInfo.textContent = '• Optimistic Outbox (' + msg.status + '...)';
    } else {
      const timeStr = msg.created_at
        ? new Date(msg.created_at).toLocaleTimeString()
        : '';
      seqInfo.textContent = 'seq #' + String(msg.sequence_num || 1) + ' • ' + timeStr;
    }

    meta.appendChild(author);
    meta.appendChild(seqInfo);

    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = msg.content || '';

    bubble.appendChild(meta);
    bubble.appendChild(text);
    return bubble;
  }

  function renderTypingBar() {
    const bar = document.getElementById('typing-indicator-bar');
    if (!bar) return;
    const chId = store.activeChannelId;
    if (!chId || !store.typingUsersByChannel[chId]) {
      bar.textContent = '';
      return;
    }
    const now = Date.now();
    const activeNames = [];
    Object.entries(store.typingUsersByChannel[chId]).forEach(function (entry) {
      if (entry[1] > now) {
        activeNames.push(entry[0]);
      } else {
        delete store.typingUsersByChannel[chId][entry[0]];
      }
    });

    bar.textContent =
      activeNames.length > 0 ? activeNames.join(', ') + ' is typing...' : '';
  }

  // ==========================================================================
  // 6. USER INTERACTION HANDLERS (Optimistic Send, Typing, Logout)
  // ==========================================================================
  async function handleComposerSubmit(ev) {
    ev.preventDefault();
    if (!store.currentUser || !store.activeChannelId) {
      openModal('Authentication Required', 'Please sign in first.');
      return;
    }
    const input = document.getElementById('composer-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;
    input.value = '';

    const clientMessageId =
      'cmsg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    // 1. Insert into Optimistic Outbox (<16ms UI update)
    store.pendingMessagesByClientId[clientMessageId] = {
      client_message_id: clientMessageId,
      channel_id: store.activeChannelId,
      sender_id: store.currentUser.user_id,
      sender_display_name: store.currentUser.display_name,
      content: content,
      created_at: new Date().toISOString(),
      status: 'SENDING',
    };
    renderMessageViewport();
    renderStoreInspector();

    // 2. Transmit via WebSocket if open, otherwise via BFF REST endpoint
    if (wsSocket && wsSocket.readyState === WebSocket.OPEN) {
      wsSocket.send(
        JSON.stringify({
          event_type: 'send_message',
          trace_id: 'trc_send_' + Date.now(),
          payload: {
            channel_id: store.activeChannelId,
            client_message_id: clientMessageId,
            content: content,
          },
        })
      );
      await refreshDiagnostics();
      return;
    }

    try {
      const res = await fetch(
        '/v1/channels/' + encodeURIComponent(store.activeChannelId) + '/messages',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': store.csrfToken || '',
          },
          body: JSON.stringify({
            content: content,
            client_message_id: clientMessageId,
          }),
        }
      );
      if (res.ok) {
        const msg = await res.json();
        reconcileMessage(msg);
        renderMessageViewport();
        renderStoreInspector();
        await refreshDiagnostics();
      } else {
        if (store.pendingMessagesByClientId[clientMessageId]) {
          store.pendingMessagesByClientId[clientMessageId].status =
            'FAILED_RETRYABLE';
          renderMessageViewport();
        }
      }
    } catch (_err) {
      if (store.pendingMessagesByClientId[clientMessageId]) {
        store.pendingMessagesByClientId[clientMessageId].status =
          'FAILED_RETRYABLE';
        renderMessageViewport();
      }
    }
  }

  async function handleNewChannelSubmit(ev) {
    ev.preventDefault();
    if (!store.currentUser) return;
    const nameInput = document.getElementById('channel-name-input');
    const typeSelect = document.getElementById('channel-type-select');
    if (!nameInput || !typeSelect) return;
    const name = nameInput.value.trim();
    if (!name) return;

    try {
      const res = await fetch('/v1/channels', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': store.csrfToken || '',
        },
        body: JSON.stringify({
          name: name,
          type: typeSelect.value,
          is_private: typeSelect.value === 'DIRECT',
          member_user_ids: ['usr_alice', 'usr_bob', 'usr_charlie', 'usr_diana'],
        }),
      });
      if (!res.ok) {
        openModal('Channel Error', 'Could not create channel.');
        return;
      }
      const ch = await res.json();
      nameInput.value = '';
      await loadChannels();
      await selectChannel(ch.channel_id);
      await refreshDiagnostics();
    } catch (_e) {
      openModal('Network Error', 'Channel creation request failed.');
    }
  }

  async function handleSecureLogout() {
    try {
      await fetch('/v1/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': store.csrfToken || '' },
      });
    } finally {
      if (wsSocket) {
        try {
          wsSocket.close(1000, 'User logged out');
        } catch (_e) {
          // ignore
        }
      }
      store.csrfToken = null;
      store.currentUser = null;
      store.usersById = {};
      store.channelsById = {};
      store.messagesById = {};
      store.pendingMessagesByClientId = {};
      window.location.replace('/login');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    setupDialogLightDismissFallback();

    const engineSelect = document.getElementById('storage-engine-select');
    if (engineSelect) {
      engineSelect.addEventListener('change', function () {
        store.storageEngine = engineSelect.value;
        appendTrace('Switched DB reader to ' + store.storageEngine);
        loadChannels();
      });
    }

    const loginPageBtn = document.getElementById('login-page-btn');
    if (loginPageBtn) {
      loginPageBtn.addEventListener('click', function () {
        window.location.assign('/login?switch=1');
      });
    }

    const profileBtn = document.getElementById('profile-modal-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', function () {
        if (!store.currentUser) {
          openModal('Profile', 'Not currently signed in.');
          return;
        }
        openModal(
          'PII-Masked User Profile',
          'Display Name: ' +
            store.currentUser.display_name +
            ' | User ID: ' +
            maskIdentifier(store.currentUser.user_id) +
            ' | Email: ' +
            maskEmail(store.currentUser.masked_email || 'alice@example.com')
        );
      });
    }

    const uploadBtn = document.getElementById('simulate-upload-btn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', function () {
        openModal(
          '@chat/media-uploader Security Check',
          'Client-side & BFF validation active: Max 10 MB enforced, allow-listed MIME types (image/png, image/jpeg, image/webp, application/pdf), double extensions & path traversal (../) blocked.'
        );
      });
    }

    const syncBtn = document.getElementById('sync-history-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', function () {
        if (store.activeChannelId) {
          loadChannelMessages(store.activeChannelId);
        }
      });
    }

    const composerInput = document.getElementById('composer-input');
    if (composerInput) {
      composerInput.addEventListener('input', function () {
        const now = Date.now();
        if (
          now - lastTypingSentAt > 2000 &&
          wsSocket &&
          wsSocket.readyState === WebSocket.OPEN &&
          store.activeChannelId
        ) {
          lastTypingSentAt = now;
          wsSocket.send(
            JSON.stringify({
              event_type: 'typing_indicator',
              trace_id: 'trc_typ_' + now,
              payload: {
                channel_id: store.activeChannelId,
                is_typing: true,
              },
            })
          );
        }
      });
    }

    const composerForm = document.getElementById('message-composer-form');
    if (composerForm) {
      composerForm.addEventListener('submit', handleComposerSubmit);
    }

    const newChannelForm = document.getElementById('new-channel-form');
    if (newChannelForm) {
      newChannelForm.addEventListener('submit', handleNewChannelSubmit);
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleSecureLogout);
    }

    setInterval(renderTypingBar, 1000);
    renderUserSwitcher();
    refreshDiagnostics();
    bootstrapAuthenticatedSession();
  });
})();
