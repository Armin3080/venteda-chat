/**
 * VENTEDA CHAT — Master Application Client
 * Real-time messaging, WebSockets, WebRTC calling, voice notes, and UI coordinator.
 */

import { api } from './api.js';
import { icons } from './icons.js';
import { VoiceRecorder } from './voiceRecorder.js';
import { WebRTCCallManager } from './webrtc.js';
import { GroupCallManager } from './groupCall.js';

// The whole app is dark. Set to false to allow the light theme again.
const FORCE_DARK = true;

window.icons = icons;

class VentedaApp {
  constructor() {
    this.currentUser = null;
    this.userSettings = {
      theme: 'dark',
      language: 'en',
      notifications_enabled: true,
      sound_enabled: true,
      enter_is_send: true,
      accent_color: '#2685F6',
      wallpaper: 'mesh',
      compact_mode: false,
    };
    this.conversations = [];
    this.selectedConvId = null;
    this.messages = [];
    this.typingTimer = null;
    this.activeTypingUsers = {}; // convId -> { userId, name }

    this.ws = null;
    this.wsReconnectTimeout = null;
    this.wsReconnectAttempts = 0;

    // Replying / Editing / Forwarding state
    this.replyingTo = null;
    this.editingMessage = null;
    this.forwardingMessage = null;

    // Search state
    this.inChatSearchOpen = false;
    this.inChatSearchQuery = '';

    // Mobile navigation state
    this.mobileView = 'sidebar'; // 'sidebar' or 'chat'

    // Voice recorder instance
    this.voiceRecorder = new VoiceRecorder({
      onStateChange: (state) => this.handleVoiceStateChange(state),
      onTimeUpdate: (sec, formatted) => this.handleVoiceTimeUpdate(sec, formatted),
      onWaveform: (bands) => this.handleVoiceWaveform(bands),
    });

    // WebRTC Call Manager instance
    this.callManager = new WebRTCCallManager({
      sendSignal: (sig) => this.sendWebSocket(sig),
      onCallStateChange: (state, callData) => this.handleCallStateChange(state, callData),
      onRemoteStream: (stream) => this.handleRemoteStream(stream),
      onLocalStream: (stream) => this.handleLocalStream(stream),
      onCallDuration: (durStr) => this.handleCallDuration(durStr),
    });

    // Group calls (mesh). Tiles and controls are wired in the group call section below.
    this.groupCall = new GroupCallManager({
      sendSignal: (sig) => this.sendWebSocket(sig),
      getIceServers: () => this.callManager.iceServers,
      onLocalStream: (stream) => this.renderGroupTile('local', 'You', stream, true),
      onRemoteStream: (uid, name, stream) => this.renderGroupTile(uid, name, stream),
      onPeerLeft: (uid) => this.removeGroupTile(uid),
      onInvite: (info) => this.showGroupInvite(info),
      onStateChange: (state, info) => this.handleGroupCallState(state, info),
      onEnded: () => this.hideGroupCallOverlay(),
    });
    this.pendingGroupInvite = null;
    this.contactSettings = new Map();   // userId -> my settings for that user

    // Currently playing voice note audio element
    this.currentAudioPlayer = null;
  }

  async init() {
    this.setupTheme();
    this.bindEvents();

    const storedUser = api.getStoredUser();
    const token = api.getToken();

    if (token && storedUser) {
      try {
        this.currentUser = await api.getMe();
        try {
          const s = await api.getSettings();
          this.userSettings = { ...this.userSettings, ...s };
          this.applySettings();
        } catch {}

        this.showMainView();
        await this.loadConversations();
        this.connectWebSocket();
        this.initWebRTCConfig();
      } catch (err) {
        console.warn('Saved session invalid, showing auth view:', err);
        this.showAuthView();
      }
    } else {
      this.showAuthView();
    }
  }

  // -------------------------------------------------------------
  // Theme & Direction Setup
  // -------------------------------------------------------------
  setupTheme() {
    const savedTheme = localStorage.getItem('venteda_theme') || 'dark';
    const savedLang = localStorage.getItem('venteda_lang') || 'en';
    const savedAccent = localStorage.getItem('venteda_accent') || '#2685F6';

    this.userSettings.theme = savedTheme;
    this.userSettings.language = savedLang;
    this.userSettings.accent_color = savedAccent;

    this.applySettings();
  }

  applySettings() {
    const root = document.documentElement;
    const isDark = FORCE_DARK ||
      this.userSettings.theme === 'dark' ||
      (this.userSettings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
      root.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
    } else {
      root.classList.remove('dark');
      root.removeAttribute('data-theme');
    }

    root.setAttribute('dir', false ? 'rtl' : 'ltr');
    root.style.setProperty('--accent-blue', this.userSettings.accent_color || '#2685F6');

    // Update wallpaper class on chat container
    const canvas = document.getElementById('chatMessagesScroll');
    if (canvas) {
      canvas.className = `flex-1 overflow-y-auto px-4 py-4 space-y-3.5 chat-canvas-bg wallpaper-${this.userSettings.wallpaper || 'mesh'}`;
    }

    // Update Saved Messages Card text in sidebar
    const savedLabel = document.getElementById('savedMessagesLabelText');
    const savedSub = document.getElementById('savedMessagesSubText');
    if (savedLabel) {
      savedLabel.textContent = false ? 'پیام‌های ذخیره‌شده' : 'Saved Messages';
    }
    if (savedSub) {
      savedSub.textContent = false ? 'فضای ابری و یادداشت‌های شخصی' : 'Your Cloud Notebook';
    }

    localStorage.setItem('venteda_theme', this.userSettings.theme);
    localStorage.setItem('venteda_lang', this.userSettings.language);
    localStorage.setItem('venteda_accent', this.userSettings.accent_color || '#2685F6');
  }

  toggleTheme() {
    this.setThemeMode(this.userSettings.theme === 'dark' ? 'light' : 'dark');
  }

  setThemeMode(theme) {
    if (FORCE_DARK) theme = 'dark';
    this.userSettings.theme = theme;
    this.applySettings();
    this.updateThemeButtonsUI();
    api.updateSettings({ theme: this.userSettings.theme }).catch(() => {});
  }

  updateThemeButtonsUI() {
    const currentTheme = this.userSettings.theme || 'dark';
    const btns = {
      light: document.getElementById('themeBtnLight'),
      dark: document.getElementById('themeBtnDark'),
      system: document.getElementById('themeBtnSystem')
    };

    Object.entries(btns).forEach(([key, btn]) => {
      if (!btn) return;
      if (key === currentTheme) {
        btn.className = 'theme-choice-btn p-3 rounded-xl border-2 border-blue-600 bg-blue-50/80 dark:bg-blue-950/60 flex flex-col items-center gap-1.5 text-center shadow-xs cursor-pointer ring-2 ring-blue-500/20';
      } else {
        btn.className = 'theme-choice-btn p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#152338] hover:border-slate-400 flex flex-col items-center gap-1.5 text-center transition-all cursor-pointer';
      }
    });
  }

  toggleLanguage() {
    this.userSettings.language = 'en';
    this.applySettings();
    api.updateSettings({ language: this.userSettings.language }).catch(() => {});
    this.renderUI();
  }

  renderUI() {
    this.renderConversationList();
    if (this.selectedConvId) {
      this.renderChatHeader();
      this.renderMessages();
      this.renderPinnedMessageBanner();
    }
    this.renderUserProfileHeader();
  }

