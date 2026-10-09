/**
 * chat-ui.js — renders the multiplayer chat: a side panel next to the board on
 * desktop and a bottom sheet on mobile. It owns no game state; it renders what
 * ChatClient emits, forwards sends, and never lets focus or keys leak into the
 * Sudoku board (the Sudoku keyboard handler already ignores INPUT targets).
 */

import { CHAT_STATUS, CHAT_MAX_LENGTH } from './chat.js';

const STATUS_LABELS = {
  [CHAT_STATUS.noRoom]: 'Chat unavailable',
  [CHAT_STATUS.connected]: '', // steady state — no banner needed
  [CHAT_STATUS.reconnecting]: 'Chat unavailable — reconnecting…',
  [CHAT_STATUS.disconnected]: 'Chat unavailable — offline',
  [CHAT_STATUS.closed]: 'Chat unavailable — this game has ended.',
};

export class ChatUI {
  constructor({ ui, elements }) {
    this.ui = ui;
    this.elements = elements;
    this.chat = null;
    this.mobileOpen = false;
    this.unsubs = [];
    this.domBound = false;
    // Per-container scroll bookkeeping: { stuck, cueCount, count, cue }
    this.scrollState = new WeakMap();
  }

  /* ---------------------------- lifecycle --------------------------- */

  setChat(chat) {
    this.detachChat();
    this.chat = chat || null;
    if (this.chat) {
      this.chat.isVisible = () => this.isPanelVisible();
      this.unsubs = [
        this.chat.on('status-change', ({ status }) => this.applyStatus(status)),
        this.chat.on('messages', ({ messages }) => this.applyMessages(messages)),
        this.chat.on('unread', ({ count }) => this.applyUnread(count)),
        this.chat.on('chat-error', (error) => this.onChatError(error)),
      ];
    }
    this.bindDom();
    this.applyStatus(this.chat?.status ?? CHAT_STATUS.noRoom);
    this.applyUnread(this.chat?.unreadCount ?? 0);
    this.applyMessages(this.chat?.messages ?? []);
    this.updateSendButtons();
  }

  detachChat() {
    for (const off of this.unsubs.splice(0)) off?.();
    this.chat = null;
  }

