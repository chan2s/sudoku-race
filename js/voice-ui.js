/**
 * voice-ui.js — renders the voice-call controls and state.
 *
 * It owns no call logic: it reads a snapshot from VoiceCall and reflects it into
 * the compact toolbar button, the in-call status panel, and the incoming-call
 * modal. All buttons report intent through the app's data-action handlers.
 */

import { CALL_STATE } from './multiplayer.js';

const STATE_TEXT = {
  [CALL_STATE.IDLE]: '',
  [CALL_STATE.OUTGOING]: 'Calling…',
  [CALL_STATE.INCOMING]: 'Incoming call',
  [CALL_STATE.CONNECTING]: 'Connecting…',
  [CALL_STATE.CONNECTED]: 'Connected',
  [CALL_STATE.RECONNECTING]: 'Reconnecting…',
  [CALL_STATE.ENDED]: 'Call ended',
};

const PANEL_STATES = new Set([
  CALL_STATE.OUTGOING,
  CALL_STATE.CONNECTING,
  CALL_STATE.CONNECTED,
  CALL_STATE.RECONNECTING,
  CALL_STATE.ENDED,
]);

export class VoiceUI {
  constructor({ ui, elements, voice = null }) {
    this.ui = ui;
    this.elements = elements;
    this.voice = null;
    this.unsubs = [];
    if (voice) this.setVoice(voice);
    else this.renderIdle();
  }

  setVoice(voice) {
    this.detachVoice();
    this.voice = voice || null;
    if (this.voice) {
      this.unsubs = [
        this.voice.on('change', (snapshot) => this.render(snapshot)),
        this.voice.on('incoming', ({ from }) => this.onIncoming(from)),
        this.voice.on('error', ({ message }) => this.ui?.showToast(message, 3200)),
      ];
      this.render(this.voice.snapshot());
    } else {
      this.renderIdle();
    }
  }

  detachVoice() {
    for (const off of this.unsubs.splice(0)) off?.();
    this.voice = null;
    this.hideOverlay();
  }

  /* ------------------------------ rendering ---------------------------- */

  renderIdle() {
    const el = this.elements;
    if (el.voicePanel) el.voicePanel.hidden = true;
    if (el.callBtn) {
      el.callBtn.disabled = true;
      el.callBtn.dataset.state = CALL_STATE.IDLE;
    }
    this.hideOverlay();
  }

  render(snapshot) {
    const el = this.elements;
    if (!el.callBtn) return;
    const state = snapshot.state;
    const active = state !== CALL_STATE.IDLE;

    el.callBtn.dataset.state = state;
    el.callBtn.disabled = active || !snapshot.canStart;
    el.callBtn.setAttribute(
      'aria-label',
      active ? `Voice call ${STATE_TEXT[state] || state}` : 'Start voice call',
    );

    const panel = el.voicePanel;
    if (panel) {
      const show = PANEL_STATES.has(state);
      panel.hidden = !show;
      panel.dataset.state = state;
      panel.dataset.connection = snapshot.connection || '';
      panel.dataset.remoteTracks = String(snapshot.remoteTracks || 0);
      panel.dataset.localActive = String(Boolean(snapshot.localActive));
      panel.dataset.muted = String(Boolean(snapshot.muted));
      panel.dataset.remoteMuted = String(Boolean(snapshot.remoteMuted));
      if (show) {
        if (el.voicePeer) el.voicePeer.textContent = snapshot.peerName || 'Opponent';
        if (el.voiceStatus) {
          const timeoutHint = snapshot.error || '';
          el.voiceStatus.textContent =
            state === CALL_STATE.ENDED && snapshot.error
              ? snapshot.error
              : STATE_TEXT[state] || '';
          el.voiceStatus.dataset.hint = timeoutHint;
        }
        if (el.voiceMute) {
          el.voiceMute.textContent = snapshot.muted ? 'Unmute' : 'Mute';
          el.voiceMute.setAttribute('aria-pressed', String(Boolean(snapshot.muted)));
        }
        if (el.voiceMuted) el.voiceMuted.hidden = !snapshot.muted;
        if (el.voiceRemoteMuted) el.voiceRemoteMuted.hidden = !snapshot.remoteMuted;
        if (el.voiceEnd) el.voiceEnd.hidden = state === CALL_STATE.ENDED;
      }
    }

    if (state === CALL_STATE.INCOMING) this.showOverlay(snapshot);
    else this.hideOverlay();
  }

  onIncoming(from) {
    this.showOverlay({ peerName: from?.name || 'Opponent' });
    this.ui?.announce(`Incoming voice call from ${from?.name || 'your opponent'}.`);
  }

  showOverlay(snapshot) {
    const el = this.elements;
    if (!el.callOverlay) return;
    if (el.callOverlayName) el.callOverlayName.textContent = snapshot.peerName || 'Opponent';
    el.callOverlay.hidden = false;
  }

  hideOverlay() {
    if (this.elements.callOverlay) this.elements.callOverlay.hidden = true;
  }

  /** Recomputes the button state (call it when the room/match changes). */
  refresh() {
    if (this.voice) this.render(this.voice.snapshot());
    else this.renderIdle();
  }
}