  async openSavedMessages() {
    try {
      const saved = await api.getSavedConversation();
      const existingIdx = this.conversations.findIndex(c => c.id === saved.id || c.type === 'saved');
      if (existingIdx >= 0) {
        this.conversations[existingIdx] = { ...this.conversations[existingIdx], ...saved };
      } else {
        this.conversations.unshift(saved);
      }
      this.renderConversationList();
      await this.selectConversation(saved.id);
    } catch (err) {
      console.error('Failed to open saved messages:', err);
      this.showToast('Could not open Saved Messages: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // Views Switching
  // -------------------------------------------------------------
  showAuthView() {
    document.getElementById('authView').classList.remove('hidden');
    document.getElementById('mainView').classList.add('hidden');
  }

  showMainView() {
    document.getElementById('authView').classList.add('hidden');
    document.getElementById('mainView').classList.remove('hidden');
    this.renderUserProfileHeader();
    this.renderAdminNavButton();
  }

  // -------------------------------------------------------------
  // WebSocket Connection
  // -------------------------------------------------------------
  connectWebSocket() {
    const token = api.getToken();
    if (!token) return;

    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.wsReconnectAttempts = 0;
        this.updateConnectionBadge('connected');
        // Heartbeat ping
        this.pingInterval = setInterval(() => {
          this.sendWebSocket({ action: 'ping' });
        }, 30000);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleWebSocketEvent(msg);
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };

      this.ws.onclose = (event) => {
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.updateConnectionBadge('connecting');
        if (event.code !== 1008) {
          // Reconnect with backoff
          const delay = Math.min(1000 * Math.pow(1.5, this.wsReconnectAttempts), 15000);
          this.wsReconnectAttempts += 1;
          this.wsReconnectTimeout = setTimeout(() => this.connectWebSocket(), delay);
        }
      };

      this.ws.onerror = () => {
        this.updateConnectionBadge('disconnected');
      };
    } catch (e) {
      console.warn('WS connection exception:', e);
    }
  }

  sendWebSocket(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  handleWebSocketEvent(msg) {
    const { event, data } = msg;

    if (event === 'pong') {
      return;
    }

    if (event === 'new_message') {
      const message = data;
      if (message.conversation_id === this.selectedConvId) {
        if (!this.messages.some(m => m.id === message.id)) {
          this.messages.push(message);
          this.renderMessages();
          this.scrollToBottom();
          this.maybeMarkRead();
        }
      }
      this.updateConversationLastMessage(message);
      const isMine = message.sender_id === this.currentUser?.id;
      if (!isMine && message.conversation_id !== this.selectedConvId) {
        this.bumpUnread(message.conversation_id);
        this.notifyIncoming(message);
      }
      if (!this.contactSettings.get(message.sender_id)?.notifications_muted && !isMine) this.playNotificationSound();
    } else if (event === 'message_edited') {
      const message = data;
      if (message.conversation_id === this.selectedConvId) {
        this.messages = this.messages.map(m => m.id === message.id ? message : m);
        this.renderMessages();
      }
    } else if (event === 'message_deleted') {
      const { message_id, conversation_id } = data;
      if (conversation_id === this.selectedConvId) {
        this.messages = this.messages.filter(m => m.id !== message_id);
        this.renderMessages();
      }
    } else if (event === 'reaction_updated') {
      const { message_id, conversation_id, reactions } = data;
      if (conversation_id === this.selectedConvId) {
        this.messages = this.messages.map(m => m.id === message_id ? { ...m, reactions } : m);
        this.renderMessages();
      }
    } else if (event === 'message_pinned') {
      const { conversation_id, pinned_message_id, pinned_message } = data;
      const conv = this.conversations.find(c => c.id === conversation_id);
      if (conv) {
        conv.pinned_message_id = pinned_message_id;
        conv.pinned_message = pinned_message;
      }
      if (conversation_id === this.selectedConvId) {
        this.renderPinnedMessageBanner();
      }
    } else if (event === 'message_read') {
      const { conversation_id, last_read_message_id } = data;
      // My own read receipts must not mark my messages as seen by the other side
      if (data.user_id === this.currentUser?.id) return;
      if (conversation_id === this.selectedConvId) {
        // Only messages up to the reader's pointer are seen
        const pointerIdx = this.messages.findIndex(m => m.id === last_read_message_id);
        this.messages.forEach((m, i) => {
          if (pointerIdx >= 0 && i <= pointerIdx) m.is_read_by_recipient = true;
        });
        this.renderMessages();
      }
    } else if (event === 'user_typing') {
      const { conversation_id, user_id, display_name, is_typing } = data;
      if (conversation_id === this.selectedConvId) {
        const el = document.getElementById('typingIndicator');
        if (el) {
          if (is_typing) {
            el.textContent = `${display_name} is typing...`;
            el.classList.remove('hidden');
          } else {
            el.classList.add('hidden');
          }
        }
      }
    } else if (event === 'conversation_updated') {
      this.loadConversations().catch(() => {});
    } else if (event === 'story_update') {
      this.renderStoriesBar().catch(() => {});
    } else if (event === 'presence') {
      this.applyPresence(data.user_id, !!data.is_online, data.last_seen);
    } else if (event === 'system_announcement') {
      this.showAnnouncementToast(data.text, data.sender);
    } else if (event === 'call_error') {
      this.groupCall.handleServerError();
      alert(data?.message || 'Call error.');
    } else if (event && event.startsWith('group_call_')) {
      this.groupCall.handleEvent(event, data);
    } else if (event && event.startsWith('call_') || event === 'incoming_call' || event === 'ice_candidate') {
      // Delegate WebRTC signaling to CallManager
      this.callManager.handleSignalingEvent(event, data);
    }
  }

  updateConnectionBadge(state) {
    const el = document.getElementById('connStatusBadge');
    if (!el) return;
    if (state === 'connected') {
      el.className = 'w-2 h-2 rounded-full bg-emerald-500';
      el.title = 'Connected';
    } else if (state === 'connecting') {
      el.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      el.title = 'Reconnecting...';
    } else {
      el.className = 'w-2 h-2 rounded-full bg-rose-500';
      el.title = 'Disconnected';
    }
  }

  playNotificationSound() {
    if (!this.userSettings.sound_enabled || this.prefs().receiveSound === false || this.prefs().muteAll) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
      gain.gain.setValueAtTime(0.04 * this.volume(), ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {}
  }

  showAnnouncementToast(text, sender) {
    const banner = document.getElementById('announcementBanner');
    if (!banner) return;
    banner.innerHTML = `
      <div class="px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 text-white text-xs font-semibold flex items-center justify-between shadow-md">
        <div class="flex items-center gap-2">
          <span class="inline-flex shrink-0">${icons.shield('w-4 h-4 text-white')}</span>
          <span><strong>${sender}:</strong> ${this.escapeHtml(text)}</span>
        </div>
        <button onclick="this.parentElement.remove()" class="p-1 hover:opacity-80 cursor-pointer">${icons.close('w-3.5 h-3.5')}</button>
      </div>
    `;
  }

  // -------------------------------------------------------------
  // Data Loading & Rendering
  // -------------------------------------------------------------
  async loadConversations() {
    this.loadContactSettings().catch(() => {});
    this.renderStoriesBar().catch(() => {});
    try {
      this.conversations = await api.getConversations();
      this.renderConversationList();

      if (this.conversations.length > 0 && !this.selectedConvId) {
        this.selectConversation(this.conversations[0].id);
      }
    } catch (e) {
      console.error('Failed to load conversations:', e);
    }
  }

  async selectConversation(convId) {
    this.selectedConvId = convId;
    this.replyingTo = null;
    this.editingMessage = null;
    this.inChatSearchOpen = false;

    // Mobile viewport switcher: move to chat view
    this.setMobileView('chat');

    this.renderConversationList();
    this.renderChatHeader();
    this.renderPinnedMessageBanner();

    try {
      this.messages = await api.getMessages(convId);
      this.renderMessages();
      this.scrollToBottom();
      this.maybeMarkRead(convId);
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  }

  setMobileView(view) {
    this.mobileView = view;
    const sidebar = document.getElementById('sidebarPanel');
    const chat = document.getElementById('chatAreaPanel');
    if (!sidebar || !chat) return;

    if (window.innerWidth < 768) {
      if (view === 'sidebar') {
        sidebar.classList.remove('hidden');
        sidebar.classList.add('flex');
        chat.classList.add('hidden');
        chat.classList.remove('flex');
      } else {
        sidebar.classList.add('hidden');
        sidebar.classList.remove('flex');
        chat.classList.remove('hidden');
        chat.classList.add('flex');
      }
    } else {
      sidebar.classList.remove('hidden');
      sidebar.classList.add('flex');
      chat.classList.remove('hidden');
      chat.classList.add('flex');
    }
  }

  renderConversationList() {
    const listEl = document.getElementById('conversationsList');
    if (!listEl) return;

    const query = (document.getElementById('convSearchInput')?.value || '').trim().toLowerCase();
    const activeTab = document.querySelector('.conv-filter-btn.active')?.dataset.filter || 'all';

    const filtered = this.conversations.filter(c => {
      if (activeTab === 'direct' && c.type !== 'direct') return false;
      if (activeTab === 'group' && c.type !== 'group') return false;
      if (activeTab === 'unread' && (c.unread_count || 0) === 0) return false;
      if (query) {
        const titleMatch = (c.title || '').toLowerCase().includes(query);
        const msgMatch = (c.last_message?.text || '').toLowerCase().includes(query);
        return titleMatch || msgMatch;
      }
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-12 px-4 text-slate-400 text-xs">
          <div class="w-12 h-12 mx-auto mb-3 rounded-2xl bg-blue-50 dark:bg-sky-950/60 text-blue-600 dark:text-cyan-400 flex items-center justify-center font-bold text-lg">
            ${icons.bookmark('w-6 h-6')}
          </div>
          <p class="font-bold text-slate-700 dark:text-slate-200">${false ? 'گفتگویی یافت نشد' : 'No conversations found'}</p>
          <p class="text-[11px] text-slate-400 mt-1">${false ? 'یک مخاطب جدید با نام کاربری و پین اضافه کنید' : 'Start a private contact with Username & Connect PIN'}</p>
          <button onclick="window.app.openNewChatModal()" class="mt-3 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-xs inline-flex items-center gap-1.5 cursor-pointer">
            ${icons.plus('w-3.5 h-3.5')}
            <span>${false ? 'مخاطب یا گروه جدید' : 'New Contact / Group'}</span>
          </button>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(conv => {
      const isSelected = conv.id === this.selectedConvId;
      const isSaved = conv.type === 'saved';
      const isGroup = conv.type === 'group';

      let convTitle = conv.title || 'Chat';
      if (conv.type === 'direct') convTitle = this.directTitle(conv) || convTitle;
      if (isSaved) {
        convTitle = false ? 'پیام‌های ذخیره‌شده' : 'Saved Messages';
      }

      let avatarHtml = '';
      if (isSaved) {
        avatarHtml = `
          <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-400 text-white flex items-center justify-center shadow-xs ring-1 ring-blue-500/20 shrink-0">
            ${icons.bookmark('w-5 h-5')}
          </div>
        `;
      } else if (isGroup) {
        avatarHtml = `
          <div class="w-11 h-11 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-500 text-white flex items-center justify-center shadow-xs ring-1 ring-indigo-500/20 shrink-0 overflow-hidden">
            ${conv.avatar_url ? `<img src="${conv.avatar_url}" class="w-full h-full object-cover" alt="" />` : icons.users('w-5 h-5')}
          </div>
        `;
      } else {
        const initial = (convTitle || 'U')[0].toUpperCase();
        let peerAvatar = null;
        if (conv.type === 'direct' && conv.members) {
          const peer = conv.members.find(m => m.user_id !== this.currentUser?.id);
          peerAvatar = peer?.user?.avatar_url;
        }
        if (peerAvatar) {
          avatarHtml = `
            <div class="w-11 h-11 rounded-2xl overflow-hidden shadow-xs ring-1 ring-blue-500/20 shrink-0 bg-slate-200 dark:bg-slate-800">
              <img src="${peerAvatar}" class="w-full h-full object-cover" alt="avatar" />
            </div>
            ${this.presenceDotHtml(conv)}
          `;
        } else {
          avatarHtml = `
            <div class="w-11 h-11 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center font-bold text-sm shadow-xs ring-1 ring-blue-500/20 shrink-0">
              ${initial}
            </div>
            ${this.presenceDotHtml(conv)}
          `;
        }
      }

      let lastMsgText = conv.last_message ? conv.last_message.text : '';
      if (!lastMsgText) {
        if (isSaved) {
          lastMsgText = false ? 'فضای ابری و یادداشت‌های شخصی' : 'Your personal cloud notebook';
        } else {
          lastMsgText = false ? 'پیامی وجود ندارد' : 'No messages yet';
        }
      }

      const timeStr = conv.updated_at ? this.formatTimeShort(conv.updated_at) : '';

      return `
        <div 
          onclick="window.app.selectConversation('${conv.id}')"
          class="relative flex items-center gap-3 p-2.5 rounded-2xl transition-all cursor-pointer ${
            isSelected
              ? 'bg-blue-50/90 dark:bg-[#16253d] border border-blue-200 dark:border-cyan-500/50 shadow-xs'
              : 'hover:bg-slate-100/70 dark:hover:bg-[#152236] border border-transparent'
          }"
        >
          <div class="relative shrink-0 cursor-pointer" onclick="event.stopPropagation(); window.app.openConversationProfile('${conv.id}')">
            ${avatarHtml}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-0.5">
              <span class="font-bold text-xs truncate text-slate-900 dark:text-white flex items-center gap-1.5">
                ${this.escapeHtml(convTitle)}
                ${isSaved ? `<span class="text-[9px] uppercase font-mono px-1.5 py-0.2 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-cyan-300 font-bold">${false ? 'ابری' : 'Cloud'}</span>` : ''}
              </span>
              <span class="text-[10px] font-mono text-slate-400 shrink-0 ml-1">${timeStr}</span>
            </div>
            <div class="flex items-center justify-between gap-1 text-xs text-slate-500 dark:text-slate-400">
              <p class="truncate text-[11px] max-w-[180px]">${this.escapeHtml(lastMsgText)}</p>
              <div class="flex items-center gap-1 shrink-0">
                ${conv.is_muted ? `<span class="text-slate-400 inline-flex">${icons.volumeX('w-3 h-3')}</span>` : ''}
                ${conv.pinned_message_id ? `<span class="text-blue-600 dark:text-cyan-400 inline-flex">${icons.pin('w-3 h-3')}</span>` : ''}
                ${(conv.unread_count || 0) > 0 ? `<span class="bg-blue-600 dark:bg-cyan-500 text-white dark:text-slate-950 font-bold text-[10px] px-1.5 py-0.2 rounded-full min-w-[16px] text-center">${conv.unread_count}</span>` : ''}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  updateConversationLastMessage(message) {
    const conv = this.conversations.find(c => c.id === message.conversation_id);
    if (conv) {
      conv.last_message = message;
      conv.updated_at = message.created_at;
      // Sort to top
      this.conversations = [conv, ...this.conversations.filter(c => c.id !== conv.id)];
      this.renderConversationList();
    }
  }

  // -------------------------------------------------------------
  // Presence (online / last seen)
  // -------------------------------------------------------------
  presenceLabel(user) {
    const fa = false;
    if (!user) return '';
    if (user.is_online) return fa ? 'آنلاین' : 'online';
    if (!user.last_seen) return fa ? 'آفلاین' : 'offline';
    const when = this.formatLastSeen(user.last_seen);
    return fa ? `آخرین بازدید ${when}` : `last seen ${when}`;
  }

  formatLastSeen(isoUtc) {
    // The server stores UTC without a timezone suffix. Add 'Z' so the browser shows local time.
    const raw = /Z$|[+-]\d\d:\d\d$/.test(isoUtc) ? isoUtc : `${isoUtc}Z`;
    const d = new Date(raw);
    if (isNaN(d)) return '';
    const fa = false;
    const locale = fa ? 'fa-IR' : 'en-US';
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) {
      return fa ? `امروز ساعت ${time}` : `today at ${time}`;
    }
    const date = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    return fa ? `${date} ساعت ${time}` : `${date} at ${time}`;
  }

  presenceDotHtml(conv) {
    if (!conv || conv.type !== 'direct' || !conv.members) return '';
    const peer = conv.members.find(m => m.user_id !== this.currentUser?.id);
    if (!peer || !peer.user) return '';
    const online = !!peer.user.is_online;
    const color = online ? 'bg-emerald-500' : 'bg-rose-500';
    const title = online ? 'Online' : 'Offline';
    return `<span title="${title}" class="absolute bottom-0 right-0 w-2.5 h-2.5 ${color} rounded-full border-2 border-white dark:border-[#111a28]"></span>`;
  }

  applyPresence(userId, isOnline, lastSeen) {
    let changed = false;
    this.conversations.forEach(conv => {
      (conv.members || []).forEach(m => {
        if (m.user_id === userId && m.user) {
          m.user.is_online = isOnline;
          if (lastSeen) m.user.last_seen = lastSeen;
          changed = true;
        }
      });
    });
    if (changed) {
      this.renderConversationList();
      this.renderChatHeader();
    }
  }

  renderChatHeader() {
    const conv = this.conversations.find(c => c.id === this.selectedConvId);
    if (!conv) return;

    const titleEl = document.getElementById('chatTitleHeader');
    const avatarEl = document.getElementById('chatAvatarInitial');
    const subEl = document.getElementById('chatSubtitle');
    const callBtns = document.getElementById('chatCallButtons');

    const isSaved = conv.type === 'saved';
    const isGroup = conv.type === 'group';

    if (isSaved) {
      if (titleEl) titleEl.textContent = false ? 'پیام‌های ذخیره‌شده' : (conv.title || 'Saved Messages');
      if (avatarEl) {
        avatarEl.innerHTML = icons.bookmark('w-5 h-5 text-white');
        avatarEl.className = 'w-10 h-10 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-400 flex items-center justify-center font-bold text-white text-sm shadow-xs ring-1 ring-blue-500/20';
      }
      if (subEl) subEl.textContent = false ? 'فضای ابری و یادداشت‌های شخصی شما' : 'Your personal cloud notebook and storage';
      if (callBtns) callBtns.classList.add('hidden');
    } else if (isGroup) {
      if (titleEl) titleEl.textContent = conv.title || 'Group';
      if (avatarEl) {
        avatarEl.innerHTML = conv.avatar_url ? `<img src="${conv.avatar_url}" class="w-full h-full object-cover rounded-full" alt="avatar" />` : icons.users('w-5 h-5 text-white');
        avatarEl.className = 'w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-500 flex items-center justify-center font-bold text-white text-sm shadow-xs ring-1 ring-indigo-500/20';
      }
      if (subEl) subEl.textContent = `${conv.members?.length || 2} members`;
      if (callBtns) callBtns.classList.remove('hidden');
    } else {
      if (titleEl) titleEl.textContent = this.directTitle(conv) || conv.title || 'Chat';
      let peerAvatar = null;
      if (conv.type === 'direct' && conv.members) {
        const peer = conv.members.find(m => m.user_id !== this.currentUser?.id);
        peerAvatar = peer?.user?.avatar_url;
      }
      if (avatarEl) {
        if (peerAvatar) {
          avatarEl.innerHTML = `<img src="${peerAvatar}" class="w-full h-full object-cover rounded-full" alt="avatar" />`;
          avatarEl.className = 'w-10 h-10 rounded-full shadow-xs ring-1 ring-blue-500/20 overflow-hidden';
        } else {
          avatarEl.textContent = (conv.title || 'U')[0].toUpperCase();
          avatarEl.className = 'w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 flex items-center justify-center font-bold text-white text-sm shadow-xs ring-1 ring-blue-500/20';
        }
      }
      const statusPeer = conv.type === 'direct' && conv.members
        ? conv.members.find(m => m.user_id !== this.currentUser?.id)
        : null;
      if (subEl) subEl.textContent = statusPeer ? this.presenceLabel(statusPeer.user) : '';
      if (callBtns) callBtns.classList.remove('hidden');
    }
  }

  renderPinnedMessageBanner() {
    const banner = document.getElementById('pinnedMessageBanner');
    if (!banner) return;
    const conv = this.conversations.find(c => c.id === this.selectedConvId);

    if (conv && conv.pinned_message_id) {
      const msg = this.messages.find(m => m.id === conv.pinned_message_id) || conv.pinned_message;
      if (msg) {
        banner.classList.remove('hidden');
        banner.innerHTML = `
          <div class="px-4 py-1.5 bg-blue-50/90 dark:bg-[#132238]/90 border-b border-blue-200/60 dark:border-cyan-500/20 flex items-center justify-between cursor-pointer hover:bg-blue-100/50 transition-colors">
            <div onclick="window.app.jumpToMessage('${msg.id}')" class="flex items-center gap-2 min-w-0">
              <span class="text-blue-600 dark:text-cyan-400 shrink-0">${icons.pin('w-3.5 h-3.5')}</span>
              <div class="min-w-0">
                <span class="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-cyan-400 block">${false ? 'پیام سنجاق شده' : 'Pinned Message'}</span>
                <p class="text-xs text-slate-800 dark:text-slate-200 truncate max-w-lg">${this.escapeHtml(msg.text)}</p>
              </div>
            </div>
            <button onclick="window.app.unpinMessage('${msg.id}')" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">${icons.close('w-3.5 h-3.5')}</button>
          </div>
        `;
        return;
      }
    }
    banner.classList.add('hidden');
    banner.innerHTML = '';
  }

  renderMessages() {
    const container = document.getElementById('chatMessagesScroll');
    if (!container) return;

    if (this.messages.length === 0) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-slate-400 text-xs">
          <div class="w-12 h-12 rounded-2xl bg-white/80 dark:bg-[#111a28]/80 text-blue-600 dark:text-cyan-400 flex items-center justify-center text-xl mb-2 shadow-xs ring-1 ring-blue-500/20">
            ${icons.bookmark('w-6 h-6')}
          </div>
          <p class="font-bold text-slate-700 dark:text-slate-200">${false ? 'هنوز پیامی در این گفتگو نیست' : 'No messages in this chat yet'}</p>
          <p class="text-[11px] text-slate-400 mt-1">${false ? 'یک پیام متنی، یادداشت یا پیام صوتی ارسال کنید!' : 'Send a greeting, file, or voice note to begin chatting!'}</p>
        </div>
      `;
      return;
    }

    let html = '';
    let lastDateStr = '';

    this.messages.forEach(msg => {
      const isMe = msg.sender_id === this.currentUser?.id;
      const dateStr = new Date(msg.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

      // Date separator pill
      if (dateStr !== lastDateStr) {
        lastDateStr = dateStr;
        html += `
          <div class="flex justify-center my-3 sticky top-2 z-10 pointer-events-none">
            <span class="bg-white/85 dark:bg-[#111a28]/85 backdrop-blur-md text-slate-600 dark:text-slate-400 text-[10px] font-semibold px-3 py-0.5 rounded-full border border-[#e2eaf4] dark:border-slate-700/60 shadow-xs">
              ${dateStr}
            </span>
          </div>
        `;
      }

      const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const senderName = this.nameFor(msg.sender) || 'User';

      // Reply preview
      let replyHtml = '';
      if (msg.reply_preview) {
        replyHtml = `
          <div onclick="window.app.jumpToMessage('${msg.reply_to_id}')" class="mb-1.5 pl-2 py-0.5 rounded border-l-2 ${
            isMe ? 'bg-black/15 border-white text-white' : 'bg-slate-100 dark:bg-black/25 border-blue-600 text-slate-700 dark:text-slate-300'
          } text-[11px] cursor-pointer">
            <strong class="block text-[10px] opacity-90">${this.escapeHtml(msg.reply_preview.sender_name)}</strong>
            <span class="truncate block opacity-80">${this.escapeHtml(msg.reply_preview.text)}</span>
          </div>
        `;
      }

      // Forwarded citation
      let forwardedHtml = '';
      if (msg.forwarded_from_title) {
        forwardedHtml = `
          <div class="text-[10px] opacity-75 italic mb-1 flex items-center gap-1">
            <span class="inline-flex">${icons.forward('w-3 h-3')}</span>
            <span>Forwarded from ${this.escapeHtml(msg.forwarded_from_title)}</span>
          </div>
        `;
      }

      // Voice note player vs text vs attachments
      let bodyHtml = '';
      const voiceAttachment = (msg.attachments || []).find(a => (a.mime_type || '').includes('audio') || (a.duration_seconds || 0) > 0);

      if (voiceAttachment) {
        bodyHtml = this.renderVoicePlayerHtml(msg, voiceAttachment, isMe);
      } else {
        // Attachments
        let attsHtml = '';
        if (msg.attachments && msg.attachments.length > 0) {
          attsHtml = msg.attachments.map(att => {
            const isImg = (att.mime_type || '').startsWith('image/');
            if (isImg) {
              const canSave = /gif|webp/.test(att.mime_type || '');
              return `
                <div class="relative mb-2 rounded-2xl overflow-hidden max-w-sm border border-white/10 shadow-lg">
                  <img src="/media/${this.escapeHtml(att.file_name)}" alt="${this.escapeHtml(att.original_name)}" class="w-full max-h-64 object-cover" />
                  ${canSave ? `<button onclick="window.app.saveSticker('${att.id}')" class="absolute top-2 right-2 px-2.5 py-1 rounded-xl bg-black/55 backdrop-blur-md hover:bg-black/75 text-white text-[10px] font-bold">★ ${this.t('Save', 'ذخیره')}</button>` : ''}
                  <div class="flex items-center gap-2 px-3 py-1.5 bg-black/35 backdrop-blur-md text-white text-[10px]">
                    <span class="px-1.5 py-0.5 rounded-md bg-white/15 font-bold tracking-wider">${this.fileKind(att)}</span>
                    <span class="truncate flex-1">${this.escapeHtml(att.original_name)}</span>
                    <span class="opacity-75 font-mono shrink-0">${this.fmtSize(att.file_size)}</span>
                  </div>
                </div>
              `;
            }
            return `
              <div class="flex items-center gap-2.5 p-2 mb-1.5 rounded-xl border ${isMe ? 'bg-black/20 border-white/20 text-white' : 'bg-slate-50 dark:bg-black/20 border-slate-200 text-slate-800 dark:text-white'}">
                <span class="text-blue-500 shrink-0 inline-flex">${icons.file('w-4 h-4')}</span>
                <div class="flex-1 min-w-0">
                  <p class="text-xs font-semibold truncate">${this.escapeHtml(att.original_name)}</p>
                  <span class="text-[10px] opacity-75 font-mono">${this.fileKind(att)} · ${this.fmtSize(att.file_size)}</span>
                </div>
                <a href="/api/attachments/${att.id}/download" download class="p-1 hover:opacity-100 opacity-80 inline-flex cursor-pointer" title="Download">${icons.download('w-4 h-4')}</a>
              </div>
            `;
          }).join('');
        }

        bodyHtml = `
          ${attsHtml}
          <div class="text-[13.5px] leading-relaxed whitespace-pre-wrap break-words" dir="auto">${this.formatMessageText(msg.text)}</div>
        `;
      }

      // Reactions badges
      let reactionsHtml = '';
      if (msg.reactions && msg.reactions.length > 0) {
        reactionsHtml = `
          <div class="flex flex-wrap gap-1 mt-1 px-1">
            ${msg.reactions.map(r => {
              const hasReacted = (r.user_ids || []).includes(this.currentUser?.id);
              return `
                <button 
                  onclick="window.app.toggleReaction('${msg.id}', '${r.emoji}')"
                  class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-all cursor-pointer ${
                    hasReacted 
                      ? 'bg-blue-50 dark:bg-sky-950 border-blue-400 dark:border-cyan-500 text-blue-700 dark:text-cyan-300 font-bold'
                      : 'bg-white dark:bg-[#111a28] border-[#e2eaf4] dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-400'
                  }"
                >
                  <span>${r.emoji}</span>
                  <span class="font-mono text-[10px]">${r.count}</span>
                </button>
              `;
            }).join('')}
          </div>
        `;
      }

      // Read status icon
      let statusIconHtml = '';
      if (isMe) {
        statusIconHtml = msg.is_read_by_recipient 
          ? `<span class="inline-flex text-blue-200 dark:text-cyan-300">${icons.checkCheck('w-3.5 h-3.5')}</span>` 
          : `<span class="inline-flex text-white/80">${icons.check('w-3.5 h-3.5')}</span>`;
      }

      html += `
        <div id="msg-${msg.id}" class="group relative flex flex-col ${isMe ? 'items-end' : 'items-start'} animate-slide-up">
          <div 
            class="relative max-w-[85%] md:max-w-[70%] lg:max-w-[55%] rounded-2xl px-3.5 py-2.5 transition-all ${
              isMe 
                ? 'text-white rounded-tr-xs shadow-md' 
                : 'bg-white dark:bg-[#17233c] text-slate-900 dark:text-slate-100 border border-[#e2eaf4] dark:border-slate-700/60 rounded-tl-xs shadow-xs'
            }"
            style="${isMe ? `background-color: ${this.userSettings.accent_color || '#2563eb'}` : ''}"
          >
            ${!isMe ? `<span data-profile-uid="${msg.sender_id}" class="block text-xs font-bold text-blue-600 dark:text-cyan-300 mb-0.5 cursor-pointer hover:underline">${this.escapeHtml(senderName)}</span>` : ''}
            ${forwardedHtml}
            ${replyHtml}
            ${bodyHtml}
            
            <div class="flex items-center justify-end gap-1.5 mt-1 text-[10px] font-mono select-none ${isMe ? 'text-white/80' : 'text-slate-400'}">
              ${msg.is_edited ? '<span class="italic text-[9px]">edited</span>' : ''}
              <span>${timeStr}</span>
              ${statusIconHtml}
            </div>

            <!-- Crisp Vector Hover Toolbar -->
            <div class="absolute top-0 -translate-y-1/2 flex items-center gap-1 bg-white/95 dark:bg-[#111a28]/95 backdrop-blur-md border border-[#e2eaf4] dark:border-slate-700 rounded-full px-2 py-1 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-20 ${isMe ? 'right-2' : 'left-2'}">
              <button onclick="window.app.toggleReaction('${msg.id}', '❤️')" title="Heart" class="p-0.5 hover:scale-125 transition-transform text-xs cursor-pointer">❤️</button>
              <button onclick="window.app.toggleReaction('${msg.id}', '👍')" title="Like" class="p-0.5 hover:scale-125 transition-transform text-xs cursor-pointer">👍</button>
              <button onclick="window.app.toggleReaction('${msg.id}', '🔥')" title="Fire" class="p-0.5 hover:scale-125 transition-transform text-xs cursor-pointer">🔥</button>
              <span class="w-px h-3.5 bg-slate-200 dark:bg-slate-700 mx-0.5"></span>
              <button onclick="window.app.prepareReply('${msg.id}')" title="Reply" class="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-cyan-400 cursor-pointer transition-colors">${icons.reply('w-3.5 h-3.5')}</button>
              <button onclick="window.app.copyText('${msg.id}')" title="Copy Text" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer transition-colors">${icons.copy('w-3.5 h-3.5')}</button>
              <button onclick="window.app.togglePin('${msg.id}')" title="${msg.is_pinned ? 'Unpin' : 'Pin'}" class="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-cyan-400 cursor-pointer transition-colors">${icons.pin('w-3.5 h-3.5')}</button>
              <button onclick="window.app.openForwardModal('${msg.id}')" title="Forward" class="p-1 text-slate-400 hover:text-blue-600 dark:hover:text-cyan-400 cursor-pointer transition-colors">${icons.forward('w-3.5 h-3.5')}</button>
              ${isMe ? `<button onclick="window.app.prepareEdit('${msg.id}')" title="Edit" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer transition-colors">${icons.edit('w-3.5 h-3.5')}</button>` : ''}
              <button onclick="window.app.deleteMessage('${msg.id}')" title="Delete" class="p-1 text-slate-400 hover:text-rose-500 cursor-pointer transition-colors">${icons.trash('w-3.5 h-3.5')}</button>
              ${!isMe ? `<button onclick="window.app.openReportModal('${msg.id}')" title="Report Violation" class="p-1 text-slate-400 hover:text-rose-500 cursor-pointer transition-colors">${icons.flag('w-3.5 h-3.5')}</button>` : ''}
            </div>
          </div>
          ${reactionsHtml}
        </div>
      `;
    });

    container.innerHTML = html;
  }

  renderVoicePlayerHtml(msg, attachment, isMe) {
    const durSec = attachment.duration_seconds || 12;
    const mins = Math.floor(durSec / 60);
    const secs = durSec % 60;
    const durLabel = `${mins}:${secs.toString().padStart(2, '0')}`;
    const audioSrc = `/media/${encodeURIComponent(attachment.file_name)}`;

    return `
      <div class="voice-player-bubble flex items-center gap-2.5 py-1 min-w-[210px]" data-audio-src="${audioSrc}">
        <button 
          onclick="window.app.toggleAudioPlay(this, '${audioSrc}')" 
          class="w-9 h-9 rounded-full ${isMe ? 'bg-white text-blue-600' : 'bg-blue-600 text-white'} flex items-center justify-center font-bold text-xs shadow-xs shrink-0 cursor-pointer transition-transform hover:scale-105"
          title="Play / Pause Voice Note"
        >
          ${icons.play('w-4 h-4')}
        </button>
        <div class="flex-1 flex flex-col justify-center">
          <div class="voice-waveform-container cursor-pointer" onclick="window.app.scrubAudio(this, event)">
            ${Array.from({ length: 24 }).map((_, i) => {
              const h = Math.max(6, Math.round(Math.sin(i * 0.4) * 12 + 10));
              return `<span class="voice-bar" style="height: ${h}px;"></span>`;
            }).join('')}
          </div>
          <div class="flex items-center justify-between text-[10px] opacity-80 font-mono mt-0.5">
            <span class="voice-time-elapsed">0:00</span>
            <span>${durLabel}</span>
            <button onclick="window.app.cycleAudioSpeed(this)" class="px-1.5 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-[9px] font-bold cursor-pointer">1x</button>
          </div>
        </div>
      </div>
    `;
  }

  toggleAudioPlay(btn, audioSrc) {
    // If currently playing another audio, pause it
    if (this.currentAudioPlayer && this.currentAudioSrc !== audioSrc) {
      this.currentAudioPlayer.pause();
      document.querySelectorAll('.voice-player-bubble button').forEach(b => {
        b.innerHTML = icons.play('w-4 h-4');
      });
    }

    let audio = this.currentAudioPlayer;
    if (!audio || this.currentAudioSrc !== audioSrc) {
      audio = new Audio(audioSrc);
      this.currentAudioPlayer = audio;
      this.currentAudioSrc = audioSrc;
    }

    const container = btn.closest('.voice-player-bubble');
    const elapsedEl = container.querySelector('.voice-time-elapsed');
    const bars = container.querySelectorAll('.voice-bar');

    if (audio.paused) {
      audio.play();
      btn.innerHTML = icons.pause('w-4 h-4');

      audio.ontimeupdate = () => {
        const cur = Math.floor(audio.currentTime);
        const mins = Math.floor(cur / 60);
        const secs = cur % 60;
        if (elapsedEl) elapsedEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

        const progress = audio.currentTime / (audio.duration || 1);
        const playedCount = Math.floor(progress * bars.length);
        bars.forEach((b, idx) => {
          if (idx <= playedCount) b.classList.add('played');
          else b.classList.remove('played');
        });
      };

      audio.onended = () => {
        btn.innerHTML = icons.play('w-4 h-4');
        bars.forEach(b => b.classList.remove('played'));
        if (elapsedEl) elapsedEl.textContent = '0:00';
      };
    } else {
      audio.pause();
      btn.innerHTML = icons.play('w-4 h-4');
    }
  }

  scrubAudio(waveformEl, event) {
    if (!this.currentAudioPlayer) return;
    const rect = waveformEl.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    this.currentAudioPlayer.currentTime = pct * (this.currentAudioPlayer.duration || 1);
  }

  cycleAudioSpeed(speedBtn) {
    if (!this.currentAudioPlayer) return;
    const curSpeed = this.currentAudioPlayer.playbackRate;
    let nextSpeed = 1.0;
    if (curSpeed === 1.0) nextSpeed = 1.5;
    else if (curSpeed === 1.5) nextSpeed = 2.0;
    else nextSpeed = 1.0;

    this.currentAudioPlayer.playbackRate = nextSpeed;
    speedBtn.textContent = `${nextSpeed}x`;
  }

  // -------------------------------------------------------------
  // Messaging Operations
  // -------------------------------------------------------------
  async handleSendMessage() {
    const input = document.getElementById('chatInputText');
    if (!input || !this.selectedConvId) return;

    const text = input.value.trim();
    if (!text && !this.editingMessage) return;

    if (this.editingMessage) {
      try {
        await api.editMessage(this.editingMessage.id, text);
        this.editingMessage = null;
        this.clearComposerBanner();
        input.value = '';
      } catch (err) {
        alert(err.message);
      }
    } else {
      try {
        const replyId = this.replyingTo ? this.replyingTo.id : null;
        input.value = '';
        this.replyingTo = null;
        this.clearComposerBanner();

        // Send via WebSocket if open, else REST
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.sendWebSocket({
            action: 'send_message',
            conversation_id: this.selectedConvId,
            data: {
              text,
              reply_to_id: replyId,
              client_msg_id: `c_${Date.now()}`
            }
          });
        } else {
          const sent = await api.sendMessage(this.selectedConvId, text, replyId);
          this.messages.push(sent);
          this.renderMessages();
          this.scrollToBottom();
          this.updateConversationLastMessage(sent);
        }
      } catch (err) {
        alert(err.message);
      }
    }
  }

  prepareReply(msgId) {
    const msg = this.messages.find(m => m.id === msgId);
    if (!msg) return;
    this.replyingTo = msg;
    this.editingMessage = null;
    this.showComposerBanner(`Reply to ${msg.sender?.display_name || 'User'}`, msg.text);
    document.getElementById('chatInputText')?.focus();
  }

  prepareEdit(msgId) {
    const msg = this.messages.find(m => m.id === msgId);
    if (!msg || msg.sender_id !== this.currentUser?.id) return;
    this.editingMessage = msg;
    this.replyingTo = null;
    this.showComposerBanner('Edit Message', msg.text);
    const input = document.getElementById('chatInputText');
    if (input) {
      input.value = msg.text;
      input.focus();
    }
  }

  showComposerBanner(title, snippet) {
    const banner = document.getElementById('composerContextBanner');
    if (!banner) return;
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <div class="flex items-center justify-between px-3 py-1.5 bg-slate-100 dark:bg-[#152338] border-l-2 border-blue-600 rounded-xl text-xs mb-2">
        <div class="min-w-0 pr-2">
          <strong class="text-[10px] text-blue-600 dark:text-cyan-400 uppercase tracking-wider block">${this.escapeHtml(title)}</strong>
          <span class="truncate block text-slate-700 dark:text-slate-300 text-xs">${this.escapeHtml(snippet)}</span>
        </div>
        <button onclick="window.app.clearComposerBanner()" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer">${icons.close('w-3.5 h-3.5')}</button>
      </div>
    `;
  }

  clearComposerBanner() {
    this.replyingTo = null;
    this.editingMessage = null;
    const banner = document.getElementById('composerContextBanner');
    if (banner) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
    }
  }

  async deleteMessage(msgId) {
    if (!confirm('Are you sure you want to delete this message?')) return;
    try {
      await api.deleteMessage(msgId);
      this.messages = this.messages.filter(m => m.id !== msgId);
      this.renderMessages();
    } catch (err) {
      alert(err.message);
    }
  }

  async toggleReaction(msgId, emoji) {
    try {
      await api.toggleReaction(msgId, emoji);
    } catch (err) {
      console.error('Failed to toggle reaction:', err);
    }
  }

  async togglePin(msgId) {
    const msg = this.messages.find(m => m.id === msgId);
    if (!msg) return;
    try {
      await api.togglePin(msgId, !msg.is_pinned);
    } catch (err) {
      alert(err.message);
    }
  }

  unpinMessage(msgId) {
    this.togglePin(msgId);
  }

  copyText(msgId) {
    const msg = this.messages.find(m => m.id === msgId);
    if (msg) {
      navigator.clipboard.writeText(msg.text);
      this.showToast('Message text copied to clipboard!');
    }
  }

  jumpToMessage(msgId) {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-blue-500');
      setTimeout(() => el.classList.remove('ring-2', 'ring-blue-500'), 1800);
    }
  }

  // -------------------------------------------------------------
  // Voice Recording Controller
  // -------------------------------------------------------------
  async handleVoiceButton() {
    if (this.voiceRecorder.state === 'inactive') {
      try {
        await this.voiceRecorder.start();
        document.getElementById('voiceRecordingBar')?.classList.remove('hidden');
        document.getElementById('chatInputContainer')?.classList.add('hidden');
      } catch (err) {
        alert(err.message || 'Microphone access denied or unavailable.');
      }
    }
  }

  handleVoiceStateChange(state) {
    const bar = document.getElementById('voiceRecordingBar');
    const input = document.getElementById('chatInputContainer');
    if (!bar || !input) return;

    if (state === 'inactive') {
      bar.classList.add('hidden');
      input.classList.remove('hidden');
    }
  }

  handleVoiceTimeUpdate(sec, formatted) {
    const el = document.getElementById('voiceRecordingTimer');
    if (el) el.textContent = formatted;
  }

  handleVoiceWaveform(bands) {
    const container = document.getElementById('liveVoiceWaveform');
    if (!container) return;
    container.innerHTML = bands.map(h => `<span class="w-1 bg-rose-500 rounded-sm inline-block" style="height: ${h}px;"></span>`).join('');
  }

  cancelVoiceRecording() {
    this.voiceRecorder.cancel();
  }

  async sendVoiceRecording() {
    const rec = this.voiceRecorder;
    if (rec.state !== 'recording' && rec.state !== 'paused') return;
    if (!this.selectedConvId) {
      alert('Please open a conversation first.');
      rec.cancel();
      return;
    }

    const duration = rec.getDuration();
    let blob = null;
    try {
      blob = await rec.stopAndGetBlob();
    } catch (err) {
      rec.cancel();
      alert('Could not finish the recording: ' + err.message);
      return;
    }
    rec.cancel();

    if (!blob || blob.size === 0) {
      alert('The recording was empty. Please try again.');
      return;
    }
    try {
      await api.uploadVoice(this.selectedConvId, blob, duration);
    } catch (err) {
      alert('Failed to upload voice message: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // File Attachment Handling
  // -------------------------------------------------------------
  async handleFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file || !this.selectedConvId) return;

    try {
      await api.uploadAttachment(this.selectedConvId, file);
      event.target.value = '';
    } catch (err) {
      alert('Upload failed: ' + err.message);
    }
  }

  // -------------------------------------------------------------
  // WebRTC Calling
  // -------------------------------------------------------------
  async initWebRTCConfig() {
    try {
      const cfg = await api.getWebRTCConfig();
      if (cfg && cfg.ice_servers) {
        this.callManager.setIceServers(cfg.ice_servers);
      }
    } catch {}
  }

  startCall(callType = 'audio') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      alert('Connection to the server is lost. Please wait for reconnection and try again.');
      return;
    }
    const conv = this.conversations.find(c => c.id === this.selectedConvId);
    if (conv && conv.type === 'group') {
      this.startGroupCall(callType, conv);
      return;
    }
    if (!conv || conv.type !== 'direct') {
      alert('Calls can only be placed in 1-on-1 direct conversations.');
      return;
    }

    const peer = conv.members.find(m => m.user_id !== this.currentUser?.id);
    if (!peer) return;

    this.callManager.startCall(
      peer.user_id,
      peer.user?.display_name || conv.title,
      peer.user?.avatar_url,
      callType,
      conv.id
    ).catch(err => {
      alert('Failed to start call: ' + err.message);
    });
  }

  handleCallStateChange(state, callData) {
    const overlay = document.getElementById('callOverlayModal');
    const incomingModal = document.getElementById('incomingCallModal');
    if (!overlay || !incomingModal) return;

    if (state === 'ringing' && callData && !callData.isCaller) {
      // Incoming call dialog
      incomingModal.classList.remove('hidden');
      document.getElementById('incomingCallerName').textContent = callData.targetUserName || 'User';
      document.getElementById('incomingCallTypeLabel').textContent = callData.callType === 'video' ? 'Incoming Video Call...' : 'Incoming Audio Call...';
      return;
    }

    incomingModal.classList.add('hidden');

    if (state === 'dialing' || state === 'ringing' || state === 'connected') {
      overlay.classList.remove('hidden');
      document.getElementById('callPeerName').textContent = callData?.targetUserName || 'User';
      document.getElementById('callStatusLabel').textContent = state === 'dialing' ? 'Calling...' : state === 'ringing' ? 'Ringing...' : 'Connected';
      
      const videoContainer = document.getElementById('callVideoContainer');
      const audioModeWrap = document.getElementById('callAudioModeWrap');
      if (callData?.callType === 'video') {
        videoContainer?.classList.remove('hidden');
        audioModeWrap?.classList.add('hidden');
      } else {
        videoContainer?.classList.add('hidden');
        audioModeWrap?.classList.remove('hidden');
      }
    } else if (state === 'idle') {
      overlay.classList.add('hidden');
      incomingModal.classList.add('hidden');
      const localVid = document.getElementById('localVideo');
      const remoteVid = document.getElementById('remoteVideo');
      if (localVid) localVid.srcObject = null;
      if (remoteVid) remoteVid.srcObject = null;
      const remoteAud = document.getElementById('remoteAudio');
      if (remoteAud) remoteAud.srcObject = null;
    }
  }

  handleLocalStream(stream) {
    const localVid = document.getElementById('localVideo');
    if (localVid) {
      localVid.srcObject = stream;
      localVid.play().catch(() => {});
    }
  }

  handleRemoteStream(stream) {
    // Sound comes only from the dedicated <audio> element. The video element is muted,
    // otherwise the same voice plays twice (echo).
    const remoteVid = document.getElementById('remoteVideo');
    const remoteAud = document.getElementById('remoteAudio');
    if (remoteVid) {
      remoteVid.muted = true;
      remoteVid.srcObject = null;        // re-assign so the element picks up tracks added later
      remoteVid.srcObject = stream;
      remoteVid.play().catch(() => {});
    }
    if (remoteAud) {
      remoteAud.srcObject = stream;
      remoteAud.play().catch(() => {});
    }
  }

  handleCallDuration(formattedStr) {
    const el = document.getElementById('callDurationTimer');
    if (el) el.textContent = formattedStr;
  }

  // -------------------------------------------------------------
  // Modals & Panels
  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // Read receipts
  // -------------------------------------------------------------
  maybeMarkRead(convId = this.selectedConvId) {
    if (!convId || convId !== this.selectedConvId) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const scroller = document.getElementById('chatMessagesScroll');
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 120) return;
    if (this.readMarkPending) return;
    this.readMarkPending = true;
    api.markRead(convId)
      .then(() => {
        const conv = this.conversations.find(c => c.id === convId);
        if (conv && conv.unread_count) {
          conv.unread_count = 0;
          this.renderConversationList();
        }
      })
      .catch(() => {})
      .finally(() => setTimeout(() => { this.readMarkPending = false; }, 400));
  }

  // -------------------------------------------------------------
  // Group creation
  // -------------------------------------------------------------
  setNewChatTab(tab) {
    const isGroup = tab === 'group';
    document.getElementById('newChatContactForm')?.classList.toggle('hidden', isGroup);
    document.getElementById('newChatError')?.classList.add('hidden');
    document.getElementById('newChatFoundUser')?.classList.add('hidden');
    document.getElementById('newGroupForm')?.classList.toggle('hidden', !isGroup);
    const contactBtn = document.getElementById('newChatTabContact');
    const groupBtn = document.getElementById('newChatTabGroup');
    const active = 'py-1.5 rounded-lg bg-white dark:bg-blue-600 text-blue-700 dark:text-white shadow-xs';
    const idle = 'py-1.5 rounded-lg text-slate-600 dark:text-slate-300';
    if (contactBtn) contactBtn.className = isGroup ? idle : active;
    if (groupBtn) groupBtn.className = isGroup ? active : idle;
  }

  async handleCreateGroup(event) {
    event.preventDefault();
    const title = document.getElementById('newGroupTitleInput')?.value.trim();
    const raw = document.getElementById('newGroupMembersInput')?.value || '';
    const errEl = document.getElementById('newGroupError');
    const showError = (msg) => {
      if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    };
    if (errEl) errEl.classList.add('hidden');
    if (!title) return showError('Group name is required.');

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return showError('Add at least one member.');
    if (lines.length > 9) return showError('A group can have at most 10 members, including you.');

    try {
      const memberIds = [];
      for (const line of lines) {
        const [username, pin] = line.split(/\s+/);
        if (!username || !pin) throw new Error(`Each line must be "username PIN". Problem with: ${line}`);
        const user = await api.verifyConnect(username, pin);
        memberIds.push(user.id);
      }
      const conv = await api.createConversation('group', title, null, [...new Set(memberIds)]);
      document.getElementById('newGroupTitleInput').value = '';
      document.getElementById('newGroupMembersInput').value = '';
      this.closeNewChatModal();
      await this.loadConversations();
      this.selectConversation(conv.id);
    } catch (e) {
      showError(e.message);
    }
  }

  // -------------------------------------------------------------
  // Group calls
  // -------------------------------------------------------------
  async startGroupCall(callType, conv) {
    if (this.callManager.callState !== 'idle' || this.groupCall.busy) {
      alert('Finish your current call first.');
      return;
    }
    try {
      await this.groupCall.start(conv.id, callType);
      this.showGroupCallOverlay(conv.title || 'Group call');
    } catch (e) {
      alert('Could not start group call: ' + e.message);
    }
  }

  showGroupInvite(info) {
    this.pendingGroupInvite = info;
    const text = document.getElementById('groupInviteText');
    if (text) {
      const kind = info.call_type === 'video' ? 'video' : 'audio';
      text.textContent = `${info.starter_name || 'Someone'} started a ${kind} call in ${info.title || 'the group'}.`;
    }
    document.getElementById('groupCallInvite')?.classList.remove('hidden');
  }

  dismissGroupInvite() {
    this.pendingGroupInvite = null;
    document.getElementById('groupCallInvite')?.classList.add('hidden');
  }

  async acceptGroupInvite() {
    const info = this.pendingGroupInvite;
    if (!info) return;
    this.dismissGroupInvite();
    if (this.callManager.callState !== 'idle' || this.groupCall.busy) {
      alert('Finish your current call first.');
      return;
    }
    this.showGroupCallOverlay(info.title || 'Group call');
    try {
      await this.groupCall.join(info.group_call_id, info.call_type);
    } catch (e) {
      this.groupCall.cleanup();
      this.hideGroupCallOverlay();
      alert('Could not join group call: ' + e.message);
    }
  }

  showGroupCallOverlay(title) {
    document.getElementById('groupCallOverlay')?.classList.remove('hidden');
    const titleEl = document.getElementById('groupCallTitle');
    if (titleEl) titleEl.textContent = title || 'Group call';
    const status = document.getElementById('groupCallStatus');
    if (status) status.textContent = 'Connecting...';
  }

  hideGroupCallOverlay() {
    document.getElementById('groupCallOverlay')?.classList.add('hidden');
    const grid = document.getElementById('groupCallGrid');
    if (grid) grid.innerHTML = '';
    const mute = document.getElementById('groupMuteBtn');
    if (mute) mute.textContent = 'Mute';
    const video = document.getElementById('groupVideoBtn');
    if (video) video.textContent = 'Camera off';
  }

  handleGroupCallState(state, info) {
    if (state === 'ended') {
      this.hideGroupCallOverlay();
      return;
    }
    const status = document.getElementById('groupCallStatus');
    if (!status) return;
    if (state === 'peer_joined') {
      status.textContent = `${info.display_name || 'Someone'} joined`;
    } else if (state === 'active') {
      status.textContent = (info.peers || []).length > 0 ? 'Connected' : 'Waiting for others...';
    }
  }

  renderGroupTile(id, name, stream, isLocal = false) {
    const grid = document.getElementById('groupCallGrid');
    if (!grid) return;
    let tile = grid.querySelector(`[data-uid="${id}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.dataset.uid = id;
      tile.className = 'relative rounded-2xl overflow-hidden bg-black/60 border border-white/10 min-h-[160px]';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = isLocal;   // local preview is muted to avoid echo; remote audio plays
      video.className = 'absolute inset-0 w-full h-full object-cover';
      const label = document.createElement('span');
      label.className = 'absolute bottom-2 left-2 text-xs bg-black/50 px-2 py-0.5 rounded';
      label.textContent = name;
      tile.append(video, label);
      grid.appendChild(tile);
    }
    const video = tile.querySelector('video');
    // Re-assign so the element picks up tracks that arrive after the first ones
    video.srcObject = null;
    video.srcObject = stream;
    video.play().catch(() => {});
    this.updateGroupGridLayout();
  }

  removeGroupTile(id) {
    const grid = document.getElementById('groupCallGrid');
    grid?.querySelector(`[data-uid="${id}"]`)?.remove();
    this.updateGroupGridLayout();
  }

  updateGroupGridLayout() {
    const grid = document.getElementById('groupCallGrid');
    if (!grid) return;
    const count = Math.max(1, grid.children.length);
    grid.style.gridTemplateColumns = `repeat(${Math.min(count, 3)}, minmax(0, 1fr))`;
  }

  groupCallToggleMute() {
    const muted = this.groupCall.toggleMute();
    const btn = document.getElementById('groupMuteBtn');
    if (btn) btn.textContent = muted ? 'Unmute' : 'Mute';
  }

  groupCallToggleVideo() {
    const off = this.groupCall.toggleVideo();
    const btn = document.getElementById('groupVideoBtn');
    if (btn) btn.textContent = off ? 'Camera on' : 'Camera off';
  }

  leaveGroupCall() {
    this.groupCall.leave();
    this.hideGroupCallOverlay();
  }

  // -------------------------------------------------------------
  // Names, contact settings, profiles
  // -------------------------------------------------------------
  t(en, fa) {
    return en;
  }

  async loadContactSettings() {
    if (!this.currentUser) return;
    const rows = await api.getContacts();
    this.contactSettings = new Map(rows.map(r => [r.user_id, r]));
  }

  nameFor(user) {
    if (!user) return '';
    const s = this.contactSettings.get(user.id);
    return (s && s.nickname) || user.display_name || '';
  }

  directTitle(conv) {
    if (conv.type !== 'direct' || !conv.members) return null;
    const peer = conv.members.find(m => m.user_id !== this.currentUser?.id);
    return peer ? this.nameFor(peer.user) : null;
  }

  openModalShell(title, html) {
    this.ensureProfileModal();
    const modal = document.getElementById('profileModal');
    const panel = document.getElementById('profilePanel');
    const titleEl = document.getElementById('profileModalTitle');
    if (titleEl) titleEl.textContent = title;
    const body = document.getElementById('profileModalBody');
    if (body) body.innerHTML = html;
    if (!modal || !panel) return;
    clearTimeout(this.profileCloseTimer);
    modal.style.display = 'block';
    requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; });
  }

  closeProfile() {
    const modal = document.getElementById('profileModal');
    const panel = document.getElementById('profilePanel');
    if (!modal || !panel) return;
    panel.style.transform = 'translateX(100%)';
    this.profileCloseTimer = setTimeout(() => { modal.style.display = 'none'; }, 300);
  }

  // The profile panel lives directly under <body> and uses inline fixed positioning,
  // so it is not affected by any parent container or by the Tailwind CDN timing.
  ensureProfileModal() {
    const modal = document.getElementById('profileModal');
    const panel = document.getElementById('profilePanel');
    if (!modal || !panel) return;
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    Object.assign(modal.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: '0',
      zIndex: '60', display: 'none', background: 'rgba(0,0,0,0.4)'
    });
    Object.assign(panel.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: 'auto',
      width: 'min(380px, 100vw)', display: 'flex', flexDirection: 'column',
      transform: 'translateX(100%)', transition: 'transform 0.3s ease-out'
    });
  }

  openConversationProfile(convId) {
    const conv = this.conversations.find(c => c.id === convId);
    if (!conv) return;
    if (conv.type === 'direct') {
      const peer = conv.members?.find(m => m.user_id !== this.currentUser?.id);
      if (peer) this.openProfile(peer.user_id);
    } else if (conv.type === 'group') {
      this.openGroupInfo(convId);
    }
  }

  openChatInfo() {
    const conv = this.conversations.find(c => c.id === this.selectedConvId);
    if (!conv) return;
    if (conv.type === 'direct') {
      const peer = conv.members?.find(m => m.user_id !== this.currentUser?.id);
      if (peer) this.openProfile(peer.user_id);
    } else if (conv.type === 'group') {
      this.openGroupInfo(conv.id);
    }
  }

  openGroupInfo(convId) {
    const conv = this.conversations.find(c => c.id === convId);
    if (!conv) return;
    const members = conv.members || [];
    const initial = this.escapeHtml((conv.title || 'G')[0].toUpperCase());
    const avatar = conv.avatar_url
      ? `<img src="${this.escapeHtml(conv.avatar_url)}" class="w-full h-full object-cover" alt="" />`
      : `<span>${initial}</span>`;

    const memberRows = members.map(m => {
      const u = m.user || {};
      const badge = m.role === 'owner' ? this.t('Owner', 'مالک') : (m.role === 'admin' ? this.t('Admin', 'مدیر') : '');
      const me = m.user_id === this.currentUser?.id ? this.t(' (you)', ' (شما)') : '';
      return `
        <button data-profile-uid="${this.escapeHtml(m.user_id)}" class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-left">
          <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center font-bold text-sm overflow-hidden shrink-0">
            ${u.avatar_url ? `<img src="${this.escapeHtml(u.avatar_url)}" class="w-full h-full object-cover" alt="" />` : this.escapeHtml((u.display_name || 'U')[0].toUpperCase())}
          </div>
          <div class="min-w-0 flex-1">
            <p class="font-semibold truncate text-slate-900 dark:text-white">${this.escapeHtml(this.nameFor(u))}${me}</p>
            <p class="text-slate-500 text-[11px] font-mono truncate">@${this.escapeHtml(u.username || '')}</p>
          </div>
          ${badge ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-cyan-900/40 text-blue-700 dark:text-cyan-300">${badge}</span>` : ''}
        </button>`;
    }).join('');

    this.openModalShell(this.t('Group info', 'اطلاعات گروه'), `
      ${this.profileHero(avatar, this.escapeHtml(conv.title || this.t('Group', 'گروه')),
        `${members.length} ${this.t('members', 'عضو')}`)}
      ${this.profileActions([
        { icon: 'msg', label: this.t('Chat', 'گفتگو'), onclick: `window.app.closeProfile(); window.app.selectConversation('${conv.id}')` },
        { icon: 'call', label: this.t('Audio', 'صوتی'), onclick: `window.app.profileGroupCall('${conv.id}', 'audio')` },
        { icon: 'video', label: this.t('Video', 'تصویری'), onclick: `window.app.profileGroupCall('${conv.id}', 'video')` },
        { icon: 'bell', label: conv.is_muted ? this.t('Unmute', 'روشن') : this.t('Mute', 'بی‌صدا'), onclick: `window.app.toggleGroupMute('${conv.id}')` },
      ])}
      ${conv.description ? this.profileCard(this.profileRow(this.t('Description', 'توضیحات'), this.escapeHtml(conv.description))) : ''}
      ${this.profileCard([
        ['owner', 'admin'].includes(this.groupRole(conv)) ? this.profileActionRow(this.t('Manage group', 'مدیریت گروه'), `window.app.openGroupSettings('${conv.id}')`) : '',
        this.profileActionRow(this.t('Leave group', 'ترک گروه'), `window.app.leaveGroupChat('${conv.id}')`, true),
      ].join(''))}
      <p class="px-4 pt-4 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${members.length} ${this.t('members', 'عضو')}</p>
      <div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden py-1">${memberRows}</div>
    `);
  }

  async openProfile(userId, opts = {}) {
    if (!userId) return;
    if (userId === this.currentUser?.id) {
      this.openSettingsModal();
      return;
    }
    const list = opts.list || null;
    this.profileList = list;
    this.profileIndex = list ? (opts.index ?? list.indexOf(userId)) : 0;
    this.openModalShell(this.t('Profile', 'پروفایل'), `<p class="p-5 text-slate-500">${this.t('Loading...', 'در حال بارگذاری...')}</p>`);
    try {
      const data = await api.getProfile(userId);
      this.renderProfileModal(data);
      this.renderProfileNav();
      this.renderProfileStories(userId, data.stories_count);
      if (opts.slideDir) this.animateProfileBody(opts.slideDir);
    } catch (e) {
      this.openModalShell(this.t('Profile', 'پروفایل'), `<p class="p-5 text-rose-500">${this.escapeHtml(e.message)}</p>`);
    }
  }

  // ---- Telegram-style profile building blocks ----
  profileIcon(name) {
    const paths = {
      msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      call: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
      video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M22 8l-6 4 6 4V8z"/>',
      bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    };
    return `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  }

  profileHero(avatarHtml, nameHtml, subHtml, attrs = '') {
    return `
      <div>
        <div class="h-28 bg-gradient-to-br from-blue-600 to-sky-500 dark:from-cyan-700 dark:to-blue-900"></div>
        <div class="flex flex-col items-center -mt-14 px-4 pb-4 text-center">
          <div ${attrs} class="w-28 h-28 rounded-full ring-4 ring-[#f4f7fc] dark:ring-[#0b1322] bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center text-4xl font-bold overflow-hidden shadow-lg cursor-pointer">${avatarHtml}</div>
          <p class="mt-3 text-lg font-bold text-slate-900 dark:text-white">${nameHtml}</p>
          <p class="text-xs text-slate-500 dark:text-slate-400">${subHtml}</p>
        </div>
      </div>`;
  }

  profileActions(items) {
    const cells = items.map(a => `
      <button onclick="${a.onclick}" class="flex flex-col items-center gap-1.5 text-[11px] font-semibold text-blue-600 dark:text-cyan-400 cursor-pointer min-w-[60px]">
        <span class="w-12 h-12 rounded-full bg-white dark:bg-[#111a28] border border-slate-200 dark:border-slate-700 flex items-center justify-center shadow-xs">${this.profileIcon(a.icon)}</span>
        ${a.label}
      </button>`).join('');
    return `<div class="flex justify-center gap-4 px-4 pb-4">${cells}</div>`;
  }

  profileCard(rowsHtml) {
    return `<div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">${rowsHtml}</div>`;
  }

  profileRow(label, valueHtml) {
    return `<div class="px-4 py-3"><p class="text-[11px] text-slate-500 dark:text-slate-400">${label}</p><p class="text-sm text-slate-900 dark:text-slate-100 break-words">${valueHtml}</p></div>`;
  }

  profileToggleRow(label, checked, onchange) {
    return `<label class="flex items-center justify-between px-4 py-3 cursor-pointer"><span class="text-sm text-slate-900 dark:text-slate-100">${label}</span><input type="checkbox" ${checked ? 'checked' : ''} onchange="${onchange}" class="w-5 h-5 accent-blue-600 cursor-pointer" /></label>`;
  }

  profileActionRow(label, onclick, danger = false) {
    return `<button onclick="${onclick}" class="w-full text-left px-4 py-3 text-sm font-semibold cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60 ${danger ? 'text-rose-600 dark:text-rose-400' : 'text-blue-600 dark:text-cyan-400'}">${label}</button>`;
  }

  renderProfileModal(data) {
    const u = data.user;
    const rel = data.relationship;
    const uid = this.escapeHtml(u.id);
    const avatar = u.avatar_url
      ? `<img src="${this.escapeHtml(u.avatar_url)}" class="w-full h-full object-cover" alt="" />`
      : `<span>${this.escapeHtml((u.display_name || 'U')[0].toUpperCase())}</span>`;
    const status = this.escapeHtml(this.presenceLabel(u));
    const statusHtml = `<span class="${u.is_online ? 'text-emerald-500' : 'text-slate-500 dark:text-slate-400'}">${status}</span>`;

    const groupRows = (data.shared_groups || []).map(g => `
      <button onclick="window.app.openGroupInfo('${this.escapeHtml(g.id)}')" class="w-full text-left px-4 py-3 flex justify-between items-center text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60">
        <span class="text-slate-900 dark:text-slate-100">${this.escapeHtml(g.title || this.t('Group', 'گروه'))}</span>
        <span class="text-slate-500 text-xs">${g.member_count} ${this.t('members', 'عضو')}</span>
      </button>`).join('') || `<p class="px-4 py-3 text-xs text-slate-500">${this.t('No shared groups', 'گروه مشترکی ندارید')}</p>`;

    this.openModalShell(this.t('Profile', 'پروفایل'), `
      ${this.profileHero(avatar, this.escapeHtml(rel.nickname || u.display_name), statusHtml, this.avatarAttrs(u, data.stories_count > 0))}
      ${rel.nickname ? `<p class="text-center text-[11px] text-slate-500 -mt-2 mb-3">${this.t('Name', 'نام')}: ${this.escapeHtml(u.display_name)}</p>` : ''}
      ${this.profileActions([
        { icon: 'msg', label: this.t('Message', 'پیام'), onclick: `window.app.profileMessage('${uid}')` },
        { icon: 'call', label: this.t('Audio', 'صوتی'), onclick: `window.app.profileCall('${uid}', 'audio')` },
        { icon: 'video', label: this.t('Video', 'تصویری'), onclick: `window.app.profileCall('${uid}', 'video')` },
        { icon: 'bell', label: rel.notifications_muted ? this.t('Unmute', 'روشن') : this.t('Mute', 'بی‌صدا'), onclick: `window.app.profileToggleMute('${uid}', ${!rel.notifications_muted})` },
      ])}

      ${this.profileCard([
        u.bio ? this.profileRow(this.t('Bio', 'بیو'), this.escapeHtml(u.bio)) : '',
        this.profileRow(this.t('Username', 'نام کاربری'), `@${this.escapeHtml(u.username)}`),
      ].join(''))}

      <p class="px-4 pt-4 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${this.t('Contact', 'مخاطب')}</p>
      ${this.profileCard([
        this.profileActionRow(
          rel.is_saved ? this.t('Remove from contacts', 'حذف از مخاطبین') : this.t('Save to contacts', 'ذخیره به عنوان مخاطب'),
          `window.app.profileToggleSaved('${uid}', ${!rel.is_saved})`),
        `<div class="px-4 py-3">
           <p class="text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">${this.t('Nickname (only you see it)', 'نام مستعار (فقط شما می‌بینید)')}</p>
           <div class="flex gap-2">
             <input id="profileNicknameInput" value="${this.escapeHtml(rel.nickname || '')}" maxlength="100"
               class="flex-1 p-2 text-sm bg-slate-50 dark:bg-[#152236] border border-slate-200 dark:border-slate-700 rounded-lg" />
             <button onclick="window.app.profileSaveNickname('${uid}')" class="px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold cursor-pointer">${this.t('Save', 'ذخیره')}</button>
           </div>
         </div>`,
      ].join(''))}

      <p class="px-4 pt-4 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${this.t('Settings', 'تنظیمات')}</p>
      ${this.profileCard([
        this.profileToggleRow(this.t('Mute notifications from this user', 'بی‌صدا کردن اعلان‌های این کاربر'),
          rel.notifications_muted, `window.app.profileToggleMute('${uid}', this.checked)`),
        this.profileActionRow(
          rel.is_blocked ? this.t('Unblock user', 'رفع مسدودی') : this.t('Block user', 'مسدود کردن کاربر'),
          `window.app.profileToggleBlock('${uid}', ${!rel.is_blocked})`, !rel.is_blocked),
      ].join(''))}

      <p class="px-4 pt-4 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${this.t('Shared groups', 'گروه‌های مشترک')}</p>
      <div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">${groupRows}</div>
    `);
  }

  async profileGroupCall(convId, callType) {
    this.closeProfile();
    await this.selectConversation(convId);
    this.startCall(callType);
  }

  async toggleGroupMute(convId) {
    try {
      await api.request(`/conversations/${convId}/mute`, { method: 'POST' });
      await this.loadConversations();
      this.openGroupInfo(convId);
    } catch (e) {
      alert(e.message);
    }
  }

  async profileMessage(userId) {
    this.closeProfile();
    await this.openDirectChat(userId);
  }

  async profileCall(userId, callType) {
    this.closeProfile();
    await this.openDirectChat(userId);
    this.startCall(callType);
  }

  async openDirectChat(userId) {
    try {
      const conv = await api.createConversation('direct', null, userId);
      await this.loadConversations();
      await this.selectConversation(conv.id);
    } catch (e) {
      alert(e.message);
    }
  }

  async saveContactSettings(userId, payload) {
    try {
      await api.updateContact(userId, payload);
      await this.loadContactSettings();
      this.renderConversationList();
      this.renderChatHeader();
      return true;
    } catch (e) {
      alert(e.message);
      return false;
    }
  }

  async profileToggleSaved(userId, save) {
    if (await this.saveContactSettings(userId, { is_saved: save })) this.openProfile(userId);
  }

  async profileSaveNickname(userId) {
    const value = document.getElementById('profileNicknameInput')?.value ?? '';
    if (await this.saveContactSettings(userId, { nickname: value.trim() })) this.openProfile(userId);
  }

  async profileToggleMute(userId, muted) {
    await this.saveContactSettings(userId, { notifications_muted: muted });
  }

  async profileToggleBlock(userId, block) {
    if (block && !confirm(this.t(
      'Block this user? Neither of you can message or call the other.',
      'این کاربر مسدود شود؟ هیچ‌کدام نمی‌توانید به دیگری پیام دهید یا تماس بگیرید.'
    ))) return;
    if (await this.saveContactSettings(userId, { is_blocked: block })) this.openProfile(userId);
  }

  // -------------------------------------------------------------
  // Profile slider
  // -------------------------------------------------------------
  renderProfileNav() {
    const body = document.getElementById('profileModalBody');
    if (!body) return;
    body.querySelector('[data-profile-nav]')?.remove();
    const list = this.profileList || [];
    if (list.length < 2) return;
    const index = this.profileIndex || 0;
    const indicator = list.length <= 8
      ? list.map((_, i) => `<span class="w-1.5 h-1.5 rounded-full ${i === index ? 'bg-blue-600 dark:bg-cyan-400' : 'bg-slate-300 dark:bg-slate-600'}"></span>`).join('')
      : `<span class="text-[11px] text-slate-500">${index + 1} / ${list.length}</span>`;
    const nav = document.createElement('div');
    nav.dataset.profileNav = '1';
    nav.className = 'flex items-center justify-between px-4 pt-3';
    nav.innerHTML = `
      <button onclick="window.app.profileSlide(-1)" class="w-9 h-9 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-lg">‹</button>
      <div class="flex items-center gap-1.5 flex-wrap justify-center">${indicator}</div>
      <button onclick="window.app.profileSlide(1)" class="w-9 h-9 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-lg">›</button>`;
    body.prepend(nav);
  }

  async renderProfileStories(userId, count) {
    const body = document.getElementById('profileModalBody');
    if (!body || !count) return;
    let items = [];
    try {
      items = await api.request(`/stories/user/${userId}`);
    } catch (e) {
      return;
    }
    if (!items.length) return;
    const box = document.createElement('div');
    box.className = 'px-4 pt-4';
    box.innerHTML = `
      <p class="text-xs font-bold text-blue-600 dark:text-cyan-400 mb-2">${this.t('Stories', 'استوری‌ها')} · ${items.length}</p>
      <div id="profileStoriesStrip" class="flex gap-2.5 overflow-x-auto pb-2 snap-x snap-mandatory" style="scrollbar-width: thin;"></div>`;
    const strip = box.querySelector('#profileStoriesStrip');
    items.forEach((item, index) => {
      const tile = document.createElement('button');
      tile.className = 'snap-start shrink-0 w-24 h-36 rounded-2xl overflow-hidden relative bg-white/5 border border-white/10 cursor-pointer transition-transform hover:scale-[1.03]';
      tile.addEventListener('click', () => this.openStoryViewer(userId, index));
      if (item.media_type === 'video') {
        const play = document.createElement('div');
        play.className = 'absolute inset-0 flex items-center justify-center text-2xl text-white/90';
        play.textContent = '▶';
        tile.appendChild(play);
      } else {
        const img = document.createElement('img');
        img.src = item.media_url;
        img.alt = '';
        img.className = 'w-full h-full object-cover';
        tile.appendChild(img);
      }
      const when = document.createElement('span');
      when.className = 'absolute bottom-1 left-1 right-1 text-[10px] text-white bg-black/50 rounded px-1 py-0.5 truncate';
      when.textContent = this.formatLastSeen(item.created_at);
      tile.appendChild(when);
      strip.appendChild(tile);
    });
    // Mouse wheel scrolls the strip sideways; touch swipes here do not change the profile
    strip.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        strip.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    strip.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    strip.addEventListener('touchend', (e) => e.stopPropagation(), { passive: true });
    const nav = body.querySelector('[data-profile-nav]');
    if (nav) nav.after(box); else body.prepend(box);
  }

  profileSlide(dir) {
    const list = this.profileList || [];
    if (list.length < 2) return;
    const index = ((this.profileIndex || 0) + dir + list.length) % list.length;
    this.openProfile(list[index], { list, index, slideDir: dir });
  }

  animateProfileBody(dir) {
    const body = document.getElementById('profileModalBody');
    body?.animate(
      [{ transform: `translateX(${dir * 40}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: 220, easing: 'ease-out' }
    );
  }

  // -------------------------------------------------------------
  // Contacts tab
  // -------------------------------------------------------------
  renderContactsList() {
    const listEl = document.getElementById('conversationsList');
    if (!listEl) return;
    const contacts = Array.from(this.contactSettings.values()).filter(c => c.is_saved);
    this.contactListIds = contacts.map(c => c.user_id);
    if (contacts.length === 0) {
      listEl.innerHTML = `<p class="p-4 text-xs text-slate-500 text-center">${this.t(
        'No saved contacts yet. Open a profile and tap Save to contacts.',
        'هنوز مخاطبی ذخیره نشده. یک پروفایل را باز کنید و گزینه ذخیره به عنوان مخاطب را بزنید.')}</p>`;
      return;
    }
    listEl.innerHTML = contacts.map((c, i) => `
      <button onclick="window.app.openContactAt(${i})" class="w-full flex items-center gap-3 p-2.5 rounded-2xl hover:bg-slate-100/70 dark:hover:bg-[#152236] cursor-pointer text-left">
        <div class="w-11 h-11 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center font-bold text-sm shrink-0">${this.escapeHtml((c.display_name || 'U')[0].toUpperCase())}</div>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-semibold truncate text-slate-900 dark:text-slate-100">${this.escapeHtml(c.nickname || c.display_name || '')}</p>
          <p class="text-[11px] font-mono text-slate-500 truncate">@${this.escapeHtml(c.username || '')}</p>
        </div>
      </button>`).join('');
  }

  openContactAt(index) {
    const ids = this.contactListIds || [];
    if (!ids[index]) return;
    this.openProfile(ids[index], { list: ids, index });
  }

  // -------------------------------------------------------------
  // Account settings (Telegram-style pages)
  // -------------------------------------------------------------
  ensureSettingsPanel() {
    if (document.getElementById('tgSettingsOverlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'tgSettingsOverlay';
    wrap.innerHTML = `
      <aside id="tgSettingsPanel" class="bg-[#f4f7fc] dark:bg-[#0b1322] text-slate-800 dark:text-slate-200 shadow-2xl border-l border-[#e2eaf4] dark:border-slate-800">
        <div class="flex items-center gap-2 px-3 h-14 shrink-0 bg-white dark:bg-[#111a28] border-b border-slate-100 dark:border-slate-800">
          <button id="tgSettingsBack" class="hidden w-9 h-9 rounded-full text-lg hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer" onclick="window.app.showSettingsPage('main')">‹</button>
          <h3 id="tgSettingsTitle" class="flex-1 text-sm font-bold text-slate-900 dark:text-white"></h3>
          <button class="w-9 h-9 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer" onclick="window.app.closeSettingsModal()">✕</button>
        </div>
        <div id="tgSettingsMain" class="flex-1 overflow-y-auto pb-8"></div>
        <div id="tgSettingsSubBody" class="hidden flex-1 overflow-y-auto pb-8 p-4 space-y-4 text-xs"></div>
      </aside>`;
    Object.assign(wrap.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: '0',
      zIndex: '70', background: 'rgba(0,0,0,0.4)', display: 'none'
    });
    const panel = wrap.querySelector('#tgSettingsPanel');
    Object.assign(panel.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: 'auto',
      width: 'min(380px, 100vw)', display: 'flex', flexDirection: 'column',
      transform: 'translateX(100%)', transition: 'transform 0.3s ease-out'
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) this.closeSettingsModal(); });
    document.body.appendChild(wrap);
    document.getElementById('tgSettingsMain').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-settings-page]');
      if (btn) this.showSettingsPage(btn.dataset.settingsPage);
    });
  }

  // The original settings card keeps every control and handler. Its sections are moved into
  // Telegram-style sub-pages while a page is open and returned afterwards.
  setupSettingsBuckets() {
    if (this.settingsBuckets) return;
    const card = document.querySelector('#settingsModal > div');
    if (!card) return;
    this.settingsCard = card;
    // Username field sits next to the display name, inside the Edit profile page
    const displayInput = document.getElementById('settingsDisplayNameInput');
    if (displayInput && !document.getElementById('settingsUsernameInput')) {
      displayInput.parentElement.insertAdjacentHTML('beforebegin', `<div>
          <label class="block text-[10px] text-slate-400 uppercase font-semibold mb-1">Username</label>
          <input type="text" id="settingsUsernameInput" class="w-full p-2 bg-white dark:bg-[#152236] border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-mono" />
        </div>`);
    }
    this.settingsBuckets = { profile: [], privacy: [], appearance: [], data: [] };
    this.settingsOriginal = [];
    Array.from(card.children).forEach(el => {
      if (el.querySelector('[onclick*="closeSettingsModal"]')) return; // header stays in the card
      this.settingsOriginal.push(el);
      const bucket = this.settingsBucketFor(el);
      if (bucket) this.settingsBuckets[bucket].push(el);
    });
  }

  settingsBucketFor(el) {
    if (el.querySelector('#settingsDisplayNameInput, #settingsAvatarInput')) return 'profile';
    if (el.querySelector('#settingsConnectPinVal, #settingsSessionsList')) return 'privacy';
    if (el.querySelector('[onclick*="exportData"]')) return 'data';
    if (el.querySelector('[onclick*="logout"]')) return null; // logout is triggered from the main page
    return 'appearance';
  }

  returnSettingsSections() {
    if (!this.settingsCard || !this.settingsOriginal) return;
    this.settingsOriginal.forEach(el => this.settingsCard.appendChild(el));
    const sub = document.getElementById('tgSettingsSubBody');
    if (sub) sub.innerHTML = '';
  }

  showSettingsPage(page) {
    const main = document.getElementById('tgSettingsMain');
    const sub = document.getElementById('tgSettingsSubBody');
    const back = document.getElementById('tgSettingsBack');
    const title = document.getElementById('tgSettingsTitle');
    if (!main || !sub) return;
    this.returnSettingsSections();
    this.settingsPage = page;
    if (['interface', 'chats', 'notifications', 'accessibility', 'advanced'].includes(page)) {
      main.classList.add('hidden');
      sub.classList.remove('hidden');
      back?.classList.remove('hidden');
      if (title) title.textContent = this.prefTitle(page);
      sub.innerHTML = this.prefsPageHtml(page);
      return;
    }

    if (page === 'logout') {
      document.querySelector('[onclick*="logout"]')?.click();
      return;
    }
    if (page === 'main' || !this.settingsBuckets?.[page]) {
      main.classList.remove('hidden');
      sub.classList.add('hidden');
      back?.classList.add('hidden');
      if (title) title.textContent = this.t('Settings', 'تنظیمات');
      return;
    }
    main.classList.add('hidden');
    sub.classList.remove('hidden');
    back?.classList.remove('hidden');
    if (title) title.textContent = this.settingsPageTitle(page);
    this.settingsBuckets[page].forEach(el => sub.appendChild(el));
  }

  settingsPageTitle(page) {
    const titles = {
      profile: this.t('Edit profile', 'ویرایش پروفایل'),
      privacy: this.t('Privacy & security', 'حریم خصوصی و امنیت'),
      appearance: this.t('Appearance', 'ظاهر'),
      data: this.t('Data & storage', 'داده‌ها و ذخیره‌سازی'),
    };
    return titles[page] || this.t('Settings', 'تنظیمات');
  }

  settingsIcon(name) {
    const paths = {
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4c3 0 5.6-2.5 5.6-5.6C23 6 18 2 12 2z"/>',
      database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
      logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
      eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
      tool: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-8.3 8.3a2.1 2.1 0 1 1-3-3L16.7 8.3a4 4 0 0 0-2-2z"/>',
      sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
      bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    };
    return `<svg viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  }

  renderSettingsMain() {
    const main = document.getElementById('tgSettingsMain');
    if (!main) return;
    const u = this.currentUser || {};
    const avatar = u.avatar_url
      ? `<img src="${this.escapeHtml(u.avatar_url)}" class="w-full h-full object-cover" alt="" />`
      : `<span>${this.escapeHtml((u.display_name || 'U')[0].toUpperCase())}</span>`;
    const row = (icon, label, sub, page, danger = false) => `
      <button data-settings-page="${page}" class="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer text-left">
        <span class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${danger ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-300' : 'bg-blue-50 text-blue-600 dark:bg-slate-800 dark:text-cyan-400'}">${this.settingsIcon(icon)}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm font-semibold ${danger ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100'}">${label}</span>
          ${sub ? `<span class="block text-[11px] text-slate-500 dark:text-slate-400">${sub}</span>` : ''}
        </span>
        ${danger ? '' : '<span class="text-slate-400 text-lg">›</span>'}
      </button>`;
    main.innerHTML = `
      ${this.profileHero(avatar, this.escapeHtml(u.display_name || 'User'), `@${this.escapeHtml(u.username || '')}`, this.avatarAttrs(u, false))}
      <div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
        ${row('user', this.t('Edit profile', 'ویرایش پروفایل'), this.t('Name, bio and photo', 'نام، بیو و عکس'), 'profile')}
        ${row('shield', this.t('Privacy & security', 'حریم خصوصی و امنیت'), this.t('Connect PIN and sessions', 'کد اتصال و نشست‌ها'), 'privacy')}
        ${row('palette', this.t('Appearance', 'ظاهر'), this.t('Wallpaper, bubbles and font', 'پس‌زمینه، حباب‌ها و فونت'), 'appearance')}
        ${row('database', this.t('Data & storage', 'داده‌ها و ذخیره‌سازی'), this.t('Export your data', 'خروجی گرفتن از داده‌ها'), 'data')}
        ${row('sliders', this.t('Interface & effects', 'رابط و جلوه‌ها'), this.t('Text size, compact list, motion, glass', 'اندازه‌ی متن، فشرده، انیمیشن، شیشه‌ای'), 'interface')}
        ${row('bell', this.t('Notifications & sounds', 'اعلان‌ها و صدا'), this.t('Desktop alerts, send and receive sounds', 'اعلان دسکتاپ، صدای ارسال و دریافت'), 'notifications')}
        ${row('image', this.t('Chats & wallpaper', 'گفتگوها و پس‌زمینه'), this.t('Background pattern and strength', 'الگو و شدت پس‌زمینه'), 'chats')}
        ${row('eye', this.t('Accessibility', 'دسترس‌پذیری'), this.t('Contrast, larger buttons', 'کنتراست، دکمه‌های بزرگ‌تر'), 'accessibility')}
        ${row('tool', this.t('Advanced', 'پیشرفته'), this.t('Low-power mode, reset', 'حالت کم‌مصرف، بازنشانی'), 'advanced')}
      </div>
      <div class="mx-4 mt-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden">
        ${row('logout', this.t('Log out', 'خروج از حساب'), '', 'logout', true)}
      </div>`;
  }

  // -------------------------------------------------------------
  // Avatars: tap for full size, or open the stories when there are any
  // -------------------------------------------------------------
  avatarAttrs(user, hasStories) {
    return `onclick="window.app.onAvatarTap(this)" data-uid="${this.escapeHtml(user?.id || '')}" data-avatar="${this.escapeHtml(user?.avatar_url || '')}" data-stories="${hasStories ? 1 : 0}"`;
  }

  async onAvatarTap(el) {
    if (el.dataset.stories === '1') {
      const opened = await this.openStoryViewer(el.dataset.uid);
      if (opened) return;
    }
    if (el.dataset.avatar) this.openLightbox(el.dataset.avatar);
  }

  setOverlay(id, open) {
    const el = document.getElementById(id);
    if (el) el.style.display = open ? 'flex' : 'none';
  }

  openLightbox(url) {
    const img = document.getElementById('lightboxImg');
    if (!img) return;
    img.src = url;
    this.setOverlay('lightbox', true);
  }

  closeLightbox() {
    this.setOverlay('lightbox', false);
  }

  // -------------------------------------------------------------
  // Stories: 24-hour posts, visible to people who saved each other
  // -------------------------------------------------------------
  async renderStoriesBar() {
    const bar = document.getElementById('storiesBar');
    if (!bar || !this.currentUser) return;
    let items;
    try {
      items = await api.getStoriesFeed();
    } catch (e) {
      console.warn('Stories feed failed:', e);
      return;
    }
    this.storyFeed = items;
    const me = this.currentUser;
    const mine = items.find(i => i.is_me);
    const others = items.filter(i => !i.is_me);
    const avatarOf = (u) => u.avatar_url
      ? `<img src="${this.escapeHtml(u.avatar_url)}" class="w-full h-full object-cover" alt="" />`
      : `<span class="font-bold text-white text-sm">${this.escapeHtml((u.display_name || 'U')[0].toUpperCase())}</span>`;
    const unseenRing = 'bg-gradient-to-tr from-amber-400 via-rose-500 to-fuchsia-600';
    const seenRing = 'bg-slate-300 dark:bg-slate-600';
    const bubble = (name, avatar, ring, onclick, badge = '') => `
      <button onclick="${onclick}" class="flex flex-col items-center gap-1 w-16 shrink-0 cursor-pointer">
        <span class="relative w-14 h-14 rounded-full p-[2px] ${ring}">
          <span class="w-full h-full rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 flex items-center justify-center overflow-hidden border-2 border-white dark:border-[#0b1322]">${avatar}</span>
          ${badge}
        </span>
        <span class="text-[10px] w-full truncate text-center text-slate-700 dark:text-slate-300">${this.escapeHtml(name)}</span>
      </button>`;
    const plus = '<span class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center border-2 border-white dark:border-[#0b1322]">+</span>';
    const myBubble = bubble(
      this.t('My story', 'استوری من'),
      avatarOf(me),
      mine ? unseenRing : 'bg-transparent',
      'window.app.onMyStoryTap()',
      plus
    );
    const otherBubbles = others.map(i => bubble(
      i.display_name,
      avatarOf(i),
      i.unseen ? unseenRing : seenRing,
      `window.app.openStoryViewer('${i.user_id}')`
    )).join('');
    bar.innerHTML = `<div class="flex gap-2 overflow-x-auto pb-2">${myBubble}${otherBubbles}</div>`;
  }

  onMyStoryTap() {
    const mine = (this.storyFeed || []).find(i => i.is_me);
    if (mine) this.openStoryViewer(this.currentUser.id);
    else this.pickStoryFile();
  }

  pickStoryFile() {
    document.getElementById('storyFileInput')?.click();
  }

  async handleStoryFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) this.openStoryComposer(file);
  }

  // ---- Story composer (Instagram-style) ----
  storyFilterCss(name) {
    return {
      none: '',
      warm: 'sepia(0.25) saturate(1.25) hue-rotate(-8deg) brightness(1.04)',
      cool: 'saturate(1.1) hue-rotate(18deg) brightness(1.05) contrast(1.03)',
      mono: 'grayscale(1) contrast(1.12)',
      vivid: 'saturate(1.7) contrast(1.08)',
    }[name] ?? '';
  }

  openStoryComposer(file) {
    if (this.storyDraft?.previewUrl) URL.revokeObjectURL(this.storyDraft.previewUrl);
    const isVideo = file.type.startsWith('video');
    this.storyDraft = { file, type: isVideo ? 'video' : 'image', filter: 'none', platform: false,
                        previewUrl: URL.createObjectURL(file) };
    const media = document.getElementById('storyComposerMedia');
    media.innerHTML = '';
    if (isVideo) {
      const video = document.createElement('video');
      video.src = this.storyDraft.previewUrl;
      video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
      video.className = 'max-w-full max-h-full object-contain';
      media.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.id = 'storyComposerImg';
      img.src = this.storyDraft.previewUrl;
      img.alt = '';
      img.className = 'max-w-full max-h-full object-contain transition-[filter] duration-200';
      media.appendChild(img);
    }
    document.getElementById('storyComposerCaption').value = '';
    const isStaff = ['owner', 'moderator'].includes(this.currentUser?.role);
    document.getElementById('storyAudienceEveryone')?.classList.toggle('hidden', !isStaff);
    document.getElementById('storyComposerStatus').textContent = '';
    this.setComposerFilter('none');
    this.setComposerAudience(false);
    this.setOverlay('storyComposer', true);
  }

  closeStoryComposer() {
    if (this.storyDraft?.previewUrl) URL.revokeObjectURL(this.storyDraft.previewUrl);
    this.storyDraft = null;
    const media = document.getElementById('storyComposerMedia');
    if (media) media.innerHTML = '';
    this.setOverlay('storyComposer', false);
  }

  setComposerFilter(name) {
    if (!this.storyDraft) return;
    this.storyDraft.filter = name;
    const img = document.getElementById('storyComposerImg');
    if (img) img.style.filter = this.storyFilterCss(name);
    document.querySelectorAll('[data-story-filter]').forEach(b => {
      b.classList.toggle('ring-2', b.dataset.storyFilter === name);
      b.classList.toggle('ring-white', b.dataset.storyFilter === name);
    });
  }

  setComposerAudience(everyone) {
    if (!this.storyDraft) return;
    this.storyDraft.platform = !!everyone;
    document.getElementById('storyAudienceContacts')?.classList.toggle('ring-2', !everyone);
    document.getElementById('storyAudienceContacts')?.classList.toggle('ring-white', !everyone);
    document.getElementById('storyAudienceEveryone')?.classList.toggle('ring-2', !!everyone);
    document.getElementById('storyAudienceEveryone')?.classList.toggle('ring-white', !!everyone);
  }

  // Bakes the chosen filter into the image so the published story matches the preview
  bakeFilteredImage(file, cssFilter) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if ('filter' in ctx) ctx.filter = cssFilter;
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(blob => {
          if (blob) resolve(new File([blob], 'story.jpg', { type: 'image/jpeg' }));
          else reject(new Error('Could not process the image.'));
        }, 'image/jpeg', 0.92);
      };
      img.onerror = () => reject(new Error('Could not read the image.'));
      img.src = URL.createObjectURL(file);
    });
  }

  async publishStory() {
    const draft = this.storyDraft;
    if (!draft) return;
    const caption = document.getElementById('storyComposerCaption')?.value.trim() || '';
    const status = document.getElementById('storyComposerStatus');
    const btn = document.getElementById('storyPublishBtn');
    if (btn) btn.disabled = true;
    if (status) status.textContent = this.t('Sharing...', 'در حال انتشار...');
    try {
      let upload = draft.file;
      if (draft.type === 'image' && draft.filter !== 'none') {
        upload = await this.bakeFilteredImage(draft.file, this.storyFilterCss(draft.filter));
      }
      await api.uploadStory(upload, caption, draft.platform);
      this.closeStoryComposer();
      await this.renderStoriesBar();
    } catch (e) {
      if (status) status.textContent = e.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async openStoryViewer(userId, startIndex = 0) {
    try {
      const stories = await api.getUserStories(userId);
      if (!stories.length) return false;
      const feedIds = (this.storyFeed || []).map(i => i.user_id);
      this.storyAuthors = feedIds.includes(userId) ? feedIds : [userId];
      this.storyAuthorIdx = this.storyAuthors.indexOf(userId);
      this.storyAuthorId = userId;
      this.storyList = stories;
      const feedItem = (this.storyFeed || []).find(i => i.user_id === userId);
      this.storyAuthorMeta = userId === this.currentUser?.id
        ? { name: this.currentUser.display_name, avatar: this.currentUser.avatar_url }
        : { name: feedItem?.display_name || '', avatar: feedItem?.avatar_url || '' };
      this.setOverlay('storyViewer', true);
      this.showStory(Math.min(Math.max(startIndex, 0), this.storyList.length - 1));
      return true;
    } catch (e) {
      return false;
    }
  }

  showStory(index) {
    this.clearStoryTimer();
    if (index < 0 || index >= this.storyList.length) return;
    this.storyIdx = index;
    const s = this.storyList[index];
    const meta = this.storyAuthorMeta || {};
    const isMine = this.storyAuthorId === this.currentUser?.id;

    const progress = document.getElementById('storyProgress');
    progress.innerHTML = this.storyList.map((_, k) => `
      <div class="flex-1 h-0.5 rounded bg-white/30 overflow-hidden"><div class="h-full bg-white" style="width:${k < index ? 100 : 0}%"></div></div>`).join('');
    const bar = progress.children[index]?.firstElementChild;

    document.getElementById('storyAuthorName').textContent = meta.name || '';
    document.getElementById('storyTime').textContent = this.formatLastSeen(s.created_at);
    document.getElementById('storyAuthorAvatar').innerHTML = meta.avatar
      ? `<img src="${this.escapeHtml(meta.avatar)}" class="w-full h-full object-cover" alt="" />`
      : this.escapeHtml((meta.name || 'U')[0].toUpperCase());
    document.getElementById('storyCaption').textContent = s.caption || '';
    document.getElementById('storyAddBtn')?.classList.toggle('hidden', !isMine);
    document.getElementById('storyViewersBtn')?.classList.toggle('hidden', !isMine);
    document.getElementById('storyDeleteBtn')?.classList.toggle('hidden', !isMine);

    const media = document.getElementById('storyMedia');
    media.innerHTML = '';
    if (s.media_type === 'video') {
      const video = document.createElement('video');
      video.src = s.media_url;
      video.autoplay = true;
      video.playsInline = true;
      video.className = 'max-w-full max-h-full';
      video.onended = () => this.storyTap(1);
      video.onerror = () => this.showStoryUnavailable();
      media.appendChild(video);
      video.play().catch(() => {});
    } else {
      const img = document.createElement('img');
      img.src = s.media_url;
      img.alt = '';
      img.className = 'max-w-full max-h-full object-contain';
      img.onerror = () => this.showStoryUnavailable();
      media.appendChild(img);
      if (bar) {
        bar.style.transition = 'width 5s linear';
        requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = '100%'; }));
      }
      this.storyTimer = setTimeout(() => this.storyTap(1), 5000);
    }
    if (!isMine) api.viewStory(s.id).catch(() => {});
  }

  showStoryUnavailable() {
    this.clearStoryTimer();
    const media = document.getElementById('storyMedia');
    if (media) {
      media.innerHTML = `<p class="px-6 text-center text-white text-sm">${this.t('This story is no longer available.', 'این استوری دیگر در دسترس نیست.')}</p>`;
    }
    this.storyTimer = setTimeout(() => this.storyTap(1), 2500);
  }

  storyTap(dir) {
    this.clearStoryTimer();
    const next = this.storyIdx + dir;
    if (next >= 0 && next < this.storyList.length) {
      this.showStory(next);
      return;
    }
    const author = this.storyAuthorIdx + dir;
    if (author >= 0 && author < this.storyAuthors.length) {
      this.openStoryViewer(this.storyAuthors[author]);
      return;
    }
    if (dir > 0) this.closeStoryViewer();
  }

  clearStoryTimer() {
    clearTimeout(this.storyTimer);
    this.storyTimer = null;
  }

  closeStoryViewer() {
    this.clearStoryTimer();
    this.setOverlay('storyViewer', false);
    const media = document.getElementById('storyMedia');
    if (media) media.innerHTML = '';
    this.renderStoriesBar();
  }

  // ---- Viewers sheet (Telegram-style list of who saw the story) ----
  async showStoryViewers() {
    const story = this.storyList?.[this.storyIdx];
    if (!story) return;
    this.clearStoryTimer();
    this.setOverlay('storyViewersSheet', true);
    const body = document.getElementById('storyViewersBody');
    const count = document.getElementById('storyViewersCount');
    body.innerHTML = `<p class="p-6 text-center text-slate-400">${this.t('Loading...', 'در حال بارگذاری...')}</p>`;
    try {
      const viewers = await api.getStoryViewers(story.id);
      count.textContent = `${viewers.length} ${this.t('views', 'بازدید')}`;
      body.innerHTML = viewers.length
        ? viewers.map(v => this.viewerRow(v)).join('')
        : `<p class="p-6 text-center text-slate-400">${this.t('No views yet', 'هنوز کسی ندیده')}</p>`;
    } catch (e) {
      body.innerHTML = `<p class="p-6 text-center text-rose-400">${this.escapeHtml(e.message)}</p>`;
    }
  }

  viewerRow(v) {
    const avatar = v.avatar_url
      ? `<img src="${this.escapeHtml(v.avatar_url)}" class="w-full h-full object-cover" alt="" />`
      : this.escapeHtml((v.display_name || 'U')[0].toUpperCase());
    const name = this.contactSettings.get(v.user_id)?.nickname || v.display_name;
    return `
      <button onclick="window.app.openViewerProfile('${this.escapeHtml(v.user_id)}')" class="w-full flex items-center gap-3 px-5 py-2.5 hover:bg-white/5 text-left cursor-pointer">
        <div class="w-11 h-11 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center font-bold overflow-hidden shrink-0">${avatar}</div>
        <div class="min-w-0 flex-1">
          <p class="font-semibold truncate text-white">${this.escapeHtml(name)}</p>
          <p class="text-[11px] text-slate-400 truncate">@${this.escapeHtml(v.username)}</p>
        </div>
        <span class="text-[11px] text-slate-400 shrink-0">${this.escapeHtml(this.formatLastSeen(v.viewed_at))}</span>
      </button>`;
  }

  closeViewersSheet() {
    this.setOverlay('storyViewersSheet', false);
    if (this.storyList?.length) this.showStory(this.storyIdx);
  }

  openViewerProfile(userId) {
    this.setOverlay('storyViewersSheet', false);
    this.closeStoryViewer();
    this.openProfile(userId);
  }

  async deleteCurrentStory() {
    const s = this.storyList?.[this.storyIdx];
    if (!s || !confirm(this.t('Delete this story?', 'این استوری حذف شود؟'))) return;
    try {
      await api.deleteStory(s.id);
      this.storyList.splice(this.storyIdx, 1);
      if (!this.storyList.length) this.closeStoryViewer();
      else this.showStory(Math.min(this.storyIdx, this.storyList.length - 1));
    } catch (e) {
      alert(e.message);
    }
  }

  // -------------------------------------------------------------
  // Group settings (Telegram-style manage page)
  // -------------------------------------------------------------
  groupRole(conv) {
    return (conv.members || []).find(m => m.user_id === this.currentUser?.id)?.role || 'member';
  }

  openGroupSettings(convId) {
    const conv = this.conversations.find(c => c.id === convId);
    if (!conv) return;
    const myRole = this.groupRole(conv);
    const isOwner = myRole === 'owner';
    const canManage = isOwner || myRole === 'admin';
    const members = conv.members || [];
    const avatar = conv.avatar_url
      ? `<img src="${this.escapeHtml(conv.avatar_url)}" class="w-full h-full object-cover" alt="" />`
      : `<span>${this.escapeHtml((conv.title || 'G')[0].toUpperCase())}</span>`;

    const memberRows = members.map(m => {
      const u = m.user || {};
      const isMe = m.user_id === this.currentUser?.id;
      const roleLabel = m.role === 'owner' ? this.t('Owner', 'مالک') : (m.role === 'admin' ? this.t('Admin', 'مدیر') : '');
      let actions = '';
      if (!isMe && m.role !== 'owner') {
        if (isOwner) {
          actions += `<button onclick="window.app.toggleGroupAdmin('${convId}', '${m.user_id}', ${m.role !== 'admin'})" class="text-[11px] font-semibold text-blue-600 dark:text-cyan-400 cursor-pointer px-2">${m.role === 'admin' ? this.t('Remove admin', 'حذف مدیر') : this.t('Make admin', 'مدیر کردن')}</button>`;
        }
        if (canManage && (isOwner || m.role === 'member')) {
          actions += `<button onclick="window.app.removeGroupMember('${convId}', '${m.user_id}')" class="text-[11px] font-semibold text-rose-600 cursor-pointer px-2">${this.t('Remove', 'حذف')}</button>`;
        }
      }
      const uAvatar = u.avatar_url
        ? `<img src="${this.escapeHtml(u.avatar_url)}" class="w-full h-full object-cover" alt="" />`
        : this.escapeHtml((u.display_name || 'U')[0].toUpperCase());
      return `
        <div class="flex items-center gap-3 px-4 py-2.5">
          <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center font-bold text-xs overflow-hidden shrink-0">${uAvatar}</div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold truncate text-slate-900 dark:text-slate-100">${this.escapeHtml(this.nameFor(u))}${isMe ? this.t(' (you)', ' (شما)') : ''}</p>
            <p class="text-[11px] font-mono text-slate-500 truncate">@${this.escapeHtml(u.username || '')}</p>
          </div>
          ${roleLabel ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-cyan-900/40 text-blue-700 dark:text-cyan-300">${roleLabel}</span>` : ''}
          ${actions}
        </div>`;
    }).join('');

    const field = 'w-full p-2 text-sm bg-slate-50 dark:bg-[#152236] border border-slate-200 dark:border-slate-700 rounded-lg';
    const photoAttr = canManage
      ? `onclick="document.getElementById('groupAvatarInput').click()" title="${this.t('Change photo', 'تغییر عکس')}"`
      : '';
    this.openModalShell(this.t('Manage group', 'مدیریت گروه'), `
      ${this.profileHero(avatar, this.escapeHtml(conv.title || ''), `${members.length} ${this.t('members', 'عضو')}`, photoAttr)}
      <input type="file" id="groupAvatarInput" accept="image/*" class="hidden" onchange="window.app.uploadGroupAvatar('${convId}', this)" />

      ${canManage ? `
        <p class="px-4 pt-2 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${this.t('Group info', 'اطلاعات گروه')}</p>
        <div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 p-4 space-y-3">
          <div>
            <p class="text-[11px] text-slate-500 mb-1">${this.t('Name', 'نام')}</p>
            <input id="groupTitleInput" maxlength="100" value="${this.escapeHtml(conv.title || '')}" class="${field}" />
          </div>
          <div>
            <p class="text-[11px] text-slate-500 mb-1">${this.t('Description', 'توضیحات')}</p>
            <textarea id="groupDescInput" rows="3" maxlength="500" class="${field}">${this.escapeHtml(conv.description || '')}</textarea>
          </div>
          <button onclick="window.app.saveGroupInfo('${convId}')" class="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm cursor-pointer">${this.t('Save', 'ذخیره')}</button>
        </div>` : ''}

      <p class="px-4 pt-4 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${members.length} ${this.t('members', 'عضو')}</p>
      <div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">${memberRows}</div>

      ${canManage ? `
        <p class="px-4 pt-4 pb-1 text-xs font-bold text-blue-600 dark:text-cyan-400">${this.t('Add member', 'افزودن عضو')}</p>
        <div class="mx-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 p-4 space-y-2">
          <input id="groupAddUsername" placeholder="username" class="${field} font-mono" />
          <input id="groupAddPin" placeholder="VNT-XXXXXX" class="${field} font-mono uppercase" />
          <button onclick="window.app.addGroupMemberFromForm('${convId}')" class="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm cursor-pointer">${this.t('Add', 'افزودن')}</button>
        </div>` : ''}

      <div class="mx-4 mt-4 mb-4 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 overflow-hidden divide-y divide-slate-100 dark:divide-slate-800">
        ${this.profileActionRow(this.t('Back to group info', 'بازگشت به اطلاعات گروه'), `window.app.openGroupInfo('${convId}')`)}
        ${this.profileActionRow(this.t('Leave group', 'ترک گروه'), `window.app.leaveGroupChat('${convId}')`, true)}
      </div>
    `);
  }

  async refreshGroupAfter(convId, action) {
    try {
      await action();
      await this.loadConversations();
      this.openGroupSettings(convId);
    } catch (e) {
      alert(e.message);
    }
  }

  saveGroupInfo(convId) {
    const title = document.getElementById('groupTitleInput')?.value.trim();
    const description = document.getElementById('groupDescInput')?.value.trim();
    if (!title) {
      alert(this.t('Group name is required.', 'نام گروه لازم است.'));
      return;
    }
    return this.refreshGroupAfter(convId, () => api.updateGroup(convId, { title, description }));
  }

  uploadGroupAvatar(convId, input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    return this.refreshGroupAfter(convId, () => api.uploadGroupAvatar(convId, file));
  }

  removeGroupMember(convId, userId) {
    if (!confirm(this.t('Remove this member from the group?', 'این عضو از گروه حذف شود؟'))) return;
    return this.refreshGroupAfter(convId, () => api.removeGroupMember(convId, userId));
  }

  toggleGroupAdmin(convId, userId, makeAdmin) {
    return this.refreshGroupAfter(convId, () => api.setGroupMemberRole(convId, userId, makeAdmin ? 'admin' : 'member'));
  }

  async addGroupMemberFromForm(convId) {
    const username = document.getElementById('groupAddUsername')?.value.trim().replace(/^@/, '');
    const pin = document.getElementById('groupAddPin')?.value.trim();
    if (!username || !pin) {
      alert(this.t('Enter the username and Connect PIN.', 'نام کاربری و کد اتصال را وارد کنید.'));
      return;
    }
    await this.refreshGroupAfter(convId, async () => {
      const user = await api.verifyConnect(username, pin);
      await api.addGroupMembers(convId, [user.id]);
    });
  }

  async leaveGroupChat(convId) {
    if (!confirm(this.t('Leave this group?', 'از این گروه خارج شوید؟'))) return;
    try {
      await api.leaveGroupChat(convId);
      this.closeProfile();
      if (this.selectedConvId === convId) {
        this.selectedConvId = null;
        const scroller = document.getElementById('chatMessagesScroll');
        if (scroller) scroller.innerHTML = '';
      }
      await this.loadConversations();
    } catch (e) {
      alert(e.message);
    }
  }

  // Chat partner's avatar in the header: ring when they have active stories; tap opens them
  decorateHeaderAvatar() {
    const el = document.getElementById('chatAvatarInitial');
    if (!el) return;
    const conv = this.conversations.find(c => c.id === this.selectedConvId);
    const peer = conv?.type === 'direct' ? conv.members?.find(m => m.user_id !== this.currentUser?.id) : null;
    const hasStory = !!peer && (this.storyFeed || []).some(i => i.user_id === peer.user_id && !i.is_me);
    el.classList.toggle('ring-2', hasStory);
    el.classList.toggle('ring-amber-400', hasStory);
    el.classList.toggle('ring-offset-2', hasStory);
  }

  async onHeaderAvatarTap() {
    const conv = this.conversations.find(c => c.id === this.selectedConvId);
    const peer = conv?.type === 'direct' ? conv.members?.find(m => m.user_id !== this.currentUser?.id) : null;
    if (peer && (this.storyFeed || []).some(i => i.user_id === peer.user_id && !i.is_me)) {
      const opened = await this.openStoryViewer(peer.user_id);
      if (opened) return;
    }
    this.openChatInfo();
  }

  // ---- File labels: what was sent and how big it is ----
  fileKind(att) {
    const ext = (att.original_name || '').split('.').pop().toLowerCase();
    const mime = att.mime_type || '';
    const map = { gif: 'GIF', webp: 'WEBP', png: 'PNG', jpg: 'JPG', jpeg: 'JPG', webm: 'VIDEO', mp4: 'VIDEO', mov: 'VIDEO',
      mp3: 'AUDIO', ogg: 'AUDIO', wav: 'AUDIO', m4a: 'AUDIO', aac: 'AUDIO', pdf: 'PDF', zip: 'ARCHIVE', rar: 'ARCHIVE', '7z': 'ARCHIVE',
      doc: 'WORD', docx: 'WORD', xls: 'EXCEL', xlsx: 'EXCEL', ppt: 'SLIDES', pptx: 'SLIDES', txt: 'TEXT', csv: 'CSV' };
    if (map[ext]) return map[ext];
    if (mime.startsWith('image/')) return 'IMAGE';
    if (mime.startsWith('video/')) return 'VIDEO';
    if (mime.startsWith('audio/')) return 'AUDIO';
    return 'FILE';
  }

  fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---- Emoji, GIF and sticker picker ----
  emojiGroups() {
    return [
      { name: this.t('Smileys', 'چهره‌ها'), list: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
      { name: this.t('Gestures', 'دست‌ها'), list: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','👀','👁️','👅','👄'] },
      { name: this.t('Hearts', 'قلب‌ها'), list: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','♥️','💯','💢','💥','💫','💦','💨','🕳️','💬','🗨️','💭','💤','✨','🌟','⭐','🔥','❄️','⚡','🌈','☀️','🌙','🌸','🌹','🌺','🌻'] },
      { name: this.t('Animals & food', 'حیوانات و غذا'), list: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦄','🐝','🦋','🐌','🐞','🐢','🐍','🦖','🐙','🦑','🦀','🐠','🐬','🐳','🦈','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🍕','🍔','🍟','🌭','🌮','🌯','🥗','🍣','🍜','🍝','🍰','🎂','🍩','🍪','☕','🍺','🍷','🥂'] },
      { name: this.t('Activities', 'فعالیت‌ها'), list: ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🥋','🎯','⛳','🎣','🤿','🎽','🛹','🛼','🏂','⛷️','🏋️','🤸','🤼','🤺','🏇','🧗','🚴','🏆','🥇','🥈','🥉','🏅','🎖️','🎮','🎲','🧩','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎷','🎺','🎸','🎻','🎉','🎊','🎈','🎁'] },
      { name: this.t('Travel & objects', 'سفر و اشیا'), list: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🚚','🚜','🛵','🏍️','🚲','✈️','🚀','🛸','🚁','⛵','🚤','🛳️','🏠','🏢','🏰','🗼','🗽','⛰️','🏝️','🌋','⌛','⏰','⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','💾','💿','📷','📹','🎥','📞','☎️','📺','📻','🔋','🔌','💡','🔦','📚','📖','✏️','📝','📌','📎','✂️','🔑','🔒','🔓','🔨','⚙️','🧲','💊','🩺','🧬','🧪','💰','💳','💎','⚖️','🛒','🎁'] },
      { name: this.t('Symbols', 'نمادها'), list: ['✅','❌','❗','❓','⚠️','🚫','⛔','🔞','💲','™️','©️','®️','➕','➖','➗','✖️','♾️','💠','🔰','♻️','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔸','🔹','🔶','🔷','⬛','⬜','🏁','🚩','🎌','🏳️','🏴','🇺🇸','🇮🇷','🇬🇧','🇩🇪','🇫🇷','🇯🇵','🇹🇷','🇦🇪','🇮🇹','🇪🇸'] },
    ];
  }

  toggleEmojiPicker() {
    const pop = document.getElementById('emojiPopover');
    if (!pop) return;
    const opening = pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !opening);
    if (opening) this.renderEmojiPanel(this.emojiTab || 'emoji');
  }

  renderEmojiPanel(tab) {
    this.emojiTab = tab;
    const pop = document.getElementById('emojiPopover');
    if (!pop) return;
    const tabButton = (name, label) => `
      <button onclick="window.app.renderEmojiPanel('${name}')" class="flex-1 py-1.5 rounded-xl text-xs font-bold transition-all ${tab === name ? 'bg-blue-600 text-white shadow-md' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">${label}</button>`;
    let body;
    if (tab === 'emoji') {
      body = this.emojiGroups().map(group => `
        <p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mt-2 mb-1">${group.name}</p>
        <div class="grid grid-cols-8 gap-0.5">
          ${group.list.map(e => `<button onclick="window.app.insertEmojiChar('${e}')" class="text-xl leading-none p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 hover:scale-125 transition-transform">${e}</button>`).join('')}
        </div>`).join('');
    } else {
      body = `
        <div id="stickerGrid" class="grid grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1 pt-1">
          <p class="col-span-3 text-center text-xs text-slate-400 py-6">${this.t('Loading...', 'در حال بارگذاری...')}</p>
        </div>
        <label class="mt-2 block text-center text-xs font-semibold text-blue-600 dark:text-cyan-400 cursor-pointer py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800">
          + ${this.t('Add GIF or sticker from this computer', 'افزودن گیف یا استیکر از این کامپیوتر')}
          <input type="file" accept=".gif,.webp,.png,.webm" class="hidden" onchange="window.app.uploadSavedMedia(event)" />
        </label>`;
    }
    pop.innerHTML = `
      <div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800/70 rounded-2xl">
        ${tabButton('emoji', this.t('Emoji', 'ایموجی'))}
        ${tabButton('stickers', this.t('GIFs & stickers', 'گیف و استیکر'))}
      </div>
      <div class="max-h-80 overflow-y-auto pr-1">${body}</div>`;
    if (tab !== 'emoji') this.loadStickerGrid();
  }

  insertEmojiChar(emoji) {
    const input = document.getElementById('chatInputText');
    if (!input) return;
    input.value += emoji;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  async loadStickerGrid() {
    const grid = document.getElementById('stickerGrid');
    if (!grid) return;
    try {
      this.savedMedia = await api.request('/saved-media');
      grid.innerHTML = this.savedMedia.length
        ? this.savedMedia.map(item => {
            const media = (item.mime_type || '').startsWith('video')
              ? `<video src="${this.escapeHtml(item.file_url)}" autoplay loop muted playsinline class="w-full h-20 object-contain"></video>`
              : `<img src="${this.escapeHtml(item.file_url)}" alt="" class="w-full h-20 object-contain" />`;
            return `
              <div class="relative group">
                <button onclick="window.app.sendSticker('${item.id}')" class="w-full p-1 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">${media}</button>
                <button onclick="window.app.deleteSavedMedia('${item.id}')" title="Remove" class="absolute top-0.5 right-0.5 hidden group-hover:flex w-5 h-5 rounded-full bg-rose-600 text-white text-[10px] items-center justify-center">✕</button>
              </div>`;
          }).join('')
        : `<p class="col-span-3 text-center text-xs text-slate-400 py-6">${this.t('No GIFs or stickers yet. Add one, or save one you received.', 'هنوز گیف یا استیکری ندارید. یکی اضافه کنید یا از پیام‌های دریافتی ذخیره کنید.')}</p>`;
    } catch (e) {
      grid.innerHTML = `<p class="col-span-3 text-xs text-rose-400 py-4">${this.escapeHtml(e.message)}</p>`;
    }
  }

  async sendSticker(id) {
    const item = (this.savedMedia || []).find(x => x.id === id);
    const convId = this.selectedConvId;
    if (!item || !convId) return;
    document.getElementById('emojiPopover')?.classList.add('hidden');
    try {
      const blob = await (await fetch(item.file_url)).blob();
      const formData = new FormData();
      formData.append('file', new File([blob], item.original_name, { type: item.mime_type }));
      await api.request(`/conversations/${convId}/attachments`, { method: 'POST', body: formData });
    } catch (e) {
      this.showToast(e.message, 'error');
    }
  }

  async uploadSavedMedia(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file, file.name);
    try {
      await api.request('/saved-media', { method: 'POST', body: formData });
      this.showToast(this.t('Saved to your collection', 'به مجموعه‌ی شما اضافه شد'), 'success');
      this.renderEmojiPanel('stickers');
    } catch (e) {
      this.showToast(e.message, 'error');
    }
  }

  async deleteSavedMedia(id) {
    try {
      await api.request(`/saved-media/${id}`, { method: 'DELETE' });
      this.renderEmojiPanel('stickers');
    } catch (e) {
      this.showToast(e.message, 'error');
    }
  }

  async saveSticker(attachmentId) {
    try {
      await api.request(`/saved-media/from-attachment/${attachmentId}`, { method: 'POST' });
      this.showToast(this.t('Saved to your GIFs & stickers', 'به گیف و استیکرهایتان اضافه شد'), 'success');
    } catch (e) {
      this.showToast(e.message, 'error');
    }
  }

  // ---- Call history (duration, missed, declined, busy) ----
  async openCallHistory() {
    this.openModalShell(this.t('Calls', 'تماس‌ها'), `<p class="p-5 text-slate-400">${this.t('Loading...', 'در حال بارگذاری...')}</p>`);
    try {
      const records = await api.request('/calls/history');
      if (!records.length) {
        this.openModalShell(this.t('Calls', 'تماس‌ها'), `<p class="p-8 text-center text-slate-400">${this.t('No calls yet', 'هنوز تماسی ثبت نشده')}</p>`);
        return;
      }
      const me = this.currentUser?.id;
      const labels = {
        completed: null,
        missed: this.t('Missed', 'بی‌پاسخ'),
        rejected: this.t('Declined', 'رد شد'),
        cancelled: this.t('Cancelled', 'لغو شد'),
        busy: this.t('Busy', 'مشغول'),
      };
      const rows = records.map(r => {
        const outgoing = r.caller_id === me;
        const other = outgoing ? r.receiver : r.caller;
        const name = other?.display_name || this.t('Unknown', 'ناشناس');
        const missed = r.status !== 'completed';
        const dur = r.duration_seconds || 0;
        const duration = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`;
        const detail = missed ? labels[r.status] || r.status : duration;
        const arrow = outgoing ? '↗' : '↙';
        return `
          <div class="flex items-center gap-3 px-4 py-3">
            <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-600 to-sky-500 text-white flex items-center justify-center font-bold text-sm shrink-0">${this.escapeHtml(name[0]?.toUpperCase() || '?')}</div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold truncate ${missed && !outgoing ? 'text-rose-500' : 'text-slate-900 dark:text-white'}">${this.escapeHtml(name)}</p>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <span class="${missed ? 'text-rose-500' : 'text-emerald-500'} font-bold">${arrow}</span>
                ${r.call_type === 'video' ? '🎥' : '📞'} ${this.escapeHtml(detail)}
              </p>
            </div>
            <span class="text-[11px] text-slate-400 shrink-0">${this.escapeHtml(this.formatLastSeen(r.created_at))}</span>
          </div>`;
      }).join('');
      this.openModalShell(this.t('Calls', 'تماس‌ها'),
        `<div class="mx-4 mt-2 rounded-2xl bg-white dark:bg-[#111a28] border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">${rows}</div>`);
    } catch (e) {
      this.openModalShell(this.t('Calls', 'تماس‌ها'), `<p class="p-5 text-rose-500">${this.escapeHtml(e.message)}</p>`);
    }
  }

  // ---- Sounds (generated, no audio files; one shared AudioContext keeps CPU low) ----
  playSound(kind) {
    if (this.userSettings.sound_enabled === false || this.prefs().sendSound === false || this.prefs().muteAll) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.audioCtx = this.audioCtx || new AudioCtx();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime;
      if (kind === 'send') {
        osc.frequency.setValueAtTime(1046, t);       // C6: short tick, like a sent message
        osc.frequency.exponentialRampToValueAtTime(1568, t + 0.05);
        gain.gain.setValueAtTime(0.035 * this.volume(), t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        osc.start(t);
        osc.stop(t + 0.1);
      }
    } catch (e) { /* audio unavailable */ }
  }

  // ---- Unread messages in other chats: count on the chat, tab title, and a system notification ----
  bumpUnread(conversationId) {
    const conv = this.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.unread_count = (conv.unread_count || 0) + 1;
      this.renderConversationList();
    }
    const total = this.conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    document.title = total > 0 && this.prefs().titleBadge !== false ? `(${total}) VENTEDA CHAT` : 'VENTEDA CHAT';
  }

  notifyIncoming(message) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (this.prefs().desktopNotif === false || this.prefs().muteAll) return;
    if (this.contactSettings.get(message.sender_id)?.notifications_muted) return;
    const conv = this.conversations.find(c => c.id === message.conversation_id);
    const sender = message.sender?.display_name || 'New message';
    const title = conv && conv.type !== 'direct' ? `${conv.title || 'Group'} · ${sender}` : sender;
    const body = this.prefs().preview === false
      ? this.t('New message', 'پیام جدید')
      : (message.text || (message.attachments?.length ? this.fileKind(message.attachments[0]) : this.t('Sent a message', 'یک پیام فرستاد')));
    try {
      const note = new Notification(title, { body, tag: message.conversation_id, silent: true });
      note.onclick = () => { window.focus(); this.selectConversation(message.conversation_id); note.close(); };
      setTimeout(() => note.close(), 6000);
    } catch (e) { /* notifications not allowed in this context */ }
  }