  /** DOM wiring happens once; handlers tolerate a missing chat client. */
  bindDom() {
    if (this.domBound) return;
    this.domBound = true;
    const el = this.elements;

    el.chatInput?.addEventListener('input', () => this.updateSendButtons());
    el.chatInput?.addEventListener('keydown', (event) => this.onInputKeydown(event, el.chatInput));
    el.chatSend?.addEventListener('click', () => this.sendFrom(el.chatInput));

    el.chatMobileInput?.addEventListener('input', () => this.updateSendButtons());
    el.chatMobileInput?.addEventListener('keydown', (event) => this.onInputKeydown(event, el.chatMobileInput));
    el.chatMobileSend?.addEventListener('click', () => this.sendFrom(el.chatMobileInput));

    el.chatMessages?.addEventListener('scroll', () => this.onScroll(el.chatMessages));
    el.chatMobileMessages?.addEventListener('scroll', () => this.onScroll(el.chatMobileMessages));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.mobileOpen) this.closeMobileChat();
    });
  }

  /* ----------------------------- status ----------------------------- */

  applyStatus(status) {
    const label = STATUS_LABELS[status] ?? STATUS_LABELS[CHAT_STATUS.noRoom];
    const degraded = status !== CHAT_STATUS.connected;
    const desktop = this.elements.chatStatus;
    if (desktop) {
      desktop.textContent = label;
      desktop.hidden = !degraded;
    }
    const mobile = this.elements.chatMobileStatus;
    if (mobile) {
      mobile.textContent = label;
      mobile.hidden = !degraded;
    }
    this.updateSendButtons();
  }

  /* ----------------------------- unread ----------------------------- */

  applyUnread(count) {
    const badge = this.elements.chatBadge;
    if (!badge) return;
    badge.hidden = !(count > 0);
    badge.textContent = count > 9 ? '9+' : count > 0 ? String(count) : '';
  }

  /* ---------------------------- messages ---------------------------- */

  messagesLength() {
    return this.chat?.messages?.length ?? 0;
  }

  applyMessages(messages) {
    this.renderContainer(this.elements.chatMessages);
    this.renderContainer(this.elements.chatMobileMessages);
  }

  renderContainer(container) {
    if (!container) return;
    const state = this.scrollStateFor(container);
    const nearBottom = this.isNearBottom(container);
    const grew = Math.max(0, this.messagesLength() - (state.count || 0));
    state.count = this.messagesLength();

    const fragment = document.createDocumentFragment();
    for (const message of this.chat?.messages ?? []) {
      fragment.appendChild(this.createMessageElement(message));
    }
    container.replaceChildren(fragment);
    container.appendChild(this.cueFor(container));

    if (nearBottom) {
      state.cueCount = 0;
      this.scrollToBottom(container);
    } else if (grew) {
      state.cueCount += grew;
    }
    this.updateCue(container);
  }

  createMessageElement(message) {
    const node = document.createElement('div');
    if (message.type === 'system') {
      node.className = 'chat-system';
      node.textContent = message.text;
      return node;
    }
    const isMine = Boolean(message.playerId) && message.playerId === this.chat?.client?.playerId;
    node.className = `chat-msg${isMine ? ' is-mine' : ''}`;

    const body = document.createElement('div');
    body.className = 'chat-msg-body';

    if (!isMine) {
      const name = document.createElement('div');
      name.className = 'chat-msg-name';
      name.textContent = message.playerName;
      body.appendChild(name);
    }

    // textContent only — server-supplied text is never interpreted as HTML.
    const text = document.createElement('div');
    text.className = 'chat-msg-text';
    text.textContent = message.message;
    body.appendChild(text);

    const ts = document.createElement('div');
    ts.className = 'chat-msg-ts';
    ts.textContent = formatChatTime(message.timestamp);
    body.appendChild(ts);

    node.appendChild(body);
    return node;
  }

  /* --------------------------- auto-scroll -------------------------- */

  scrollStateFor(container) {
    let state = this.scrollState.get(container);
    if (!state) {
      state = { stuck: false, cueCount: 0, count: 0, cue: null };
      this.scrollState.set(container, state);
    }
    return state;
  }

  cueFor(container) {
    const state = this.scrollStateFor(container);
    if (!state.cue) {
      const cue = document.createElement('button');
      cue.type = 'button';
      cue.className = 'chat-new-cue';
      cue.hidden = true;
      cue.addEventListener('click', () => this.scrollToBottom(container));
      state.cue = cue;
    }
    return state.cue;
  }

  isNearBottom(container, threshold = 48) {
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight === 0) return true;
    return scrollHeight - scrollTop - clientHeight <= threshold;
  }

  scrollToBottom(container) {
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    const state = this.scrollStateFor(container);
    state.cueCount = 0;
    this.updateCue(container);
  }

  /** The user scrolled away from the newest message — stop forcing them down. */
  onScroll(container) {
    const state = this.scrollStateFor(container);
    state.stuck = !this.isNearBottom(container);
    if (!state.stuck) state.cueCount = 0;
    this.updateCue(container);
  }

  updateCue(container) {
    const state = this.scrollStateFor(container);
    const cue = state.cue;
    if (!cue) return;
    const show = state.cueCount > 0 && !this.isNearBottom(container);
    cue.hidden = !show;
    if (show) {
      cue.textContent = `↓ ${state.cueCount} new message${state.cueCount === 1 ? '' : 's'}`;
    }
  }

  /* ------------------------- open / close (mobile) ------------------ */

  openMobileChat() {
    const panel = this.elements.chatMobilePanel;
    if (!panel || this.mobileOpen) return;
    this.mobileOpen = true;
    panel.hidden = false;
    this.chat?.clearUnread();
    this.applyUnread(0);
    this.updateSendButtons();
    this.renderContainer(this.elements.chatMobileMessages);
    this.ui?.announce('Chat opened');
    requestAnimationFrame(() => this.elements.chatMobileInput?.focus());
  }

  closeMobileChat() {
    const panel = this.elements.chatMobilePanel;
    if (!panel || !this.mobileOpen) return;
    this.mobileOpen = false;
    panel.hidden = true;
    this.elements.chatMobileInput?.blur();
    this.updateSendButtons();
    this.ui?.announce('Chat closed');
  }

  isPanelVisible() {
    if (this.mobileOpen) return true;
    const panel = this.elements.chatPanel;
    if (!panel || panel.hidden) return false;
    // The side panel is only actually on screen at desktop widths.
    return typeof window === 'undefined' || window.matchMedia('(min-width: 760px)').matches;
  }

  /* ----------------------------- sending ---------------------------- */

  onInputKeydown(event, input) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      this.sendFrom(input);
    }
  }

  sendFrom(input) {
    if (!this.chat || !input) return;
    const value = input.value;
    const result = this.chat.send(value);
    if (result.ok) {
      this.lastAttempt = { input, value };
      input.value = '';
      this.updateSendButtons();
      input.focus();
      return;
    }
    if (result.reason === 'empty') {
      input.value = '';
      this.updateSendButtons();
      return;
    }
    if (result.reason === 'too-long') {
      this.ui?.showToast(`Message too long — ${CHAT_MAX_LENGTH} characters max`);
      return;
    }
    this.ui?.showToast('Chat is unavailable right now');
  }

  /** Server rejected a message we optimistically cleared — give it back. */
  onChatError(error) {
    const code = error?.code;
    if (code === 'CHAT_RATE_LIMITED' || code === 'INVALID_MESSAGE') {
      if (this.lastAttempt) {
        this.lastAttempt.input.value = this.lastAttempt.value;
        this.lastAttempt.input.focus();
        this.updateSendButtons();
      }
    }
    if (error?.message) this.ui?.showToast(error.message, 2600);
  }

  updateSendButtons() {
    const live =
      Boolean(this.chat) &&
      Boolean(this.chat?.client?.connected) &&
      this.chat?.status !== CHAT_STATUS.closed;
    const dead = this.chat && (this.chat.status === CHAT_STATUS.closed || this.chat.status === CHAT_STATUS.noRoom);

    const pairs = [
      [this.elements.chatInput, this.elements.chatSend],
      [this.elements.chatMobileInput, this.elements.chatMobileSend],
    ];
    for (const [input, button] of pairs) {
      if (!input || !button) continue;
      const value = (input.value || '').trim();
      // Closed or no room: the input itself goes dark. Merely offline: typing
      // stays possible, sending waits for the connection.
      input.disabled = Boolean(dead);
      button.disabled = !live || !value;
    }
  }
}

/* ----------------------------- helpers ------------------------------ */

function formatChatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}
