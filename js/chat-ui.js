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
    this.visualViewportBound = false;
    this._visualViewport = null;
    this._lastViewportHeight = undefined;
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
    this.bindVisualViewport();
    this.applyStatus(this.chat?.status ?? CHAT_STATUS.noRoom);
    this.applyUnread(this.chat?.unreadCount ?? 0);
    this.applyMessages(this.chat?.messages ?? []);
    this.updateSendButtons();
  }

  detachChat() {
    this.detachVisualViewport();
    for (const off of this.unsubs.splice(0)) off?.();
    this.chat = null;
  }

  /**
   * The Visual Viewport API fires when the on-screen keyboard opens or closes
   * on mobile. We use it to keep the chat input row visible and to scroll new
   * messages into view.
   *
   * Browsers that do not expose visualViewport (some desktop contexts) fall
   * back to window resize / orientationchange, which is good enough there.
   */
  bindVisualViewport() {
    this.detachVisualViewport();
    if (typeof window === 'undefined' || !window.visualViewport) {
      this.visualViewportBound = false;
      return;
    }
    this.visualViewportBound = true;
    const vp = window.visualViewport;
    this._visualViewport = vp;
    vp.addEventListener('resize', this.onVisualViewportChange);
    vp.addEventListener('scroll', this.onVisualViewportChange);
    window.addEventListener('resize', this.onVisualViewportChange);
    window.addEventListener('orientationchange', this.onVisualViewportChange);
    this.onVisualViewportChange();
  }

  detachVisualViewport() {
    if (!this.visualViewportBound) return;
    this.visualViewportBound = false;
    const vp = this._visualViewport;
    if (vp) {
      vp.removeEventListener('resize', this.onVisualViewportChange);
      vp.removeEventListener('scroll', this.onVisualViewportChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onVisualViewportChange);
      window.removeEventListener('orientationchange', this.onVisualViewportChange);
    }
    this._visualViewport = null;
  }

  /**
   * Called on visualViewport resize / scroll and on window resize /
   * orientationchange.
   *
   * - Keep the mobile chat panel sized to the visual viewport so the input
   *   row stays above the keyboard.
   * - Scroll the message list to the bottom when the viewport height changes
   *   by more than a small threshold (keyboard open / close), but only if the
   *   user was already near the bottom.
   */
  onVisualViewportChange = () => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      this.adjustPanelForViewport();
      return;
    }
    this.adjustPanelForViewport();
    this.maybeScrollToBottomOnViewportChange();
  };

  /**
   * Sizes the mobile chat panel to the visual viewport height (minus a small
   * margin) so the input row is never covered by the on-screen keyboard.
   *
   * Uses visualViewport.height when available (it accounts for the keyboard),
   * falling back to window.innerHeight. On browsers whose CSS vh units do not
   * update promptly when the keyboard opens, this is the primary mechanism.
   */
  adjustPanelForViewport() {
    const panel = this.elements.chatMobilePanel;
    if (!panel || panel.hidden) return;
    const vp = window.visualViewport;
    const viewportHeight = vp ? vp.height : window.innerHeight;
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;
    const margin = 8;
    const targetHeight = viewportHeight - margin;
    const current = panel.offsetHeight;
    if (Math.abs(current - targetHeight) > 2) {
      panel.style.height = `${targetHeight}px`;
      panel.style.maxHeight = `${targetHeight}px`;
    }
  }

  /**
   * When the keyboard opens or closes, the viewport height changes abruptly.
   * If the user was already scrolled to the bottom, scroll them to the new
   * bottom so the latest messages remain visible.
   */
  maybeScrollToBottomOnViewportChange() {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vp = window.visualViewport;
    const currentHeight = vp.height;
    const prevHeight = this._lastViewportHeight;
    this._lastViewportHeight = currentHeight;
    if (prevHeight === undefined) return;
    const delta = Math.abs(currentHeight - prevHeight);
    if (delta < 48) return;
    const messagesEl = this.elements.chatMobileMessages;
    if (!messagesEl) return;
    if (this.isNearBottom(messagesEl, 80)) {
      requestAnimationFrame(() => this.scrollToBottom(messagesEl));
    }
  };

  /**
   * Scroll the mobile message list to the bottom when a new message arrives,
   * but only if the user is already near the bottom.
   */
  scrollToBottomOnNewMessage() {
    const messagesEl = this.elements.chatMobileMessages;
    if (!messagesEl) return;
    if (this.isNearBottom(messagesEl, 48)) {
      requestAnimationFrame(() => this.scrollToBottom(messagesEl));
    }
  };

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
    // When new messages arrive while the mobile sheet is open, scroll to keep
    // the latest visible if the user was already near the bottom.
    this.scrollToBottomOnNewMessage();
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
    // Defer focus and viewport adjustment so the browser has laid out the
    // panel first; this avoids scroll jitter when the keyboard opens.
    requestAnimationFrame(() => {
      this.elements.chatMobileInput?.focus();
      this.adjustPanelForViewport();
    });
  }

  closeMobileChat() {
    const panel = this.elements.chatMobilePanel;
    if (!panel || !this.mobileOpen) return;
    this.mobileOpen = false;
    panel.hidden = true;
    // Reset any inline height/maxHeight so the CSS (dvh-based) takes over
    // again when the panel is next shown.
    panel.style.height = '';
    panel.style.maxHeight = '';
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