  // ---- Theme packs: six glass themes, saved on this device ----
  themePacks() {
    return [
      { id: 'cyber', name: 'Cyber Blue Glass', colors: ['#050b1a', '#22d3ee', '#2563eb'] },
      { id: 'anime', name: 'Anime Purple Glass', colors: ['#0d0616', '#c084fc', '#f472b6'] },
      { id: 'neon', name: 'Neon Red City', colors: ['#0c0507', '#fb7185', '#f97316'] },
      { id: 'nature', name: 'Nature Crystal', colors: ['#05130d', '#34d399', '#14b8a6'] },
      { id: 'galaxy', name: 'Galaxy Ultra', colors: ['#05030f', '#a78bfa', '#38bdf8'] },
      { id: 'aurora', name: 'Aurora Glass', colors: ['#03131c', '#5eead4', '#a78bfa'] },
    ];
  }

  applyPack(id) {
    if (id) document.documentElement.setAttribute('data-pack', id);
    else document.documentElement.removeAttribute('data-pack');
    try { localStorage.setItem('venteda_pack', id || ''); } catch (e) { /* storage blocked */ }
    this.openThemePicker();
  }

  openThemePicker() {
    const current = document.documentElement.getAttribute('data-pack') || '';
    const cards = this.themePacks().map(p => `
      <button onclick="window.app.applyPack('${p.id}')" data-active="${current === p.id ? 1 : 0}" class="pack-card text-left bg-white/5 hover:bg-white/10 text-white">
        <div class="pack-swatch" style="background: linear-gradient(135deg, ${p.colors[0]} 0%, ${p.colors[1]} 55%, ${p.colors[2]} 100%); box-shadow: 0 0 24px -6px ${p.colors[1]};"></div>
        <p class="text-xs font-bold">${p.name}</p>
      </button>`).join('');
    this.openModalShell(this.t('Themes', 'تم‌ها'), `
      <div class="grid grid-cols-2 gap-3 px-4 pt-2">${cards}</div>
      <div class="px-4 mt-3">
        <button onclick="window.app.applyPack('')" class="w-full py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-slate-300">${this.t('Default glass', 'شیشه‌ای پیش‌فرض')}</button>
      </div>`);
  }

