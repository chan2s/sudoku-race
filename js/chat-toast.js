/**
 * chat-toast.js — a lightweight, reusable "new chat message" notification.
 *
 * It renders into its own reserved strip above the Sudoku board (a real grid
 * row, not an overlay), so it can never cover the grid, number pad or player
 * cards. Only one toast is shown at a time: rapid messages update the same
 * preview and bump a "N new" counter instead of stacking without bound.
 *
 * The component is presentation-only; app.js decides *when* a toast is needed
 * (opponent messages, chat closed, in a race) and passes an `onOpen` callback.
 */

const DEFAULT_DURATION_MS = 4000; // within the required 3–4 second window
const MAX_NAME_LENGTH = 40;
const MAX_PREVIEW_LENGTH = 90;

export class ChatToast {
  constructor({ container, onOpen = null, durationMs = DEFAULT_DURATION_MS } = {}) {
    this.container = container || null;
    this.onOpen = typeof onOpen === 'function' ? onOpen : null;
    this.durationMs = Number(durationMs) > 0 ? Number(durationMs) : DEFAULT_DURATION_MS;
    this.timer = null;
    this.count = 0;
    this.node = null;
    this.textEl = null;
    this.nameEl = null;
    this.countEl = null;
    this.bound = false;
  }

  /** Shows (or updates) the single toast slot. */
  show({ name, text } = {}) {
    if (!this.container) return;
    const cleanName = String(name ?? 'Opponent').trim().slice(0, MAX_NAME_LENGTH) || 'Opponent';
    const cleanText = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleanText) return;

    this.count = this.node ? this.count + 1 : 1;
    this.ensureNode();
    this.nameEl.textContent = cleanName;
    this.textEl.textContent =
      cleanText.length > MAX_PREVIEW_LENGTH ? `${cleanText.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : cleanText;
    this.countEl.hidden = this.count < 2;
    this.countEl.textContent = this.count >= 2 ? `+${this.count - 1}` : '';
    this.node.setAttribute('aria-label', `New message from ${cleanName}. Open chat.`);

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dismiss(), this.durationMs);
  }

  /** Removes the toast immediately (manual dismiss, leave room, teardown). */
  dismiss() {
    clearTimeout(this.timer);
    this.timer = null;
    this.count = 0;
    this.node = null;
    this.nameEl = null;
    this.textEl = null;
    this.countEl = null;
    this.container?.replaceChildren();
  }

  destroy() {
    this.dismiss();
    this.container = null;
    this.onOpen = null;
  }

  /* ------------------------------ internals ------------------------------ */

  ensureNode() {
    if (this.node && this.container?.contains(this.node)) return;
    const node = document.createElement('div');
    node.className = 'chat-toast';
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');

    const icon = document.createElement('span');
    icon.className = 'chat-toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '💬';

    const body = document.createElement('span');
    body.className = 'chat-toast-body';

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-toast-name';

    const textEl = document.createElement('span');
    textEl.className = 'chat-toast-text';

    body.append(nameEl, textEl);

    const countEl = document.createElement('span');
    countEl.className = 'chat-toast-count';
    countEl.hidden = true;

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'chat-toast-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', (event) => {
      event.stopPropagation();
      this.dismiss();
    });

    node.append(icon, body, countEl, dismiss);

    const open = () => this.onOpen?.();
    node.addEventListener('click', open);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });

    if (!this.bound) this.bound = true;
    this.container.replaceChildren(node);
    this.node = node;
    this.nameEl = nameEl;
    this.textEl = textEl;
    this.countEl = countEl;
  }
}