  // ---- User preferences (saved on this device) ----
  prefs() {
    const defaults = { ui: 'normal', font: 'system', compact: false, motion: true, glass: true, desktopNotif: true, sendSound: true, receiveSound: true, volume: 'normal', preview: true, titleBadge: true, muteAll: false, wall: 'default', wallStrength: 'normal', hiContrast: false, bigTargets: false };
    try { return { ...defaults, ...JSON.parse(localStorage.getItem('venteda_prefs') || '{}') }; }
    catch (e) { return defaults; }
  }

  setPref(key, value) {
    const current = this.prefs();
    current[key] = value;
    try { localStorage.setItem('venteda_prefs', JSON.stringify(current)); } catch (e) { /* storage blocked */ }
    this.applyPrefs();
    this.showSettingsPage(this.settingsPage);
  }

  applyPrefs() {
    const p = this.prefs();
    const root = document.documentElement;
    root.style.fontSize = { small: '14px', normal: '16px', large: '18px' }[p.ui] || '16px';
    root.classList.toggle('compact', !!p.compact);
    root.classList.toggle('no-motion', !p.motion);
    root.classList.toggle('noglass', !p.glass);
    root.classList.toggle('hicontrast', !!p.hiContrast);
    root.classList.toggle('bigtargets', !!p.bigTargets);
    root.dataset.font = p.font || 'system';
    root.dataset.wall = p.wall || 'default';
    root.dataset.wallStrength = p.wallStrength || 'normal';
  }

  volume() {
    return { low: 0.45, normal: 1, high: 1.8 }[this.prefs().volume] ?? 1;
  }

  prefTitle(page) {
    return {
      interface: this.t('Interface & effects', 'رابط و جلوه‌ها'),
      chats: this.t('Chats & wallpaper', 'گفتگوها و پس‌زمینه'),
      notifications: this.t('Notifications & sounds', 'اعلان‌ها و صدا'),
      accessibility: this.t('Accessibility', 'دسترس‌پذیری'),
      advanced: this.t('Advanced', 'پیشرفته'),
    }[page] || this.t('Settings', 'تنظیمات');
  }

  resetPrefs() {
    if (!confirm(this.t('Reset all interface and notification settings on this device?', 'همه‌ی تنظیمات رابط و اعلان‌ها روی این دستگاه بازنشانی شود؟'))) return;
    try { localStorage.removeItem('venteda_prefs'); } catch (e) { /* storage blocked */ }
    this.applyPrefs();
    this.showSettingsPage('advanced');
    this.showToast(this.t('Settings reset', 'تنظیمات بازنشانی شد'), 'success');
  }

  applyLowPower() {
    this.setPref('glass', false);
    this.setPref('motion', false);
    this.setPref('compact', true);
  }

  prefsPageHtml(page) {
    const p = this.prefs();
    const seg = (key, options) => `
      <div class="pref-seg">${options.map(([v, label]) => `
        <button data-on="${p[key] === v ? 1 : 0}" onclick="window.app.setPref('${key}', '${v}')">${label}</button>`).join('')}
      </div>`;
    const sw = (key, label, hint) => `
      <div class="pref-row">
        <div class="min-w-0"><p class="text-sm font-semibold text-slate-100">${label}</p>${hint ? `<p class="text-[11px] text-slate-400 mt-0.5">${hint}</p>` : ''}</div>
        <button class="pref-switch" data-on="${p[key] ? 1 : 0}" onclick="window.app.setPref('${key}', ${!p[key]})" aria-label="${label}"></button>
      </div>`;
    const row = (label, hint, control) => `
      <div class="pref-row">
        <div class="min-w-0"><p class="text-sm font-semibold text-slate-100">${label}</p>${hint ? `<p class="text-[11px] text-slate-400 mt-0.5">${hint}</p>` : ''}</div>
        ${control}
      </div>`;
    const card = html => `<div class="rounded-2xl overflow-hidden bg-white/[0.04] border border-white/[0.07] shadow-[0_10px_30px_-18px_rgba(0,0,0,.7)]">${html}</div>`;
    const head = text => `<p class="px-1 pt-3 first:pt-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">${text}</p>`;

    if (page === 'interface') {
      return `
        ${head(this.t('Text', 'متن'))}
        ${card(row(this.t('Text size', 'اندازه‌ی متن'), this.t('Applies to the whole app', 'روی کل برنامه اعمال می‌شود'), seg('ui', [['small', 'A-'], ['normal', 'A'], ['large', 'A+']]))
          + row(this.t('Font', 'فونت'), this.t('Latin and Persian text', 'متن لاتین و فارسی'), seg('font', [['system', this.t('System', 'سیستم')], ['inter', 'Inter'], ['vazir', 'Vazirmatn']])))}
        ${head(this.t('Layout & motion', 'چیدمان و حرکت'))}
        ${card(sw('compact', this.t('Compact chat list', 'لیست فشرده'), this.t('Shows more chats on screen', 'گفتگوهای بیشتری در صفحه'))
          + sw('motion', this.t('Animations', 'انیمیشن‌ها'), this.t('Turn off for a calmer, lighter interface', 'برای رابط آرام‌تر و سبک‌تر خاموش کنید')))}
        ${head(this.t('Performance', 'عملکرد'))}
        ${card(sw('glass', this.t('Glass effects', 'جلوه‌ی شیشه‌ای'), this.t('Turn off on older computers to save power', 'برای کامپیوترهای قدیمی‌تر خاموش کنید')))}`;
    }
    if (page === 'chats') {
      return `
        ${head(this.t('Wallpaper', 'پس‌زمینه‌ی چت'))}
        ${card(row(this.t('Pattern', 'الگو'), this.t('Behind your messages', 'پشت پیام‌ها'), seg('wall', [['default', this.t('Default', 'پیش‌فرض')], ['dots', this.t('Dots', 'نقطه')], ['grid', this.t('Grid', 'شبکه')], ['aurora', 'Aurora'], ['none', this.t('None', 'بدون')]]))
          + row(this.t('Strength', 'شدت'), this.t('How visible the pattern is', 'چقدر الگو دیده شود'), seg('wallStrength', [['subtle', this.t('Subtle', 'ملایم')], ['normal', this.t('Normal', 'معمولی')], ['strong', this.t('Strong', 'قوی')]])))}`;
    }
    if (page === 'notifications') {
      return `
        ${head(this.t('Alerts', 'هشدارها'))}
        ${card(sw('desktopNotif', this.t('Desktop notifications', 'اعلان دسکتاپ'), this.t('Show a notification when a chat you are not viewing gets a message', 'وقتی پیام در گفتگویی می‌رسد که باز نیست، اعلان نشان داده شود'))
          + sw('preview', this.t('Message preview', 'نمایش متن پیام'), this.t('Off hides the text and shows "New message"', 'خاموش: متن پیام مخفی و «پیام جدید» نشان داده می‌شود'))
          + sw('titleBadge', this.t('Count in browser title', 'عدد در عنوان تب'), this.t('Shows the number of unread messages', 'تعداد پیام‌های خوانده‌نشده را نشان می‌دهد')))}
        ${head(this.t('Sounds', 'صدا'))}
        ${card(sw('sendSound', this.t('Sound on send', 'صدا هنگام ارسال'), this.t('A short tick when you send a message', 'یک تیک کوتاه وقتی پیام می‌فرستید'))
          + sw('receiveSound', this.t('Sound on receive', 'صدا هنگام دریافت'), this.t('A chime when a new message arrives', 'صدای زنگ وقتی پیام جدید می‌رسد'))
          + row(this.t('Volume', 'بلندی صدا'), this.t('For message sounds', 'برای صدای پیام‌ها'), seg('volume', [['low', this.t('Low', 'کم')], ['normal', this.t('Normal', 'معمولی')], ['high', this.t('High', 'زیاد')]])))}
        ${head(this.t('Quiet', 'سکوت'))}
        ${card(sw('muteAll', this.t('Mute everything', 'بی‌صدا کردن همه'), this.t('No sounds and no notifications', 'هیچ صدا و اعلانی نباشد')))}`;
    }
    if (page === 'accessibility') {
      return `
        ${head(this.t('Vision', 'بینایی'))}
        ${card(sw('hiContrast', this.t('High contrast', 'کنتراست بالا'), this.t('Brighter text and clearer edges', 'متن روشن‌تر و لبه‌های واضح‌تر'))
          + sw('bigTargets', this.t('Larger buttons', 'دکمه‌های بزرگ‌تر'), this.t('Easier to tap and click', 'لمس و کلیک آسان‌تر')))}
        ${head(this.t('Motion', 'حرکت'))}
        ${card(sw('motion', this.t('Animations', 'انیمیشن‌ها'), this.t('Turn off to reduce motion', 'برای کاهش حرکت خاموش کنید')))}`;
    }
    return `
      ${head(this.t('Power', 'مصرف انرژی'))}
      ${card(`<div class="pref-row"><div class="min-w-0"><p class="text-sm font-semibold text-slate-100">${this.t('Low-power mode', 'حالت کم‌مصرف')}</p><p class="text-[11px] text-slate-400 mt-0.5">${this.t('Turns off glass, animations and enables compact lists', 'شیشه‌ای و انیمیشن‌ها را خاموش و لیست را فشرده می‌کند')}</p></div><button onclick="window.app.applyLowPower()" class="px-3 py-1.5 rounded-xl text-xs font-bold bg-gradient-to-r from-teal-300 to-violet-400 text-slate-950">${this.t('Enable', 'فعال کن')}</button></div>`)}
      ${head(this.t('Reset', 'بازنشانی'))}
      ${card(`<div class="pref-row"><div class="min-w-0"><p class="text-sm font-semibold text-rose-300">${this.t('Reset all settings', 'بازنشانی همه‌ی تنظیمات')}</p><p class="text-[11px] text-slate-400 mt-0.5">${this.t('Brings back the default look and sounds on this device', 'ظاهر و صدای پیش‌فرض را روی این دستگاه برمی‌گرداند')}</p></div><button onclick="window.app.resetPrefs()" class="px-3 py-1.5 rounded-xl text-xs font-bold border border-rose-400/40 text-rose-300">${this.t('Reset', 'بازنشانی')}</button></div>`)}`;
  }

  openNewChatModal() {
    document.getElementById('newChatModal')?.classList.remove('hidden');
  }

  closeNewChatModal() {
    document.getElementById('newChatModal')?.classList.add('hidden');
  }

  async handleVerifyNewChat(event) {
    event.preventDefault();
    const username = document.getElementById('newChatUsernameInput')?.value;
    const pin = document.getElementById('newChatPinInput')?.value;
    const errEl = document.getElementById('newChatError');
    const resultCard = document.getElementById('newChatFoundUser');
    if (errEl) errEl.classList.add('hidden');
    if (resultCard) resultCard.classList.add('hidden');

    try {
      const foundUser = await api.verifyConnect(username, pin);
      if (resultCard) {
        resultCard.classList.remove('hidden');
        document.getElementById('foundUserDisplayName').textContent = foundUser.display_name;
        document.getElementById('foundUserUsername').textContent = `@${foundUser.username}`;
        document.getElementById('foundUserInitial').textContent = (foundUser.display_name || 'U')[0].toUpperCase();
        this.verifiedTargetUser = foundUser;
      }
    } catch (e) {
      if (errEl) {
        errEl.textContent = e.message;
        errEl.classList.remove('hidden');
      }
    }
  }

  async handleSaveContactAndStartChat() {
    if (!this.verifiedTargetUser) return;
    try {
      const newConv = await api.createConversation('direct', null, this.verifiedTargetUser.id);
      this.closeNewChatModal();
      await this.loadConversations();
      this.selectConversation(newConv.id);
    } catch (e) {
      alert(e.message);
    }
  }

  openSettingsModal() {
    this.ensureSettingsPanel();
    this.setupSettingsBuckets();
    this.renderSettingsValues();
    const usernameField = document.getElementById('settingsUsernameInput');
    if (usernameField && this.currentUser) usernameField.value = this.currentUser.username || '';
    this.renderSettingsMain();
    this.showSettingsPage('main');
    const overlay = document.getElementById('tgSettingsOverlay');
    const panel = document.getElementById('tgSettingsPanel');
    if (!overlay || !panel) return;
    overlay.style.display = 'block';
    requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; });
  }

  closeSettingsModal() {
    this.returnSettingsSections();
    const overlay = document.getElementById('tgSettingsOverlay');
    const panel = document.getElementById('tgSettingsPanel');
    if (!overlay || !panel) return;
    panel.style.transform = 'translateX(100%)';
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
  }

  renderSettingsValues() {
    const codeEl = document.getElementById('settingsConnectPinVal');
    if (codeEl) codeEl.textContent = this.currentUser?.connect_code || '—';

    const dispInput = document.getElementById('settingsDisplayNameInput');
    if (dispInput) dispInput.value = this.currentUser?.display_name || '';

    const bioInput = document.getElementById('settingsBioInput');
    if (bioInput) bioInput.value = this.currentUser?.bio || '';

    const userDisp = document.getElementById('settingsUsernameDisplay');
    if (userDisp) userDisp.textContent = `@${this.currentUser?.username || 'user'}`;

    // Update avatar preview
    const previewEl = document.getElementById('settingsAvatarPreview');
    const removeBtn = document.getElementById('settingsRemoveAvatarBtn');
    if (this.currentUser?.avatar_url) {
      if (previewEl) {
        previewEl.innerHTML = `<img src="${this.currentUser.avatar_url}" class="w-full h-full object-cover" alt="avatar" />`;
      }
      if (removeBtn) removeBtn.classList.remove('hidden');
    } else {
      if (previewEl) {
        previewEl.innerHTML = `<span id="settingsAvatarInitial">${(this.currentUser?.display_name || 'U')[0].toUpperCase()}</span>`;
      }
      if (removeBtn) removeBtn.classList.add('hidden');
    }

    // Update active theme buttons in settings
    this.updateThemeButtonsUI();

    // Sessions
    const sessionsList = document.getElementById('settingsSessionsList');
    if (sessionsList) {
      sessionsList.innerHTML = `
        <div class="p-3 bg-slate-50 dark:bg-[#152236] rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <strong class="block text-slate-800 dark:text-white">Desktop Web (Current Session)</strong>
            <span class="text-[10px] text-slate-400 font-mono">Chrome / Firefox · IP: 127.0.0.1 · Active now</span>
          </div>
          <span class="px-2 py-0.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 text-[10px] font-bold rounded">Current</span>
        </div>
      `;
    }
  }

  async handleAvatarFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file (PNG, JPG, WebP).');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert('File size exceeds 5MB limit.');
      return;
    }

    try {
      this.showToast(false ? 'در حال بارگذاری عکس...' : 'Uploading avatar image...');
      const updatedUser = await api.uploadAvatar(file);
      this.currentUser = updatedUser;
      this.renderSettingsValues();
      this.renderUserProfileHeader();
      this.renderConversationList();
      if (this.selectedConvId) this.renderChatHeader();
      this.showToast(false ? 'عکس پروفایل ذخیره شد!' : 'Avatar updated successfully!');
      event.target.value = '';
    } catch (e) {
      alert('Failed to upload avatar: ' + e.message);
    }
  }

  async handleRemoveAvatar() {
    if (!confirm(false ? 'آیا عکس پروفایل حذف شود؟' : 'Remove your custom avatar?')) return;
    try {
      const updatedUser = await api.removeAvatar();
      this.currentUser = updatedUser;
      this.renderSettingsValues();
      this.renderUserProfileHeader();
      this.renderConversationList();
      if (this.selectedConvId) this.renderChatHeader();
      this.showToast(false ? 'عکس پروفایل حذف شد' : 'Avatar removed.');
    } catch (e) {
      alert('Failed to remove avatar: ' + e.message);
    }
  }

  async setAvatarPreset(name) {
    const presets = {
      sapphire: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%2338bdf8"/><stop offset="100%" stop-color="%231d4ed8"/></linearGradient></defs><rect width="128" height="128" rx="36" fill="url(%23g)"/><polygon points="64,34 96,94 32,94" fill="%23ffffff" opacity="0.9"/></svg>',
      emerald: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%2334d399"/><stop offset="100%" stop-color="%23047857"/></linearGradient></defs><rect width="128" height="128" rx="36" fill="url(%23g)"/><circle cx="64" cy="64" r="32" fill="%23ffffff" opacity="0.9"/></svg>',
      amethyst: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23c084fc"/><stop offset="100%" stop-color="%236b21a8"/></linearGradient></defs><rect width="128" height="128" rx="36" fill="url(%23g)"/><rect x="36" y="36" width="56" height="56" rx="16" fill="%23ffffff" opacity="0.9"/></svg>',
      amber: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23fbbf24"/><stop offset="100%" stop-color="%23b45309"/></linearGradient></defs><rect width="128" height="128" rx="36" fill="url(%23g)"/><polygon points="64,30 98,64 64,98 30,64" fill="%23ffffff" opacity="0.9"/></svg>',
      cyber: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23ec4899"/><stop offset="50%" stop-color="%233b82f6"/><stop offset="100%" stop-color="%2306b6d4"/></linearGradient></defs><rect width="128" height="128" rx="36" fill="url(%23g)"/><polygon points="64,28 96,64 64,100 32,64" fill="%23ffffff" opacity="0.9"/></svg>',
      monochrome: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%2394a3b8"/><stop offset="100%" stop-color="%230f172a"/></linearGradient></defs><rect width="128" height="128" rx="36" fill="url(%23g)"/><circle cx="64" cy="64" r="30" fill="%23ffffff" opacity="0.85"/></svg>'
    };
    const avatarUrl = presets[name];
    if (!avatarUrl) return;
    try {
      const updated = await api.updateMe({ avatar_url: avatarUrl });
      this.currentUser = updated;
      this.renderSettingsValues();
      this.renderUserProfileHeader();
      this.renderConversationList();
      if (this.selectedConvId) this.renderChatHeader();
      this.showToast(false ? 'آواتار انتخاب شد!' : 'Avatar preset applied!');
    } catch (e) {
      alert('Failed to set preset avatar: ' + e.message);
    }
  }

  async handleRegenerateConnectPin() {
    if (!confirm('Regenerate your private Connect PIN? Strangers will need your new PIN to add you.')) return;
    try {
      const updated = await api.regenerateConnectCode();
      this.currentUser = { ...this.currentUser, ...updated };
      this.renderSettingsValues();
      this.renderUserProfileHeader();
      this.showToast('Connect PIN regenerated: ' + updated.connect_code);
    } catch (e) {
      alert(e.message);
    }
  }

  async handleSaveProfile() {
    const disp = document.getElementById('settingsDisplayNameInput')?.value.trim();
    const bio = document.getElementById('settingsBioInput')?.value.trim();
    const username = (document.getElementById('settingsUsernameInput')?.value || '').trim().replace(/^@/, '');
    if (username && !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      alert(this.t('Username must be 3 to 32 letters, digits or underscores.', 'نام کاربری باید ۳ تا ۳۲ حرف، عدد یا _ باشد.'));
      return;
    }
    const payload = { display_name: disp, bio: bio };
    if (username) payload.username = username;
    try {
      const updated = await api.updateMe(payload);
      this.currentUser = { ...this.currentUser, ...updated };
      this.renderUserProfileHeader();
      this.renderStoriesBar().catch(() => {});
      this.showToast(false ? 'پروفایل با موفقیت ذخیره شد!' : 'Profile updated successfully!');
    } catch (e) {
      alert(e.message);
    }
  }

  openReportModal(msgId) {
    const modal = document.getElementById('reportModal');
    if (!modal) return;
    this.reportingMessageId = msgId;
    modal.classList.remove('hidden');
  }

  closeReportModal() {
    document.getElementById('reportModal')?.classList.add('hidden');
  }

  async handleSubmitReport(event) {
    event.preventDefault();
    const reason = document.querySelector('input[name="reportReason"]:checked')?.value || 'spam';
    const desc = document.getElementById('reportDescriptionInput')?.value || '';
    const msg = this.messages.find(m => m.id === this.reportingMessageId);

    if (!msg) return;

    try {
      await api.submitReport({
        reported_user_id: msg.sender_id,
        conversation_id: this.selectedConvId,
        message_id: msg.id,
        message_snippet: msg.text ? msg.text.slice(0, 100) : '',
        reason_category: reason,
        description: desc
      });
      this.closeReportModal();
      this.showToast('Report submitted for moderation review.');
    } catch (e) {
      alert('Failed to submit report: ' + e.message);
    }
  }

  async openForwardModal(msgId) {
    const msg = this.messages.find(m => m.id === msgId);
    if (!msg) return;
    this.forwardingMessage = msg;
    const modal = document.getElementById('forwardModal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const list = document.getElementById('forwardConvList');
    if (!list) return;

    let savedConv = this.conversations.find(c => c.type === 'saved');
    if (!savedConv) {
      try {
        savedConv = await api.getSavedConversation();
      } catch {}
    }

    const savedTitle = false ? 'پیام‌های ذخیره‌شده (فضای ابری)' : 'Saved Messages (Cloud Notebook)';
    
    let html = `
      <div onclick="window.app.executeForward('${savedConv ? savedConv.id : 'saved_auto'}')" class="p-2.5 rounded-xl bg-blue-50/70 hover:bg-blue-100/80 dark:bg-sky-950/40 dark:hover:bg-sky-900/50 border border-blue-200/60 dark:border-cyan-500/30 flex items-center justify-between cursor-pointer transition-all">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-xs shrink-0">
            ${icons.bookmark('w-4 h-4')}
          </div>
          <div>
            <span class="font-bold text-xs text-blue-900 dark:text-cyan-200">${savedTitle}</span>
            <span class="block text-[10px] text-blue-600 dark:text-cyan-400 font-mono">Personal Cloud Storage</span>
          </div>
        </div>
        <span class="text-xs text-blue-600 dark:text-cyan-400 font-bold inline-flex items-center gap-1">${icons.forward('w-3.5 h-3.5')}</span>
      </div>
    `;

    const otherConvs = this.conversations.filter(c => c.type !== 'saved');
    html += otherConvs.map(c => `
      <div onclick="window.app.executeForward('${c.id}')" class="p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between cursor-pointer border border-transparent transition-all">
        <div class="flex items-center gap-2 min-w-0">
          <div class="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 flex items-center justify-center font-bold text-xs shrink-0">
            ${c.type === 'group' ? icons.users('w-3.5 h-3.5') : (c.title || 'U')[0].toUpperCase()}
          </div>
          <span class="font-semibold text-xs text-slate-800 dark:text-white truncate">${this.escapeHtml(c.title || 'Chat')}</span>
        </div>
        <span class="text-xs text-slate-400 hover:text-blue-600 font-bold inline-flex items-center gap-1">${icons.forward('w-3.5 h-3.5')}</span>
      </div>
    `).join('');

    list.innerHTML = html;
  }

  async executeForward(targetConvId) {
    if (!this.forwardingMessage) return;
    try {
      let realTargetId = targetConvId;
      if (targetConvId === 'saved_auto') {
        const saved = await api.getSavedConversation();
        realTargetId = saved.id;
      }

      await api.sendMessage(
        realTargetId,
        this.forwardingMessage.text,
        null,
        null,
        this.forwardingMessage.sender_id
      );
      document.getElementById('forwardModal')?.classList.add('hidden');
      this.forwardingMessage = null;
      this.showToast(false ? 'پیام فوروارد شد!' : 'Message forwarded successfully!');
    } catch (e) {
      alert(e.message);
    }
  }

  async exportData() {
    const dump = {
      user: this.currentUser,
      conversations: this.conversations,
      exported_at: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `venteda_export_${this.currentUser?.username || 'user'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  logout() {
    api.clearToken();
    window.location.reload();
  }

  // -------------------------------------------------------------
  // Header / UI Helpers
  // -------------------------------------------------------------
  renderUserProfileHeader() {
    const nameEl = document.getElementById('sidebarUserDisplayName');
    const userEl = document.getElementById('sidebarUsername');
    const pinEl = document.getElementById('sidebarConnectPin');
    const initEl = document.getElementById('sidebarUserInitial');

    if (nameEl) nameEl.textContent = this.currentUser?.display_name || 'User';
    if (userEl) userEl.textContent = `@${this.currentUser?.username || 'user'}`;
    if (pinEl) pinEl.textContent = `PIN: ${this.currentUser?.connect_code || '—'}`;
    if (initEl) {
      if (this.currentUser?.avatar_url) {
        initEl.innerHTML = `<img src="${this.currentUser.avatar_url}" class="w-full h-full object-cover rounded-xl" alt="avatar" />`;
      } else {
        initEl.textContent = (this.currentUser?.display_name || 'U')[0].toUpperCase();
      }
    }
  }

  renderAdminNavButton() {
    const btn = document.getElementById('adminPortalNavBtn');
    if (!btn) return;
    const isStaff = ['owner', 'moderator', 'support'].includes(this.currentUser?.role);
    if (isStaff) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  showToast(text, kind = 'info') {
    const colors = {
      info: 'from-blue-600 to-sky-500',
      success: 'from-emerald-500 to-teal-400',
      error: 'from-rose-600 to-orange-500',
    };
    const toast = document.createElement('div');
    toast.className = `toast-glass fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 px-4 py-2.5 rounded-2xl text-white text-xs font-semibold shadow-2xl bg-gradient-to-r ${colors[kind] || colors.info}`;
    const dot = document.createElement('span');
    dot.className = 'w-1.5 h-1.5 rounded-full bg-white/90 shrink-0';
    const label = document.createElement('span');
    label.textContent = text;
    toast.append(dot, label);
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 300);
    }, 2600);
  }

  scrollToBottom() {
    const container = document.getElementById('chatMessagesScroll');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  formatTimeShort(dateStr) {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  formatMessageText(text) {
    if (!text) return '';
    // Escape html then highlight links
    const escaped = this.escapeHtml(text);
    return escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="underline text-blue-500 hover:text-blue-400">$1</a>');
  }

  // -------------------------------------------------------------
  // Global Event Binding
  // -------------------------------------------------------------
  bindEvents() {
    this.applyPrefs();
    // Send sound: wrap the existing send handler (only when there is text to send)
    const sendOriginal = this.handleSendMessage.bind(this);
    this.handleSendMessage = async () => {
      const text = document.getElementById('chatInputText')?.value.trim();
      if (text) this.playSound('send');
      return sendOriginal();
    };
    // Ask for Windows / browser notification permission on the first click (required by browsers)
    document.addEventListener('click', () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default' && this.prefs().desktopNotif !== false) {
        Notification.requestPermission().catch(() => {});
      }
    }, { once: true });
    // Ripple wave on every button press (pure visual feedback)
    document.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled || btn.classList.contains('absolute') || btn.classList.contains('fixed')) return;
      const rect = btn.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const wave = document.createElement('span');
      wave.className = 'ripple-wave';
      wave.style.width = `${size}px`;
      wave.style.height = `${size}px`;
      wave.style.left = `${e.clientX - rect.left - size / 2}px`;
      wave.style.top = `${e.clientY - rect.top - size / 2}px`;
      btn.appendChild(wave);
      setTimeout(() => wave.remove(), 650);
    }, { passive: true });

    // Stories and lightbox: move overlays under <body> with inline positioning
    ['storyViewer', 'lightbox', 'storyComposer', 'storyViewersSheet'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.parentElement !== document.body) document.body.appendChild(el);
      Object.assign(el.style, { position: 'fixed', top: '0', right: '0', bottom: '0', left: '0' });
    });
    setInterval(() => this.renderStoriesBar().catch(() => {}), 60000);

    // Read receipts: mark as read only when the chat is really on screen
    document.addEventListener('visibilitychange', () => this.maybeMarkRead());
    window.addEventListener('focus', () => this.maybeMarkRead());
    document.getElementById('chatMessagesScroll')?.addEventListener('scroll', () => this.maybeMarkRead());

    // Open a profile by clicking a sender name in a chat
    document.getElementById('chatMessagesScroll')?.addEventListener('click', (e) => {
      const el = e.target.closest('[data-profile-uid]');
      if (el) this.openProfile(el.dataset.profileUid);
    });
    // Open profile (direct) or group info (group) from the chat header
    ['chatTitleHeader', 'chatAvatarInitial'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => (id === 'chatAvatarInitial' ? this.onHeaderAvatarTap() : this.openChatInfo()));
      }
    });
    // Keep the header avatar's story ring in sync whenever the header is rendered
    const renderHeader = this.renderChatHeader.bind(this);
    this.renderChatHeader = () => { renderHeader(); this.decorateHeaderAvatar(); };
    // Member rows inside the profile / group modal
    document.getElementById('profileModalBody')?.addEventListener('click', (e) => {
      const el = e.target.closest('[data-profile-uid]');
      if (el) this.openProfile(el.dataset.profileUid);
    });

    // Auth Form
    document.getElementById('authForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const isReg = document.getElementById('authModeInput')?.value === 'register';
      const userVal = document.getElementById('authUsername')?.value;
      const passVal = document.getElementById('authPassword')?.value;
      const nameVal = document.getElementById('authDisplayName')?.value;
      const errEl = document.getElementById('authError');
      if (errEl) errEl.classList.add('hidden');

      if (isReg) {
        const problems = [];
        if ((userVal || '').trim().length < 3) problems.push('Username must be at least 3 characters.');
        if ((nameVal || '').trim().length < 1) problems.push('Display name is required.');
        if ((passVal || '').length < 8) problems.push('Password must be at least 8 characters.');
        if (problems.length) {
          if (errEl) {
            errEl.textContent = problems.join(' ');
            errEl.classList.remove('hidden');
          }
          return;
        }
      }

      try {
        if (isReg) {
          await api.register(userVal, nameVal, passVal);
        } else {
          await api.login(userVal, passVal);
        }
        window.location.reload();
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message;
          errEl.classList.remove('hidden');
        }
      }
    });

    // Chat Composer Keyboard Send
    document.getElementById('chatInputText')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && this.userSettings.enter_is_send) {
        e.preventDefault();
        this.handleSendMessage();
      }
    });

    // Typing broadcast
    document.getElementById('chatInputText')?.addEventListener('input', () => {
      if (this.selectedConvId) {
        this.sendWebSocket({
          action: 'typing',
          conversation_id: this.selectedConvId,
          data: { is_typing: true }
        });
        clearTimeout(this.typingTimer);
        this.typingTimer = setTimeout(() => {
          this.sendWebSocket({
            action: 'typing',
            conversation_id: this.selectedConvId,
            data: { is_typing: false }
          });
        }, 2000);
      }
    });

    // Resize handler for responsive mobile view
    window.addEventListener('resize', () => {
      this.setMobileView(this.mobileView);
    });
  }
}

// Global bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new VentedaApp();
  window.app.init();
});
