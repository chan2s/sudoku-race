/**
 * voice.js — real-time audio calls between the two players of a room.
 *
 * Media is peer-to-peer (WebRTC); this module only needs signaling, and it
 * reuses MultiplayerClient's authenticated room socket for that. The server
 * validates every message and relays SDP/ICE opaquely — no audio ever reaches
 * the server. ICE servers (STUN, and ephemeral TURN credentials) are fetched
 * from the server on demand, never hard-coded.
 *
 * The call is audio-only, lives only for the duration of a call, and releases
 * the microphone and the RTCPeerConnection the moment the call ends.
 */

import { Emitter } from './game.js';
import { CALL_STATE, CALL_ERRORS, CALL_RING_TIMEOUT_MS } from './multiplayer.js';

const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_CONFIG_TIMEOUT_MS = 4000;
const CONNECT_TIMEOUT_MS = 25000;
const RECONNECT_GRACE_MS = 15000;
const ENDED_LINGER_MS = 1800;

function micErrorMessage(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was denied. Allow it in your browser to use voice chat.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is already in use by another application.';
  }
  return error?.message || 'Could not access the microphone.';
}

function reasonText(reason) {
  switch (reason) {
    case 'no-answer':
      return 'No answer — the call timed out.';
    case 'declined':
      return 'Call declined.';
    case 'peer-disconnected':
    case 'peer-left':
      return 'Your opponent left the call.';
    case 'match-ended':
      return 'The match ended.';
    case 'connection-lost':
      return 'The voice connection was lost.';
    default:
      return 'Call ended.';
  }
}

export class VoiceCall extends Emitter {
  constructor({ client }) {
    super();
    this.client = client;
    this.state = CALL_STATE.IDLE;
    this.role = null; // 'caller' | 'callee'
    this.peer = null; // { id, name }
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.audioEl = null;
    this.muted = false;
    this.remoteMuted = false;
    this.iceServers = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.ringTimer = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.lastError = '';
    this.endedReason = '';
    this.bound = false;
    this.unsubs = [];
  }

  /* ----------------------------- lifecycle ----------------------------- */

  static get supported() {
    return (
      typeof RTCPeerConnection !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    );
  }

  attach() {
    if (this.bound || !this.client) return;
    this.bound = true;
    const client = this.client;
    this.unsubs = [
      client.on('call-config', (servers) => {
        if (Array.isArray(servers) && servers.length) this.iceServers = servers;
      }),
      client.on('call-incoming', (message) => this.onIncoming(message)),
      client.on('call-accepted', (message) => this.onAccepted(message)),
      client.on('call-declined', (message) => this.onDeclined(message)),
      client.on('call-ended', (message) => this.onEnded(message)),
      client.on('call-signal', (message) => this.onSignal(message)),
      client.on('call-error', (error) => this.onServerError(error)),
      client.on('status', ({ state }) => this.onSocketState(state)),
    ];
  }

  detach() {
    for (const off of this.unsubs.splice(0)) off?.();
    this.bound = false;
  }

  /** Releases all resources (used when leaving a room / tearing down). */
  destroy() {
    this.hangupLocal();
    this.detach();
  }

  /* ------------------------------ actions ------------------------------ */

  canStart() {
    const room = this.client?.room;
    const opponent = this.client?.opponent?.();
    return (
      this.state === CALL_STATE.IDLE &&
      VoiceCall.supported &&
      room?.status === 'playing' &&
      Boolean(opponent?.connected)
    );
  }

  /** Caller: captures the mic and rings the opponent. */
  async start() {
    if (this.state !== CALL_STATE.IDLE) return;
    if (!VoiceCall.supported) {
      this.fail(CALL_ERRORS.UNSUPPORTED, 'Voice calls are not supported in this browser.');
      return;
    }
    if (typeof isSecureContext !== 'undefined' && isSecureContext === false) {
      this.fail(CALL_ERRORS.UNSUPPORTED, 'Voice calls need a secure (https or localhost) connection.');
      return;
    }
    const room = this.client?.room;
    const opponent = this.client?.opponent?.();
    if (!room || room.status !== 'playing') {
      this.fail(CALL_ERRORS.UNAVAILABLE, 'Voice calls are available during a match.');
      return;
    }
    if (!opponent?.connected) {
      this.fail(CALL_ERRORS.PEER_UNAVAILABLE, 'Your opponent is not connected.');
      return;
    }
    this.role = 'caller';
    this.peer = { id: opponent.id, name: opponent.name };
    this.lastError = '';
    this.endedReason = '';
    this.setState(CALL_STATE.OUTGOING);
    try {
      await this.captureMic();
    } catch (error) {
      this.fail(CALL_ERRORS.MIC_DENIED, micErrorMessage(error));
      return;
    }
    this.client.requestCallConfig();
    this.client.sendCallInvite();
    this.startRingTimer();
  }

  /** Callee: captures the mic and accepts the ringing call. */
  async accept() {
    if (this.state !== CALL_STATE.INCOMING) return;
    try {
      await this.captureMic();
    } catch (error) {
      this.client.sendCallDecline();
      this.fail(CALL_ERRORS.MIC_DENIED, micErrorMessage(error));
      return;
    }
    this.stopRingTimer();
    this.setState(CALL_STATE.CONNECTING);
    this.client.sendCallAccept();
    this.startConnectTimer();
  }

  decline() {
    if (this.state !== CALL_STATE.INCOMING) return;
    this.stopRingTimer();
    this.client.sendCallDecline();
    this.cleanupMedia();
    this.setState(CALL_STATE.IDLE);
  }

  /** Ends the call from either side and releases the microphone. */
  hangup(reason = 'ended') {
    if (this.state === CALL_STATE.IDLE) return;
    if (this.state === CALL_STATE.INCOMING) {
      this.decline();
      return;
    }
    this.client?.sendCallEnd(reason);
    this.cleanupMedia();
    this.endedReason = reason;
    this.setState(CALL_STATE.ENDED);
    this.lingerEnded();
  }

  toggleMute() {
    const track = this.localStream?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.muted = !track.enabled;
    if (this.state === CALL_STATE.CONNECTED || this.state === CALL_STATE.CONNECTING) {
      this.client?.sendCallSignal({ type: 'mute', muted: this.muted });
    }
    this.emitChange();
  }

  /* --------------------------- incoming events -------------------------- */

  onIncoming(message) {
    if (this.state !== CALL_STATE.IDLE) {
      // Already busy: politely refuse so overlapping calls cannot form.
      this.client?.sendCallDecline();
      return;
    }
    this.role = 'callee';
    this.peer = message?.from || null;
    this.lastError = '';
    this.endedReason = '';
    this.setState(CALL_STATE.INCOMING);
    this.startRingTimer();
    this.emit('incoming', { from: this.peer });
  }

  async onAccepted() {
    if (this.role !== 'caller' || this.state !== CALL_STATE.OUTGOING) return;
    this.stopRingTimer();
    this.setState(CALL_STATE.CONNECTING);
    this.startConnectTimer();
    try {
      await this.createPeerConnection();
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);
      this.client.sendCallSignal({ type: 'offer', sdp: this.pc.localDescription });
    } catch (error) {
      this.fail(CALL_ERRORS.FAILED, error?.message || 'Could not start the voice connection.');
    }
  }

  onDeclined() {
    if (this.role !== 'caller') return;
    this.cleanupMedia();
    this.endedReason = 'declined';
    this.lastError = 'Call declined.';
    this.setState(CALL_STATE.ENDED);
    this.lingerEnded();
  }

  onEnded(message) {
    if (this.state === CALL_STATE.IDLE) return;
    const weEndedIt = Boolean(message?.endedBy) && message.endedBy === this.client?.playerId;
    this.cleanupMedia();
    this.endedReason = message?.reason || 'ended';
    // Only surface the reason when the opponent (or the server) ended it; a
    // hang-up we initiated is a normal completion, not an error.
    if (!weEndedIt) this.lastError = reasonText(this.endedReason);
    this.setState(CALL_STATE.ENDED);
    this.lingerEnded();
  }

  onSignal(message) {
    const signal = message?.signal;
    if (!signal || typeof signal !== 'object' || Array.isArray(signal)) return;
    // Only the opponent's signaling is honored.
    if (message?.from?.id && this.peer?.id && message.from.id !== this.peer.id) return;
    if (signal.type === 'mute') {
      this.remoteMuted = Boolean(signal.muted);
      this.emitChange();
      return;
    }
    if (signal.type === 'offer') this.onRemoteOffer(signal);
    else if (signal.type === 'answer') this.onRemoteAnswer(signal);
    else if (signal.type === 'ice' && signal.candidate) this.onRemoteCandidate(signal.candidate);
  }

  async onRemoteOffer(signal) {
    if (this.role !== 'callee') return;
    try {
      await this.createPeerConnection();
      await this.pc.setRemoteDescription(signal.sdp);
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      const answer = await this.pc.createAnswer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(answer);
      this.client.sendCallSignal({ type: 'answer', sdp: this.pc.localDescription });
    } catch (error) {
      this.fail(CALL_ERRORS.FAILED, error?.message || 'Could not answer the voice connection.');
    }
  }

  async onRemoteAnswer(signal) {
    if (this.role !== 'caller' || !this.pc) return;
    try {
      await this.pc.setRemoteDescription(signal.sdp);
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
    } catch (error) {
      this.fail(CALL_ERRORS.FAILED, error?.message || 'Could not complete the voice connection.');
    }
  }

  async onRemoteCandidate(candidate) {
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      /* a candidate that arrives too late is safe to drop */
    }
  }

  async flushCandidates() {
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        /* ignore individual candidate failures */
      }
    }
  }

  onServerError(error) {
    const code = error?.code || CALL_ERRORS.FAILED;
    const message = error?.message || 'Voice call failed.';
    // Recoverable pre-call rejections just clear the outgoing state.
    if (code === CALL_ERRORS.BUSY || code === CALL_ERRORS.PEER_UNAVAILABLE || code === CALL_ERRORS.NOT_IN_ROOM || code === CALL_ERRORS.UNAVAILABLE || code === CALL_ERRORS.INVALID_STATE) {
      this.cleanupMedia();
      this.lastError = message;
      this.setState(CALL_STATE.ENDED);
      this.lingerEnded();
      return;
    }
    this.fail(code, message);
  }

  onSocketState(state) {
    if (this.state === CALL_STATE.IDLE || this.state === CALL_STATE.INCOMING || this.state === CALL_STATE.ENDED) return;
    if (state === 'reconnecting' || state === 'offline' || state === 'connecting') {
      this.setState(CALL_STATE.RECONNECTING);
      this.startReconnectGrace();
    } else if (state === 'connected') {
      // The server tears a call down when a socket drops, so a reconnect means
      // our call is over; release the microphone instead of leaving it live.
      this.stopReconnectGrace();
      if (this.state === CALL_STATE.RECONNECTING) this.hangupLocal('connection-lost');
    }
  }

  /* ------------------------------ WebRTC ------------------------------- */

  async captureMic() {
    if (this.localStream) return this.localStream;
    if (!VoiceCall.supported) throw new Error('Voice calls are not supported');
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const track = this.localStream.getAudioTracks()[0];
    this.muted = track ? !track.enabled : false;
    return this.localStream;
  }

  async ensureIceServers() {
    if (this.iceServers) return this.iceServers;
    this.client?.requestCallConfig();
    const servers = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        off?.();
        clearTimeout(timer);
        resolve(value);
      };
      const off = this.client?.on('call-config', (list) => finish(Array.isArray(list) && list.length ? list : DEFAULT_ICE_SERVERS));
      const timer = setTimeout(() => finish(this.iceServers || DEFAULT_ICE_SERVERS), ICE_CONFIG_TIMEOUT_MS);
    });
    this.iceServers = Array.isArray(servers) && servers.length ? servers : DEFAULT_ICE_SERVERS;
    return this.iceServers;
  }

  async createPeerConnection() {
    if (this.pc) return this.pc;
    const iceServers = await this.ensureIceServers();
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    this.pc = pc;
    this.remoteDescriptionSet = false;
    for (const track of this.localStream?.getTracks?.() || []) pc.addTrack(track, this.localStream);
    pc.ontrack = (event) => {
      this.remoteStream = event.streams?.[0] || new MediaStream([event.track]);
      this.attachRemoteAudio();
      this.emitChange();
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.client.sendCallSignal({
        type: 'ice',
        candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
      });
    };
    pc.onconnectionstatechange = () => this.onPeerState();
    pc.oniceconnectionstatechange = () => this.onPeerState();
    return pc;
  }

  onPeerState() {
    if (!this.pc) return;
    const connection = this.pc.connectionState;
    if (connection === 'connected') {
      this.stopConnectTimer();
      this.stopReconnectGrace();
      this.setState(CALL_STATE.CONNECTED);
    } else if (connection === 'failed') {
      this.fail(CALL_ERRORS.FAILED, 'The voice connection failed. Check your network or TURN settings.');
    } else if (connection === 'disconnected') {
      this.setState(CALL_STATE.RECONNECTING);
      this.startReconnectGrace();
    } else if (connection === 'connecting' && this.state !== CALL_STATE.CONNECTING) {
      this.setState(CALL_STATE.CONNECTING);
    }
  }

  attachRemoteAudio() {
    let el = this.audioEl || document.getElementById('voice-audio');
    if (!el) {
      el = document.createElement('audio');
      el.id = 'voice-audio';
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    this.audioEl = el;
    el.srcObject = this.remoteStream;
    const play = el.play?.();
    if (play && typeof play.catch === 'function') {
      play.catch(() => this.emit('autoplay-blocked'));
    }
  }

  /* ------------------------------ cleanup ------------------------------ */

  cleanupMedia() {
    this.stopRingTimer();
    this.stopConnectTimer();
    this.stopReconnectGrace();
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.localStream = null;
    }
    if (this.audioEl) this.audioEl.srcObject = null;
    if (this.pc) {
      const pc = this.pc;
      this.pc = null;
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.remoteStream = null;
    this.pendingCandidates = [];
    this.remoteDescriptionSet = false;
    this.muted = false;
    this.remoteMuted = false;
    this.role = null;
  }

  hangupLocal(reason = 'ended') {
    this.cleanupMedia();
    this.peer = null;
    if (reason === 'connection-lost') this.lastError = reasonText(reason);
    this.endedReason = reason;
    this.setState(CALL_STATE.IDLE);
  }

  fail(code, message) {
    this.cleanupMedia();
    this.lastError = message;
    this.endedReason = 'failed';
    this.setState(CALL_STATE.ENDED);
    this.emit('error', { code, message });
    this.lingerEnded();
  }

  lingerEnded() {
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      if (this.state === CALL_STATE.ENDED) {
        this.peer = null;
        this.setState(CALL_STATE.IDLE);
      }
    }, ENDED_LINGER_MS);
  }

  /* ------------------------------ timers ------------------------------- */

  startRingTimer() {
    this.stopRingTimer();
    this.ringTimer = setTimeout(() => {
      if (this.state === CALL_STATE.OUTGOING) this.hangup('no-answer');
      else if (this.state === CALL_STATE.INCOMING) {
        this.client?.sendCallDecline();
        this.cleanupMedia();
        this.setState(CALL_STATE.IDLE);
      }
    }, CALL_RING_TIMEOUT_MS + 2000);
  }

  stopRingTimer() {
    clearTimeout(this.ringTimer);
    this.ringTimer = null;
  }

  startConnectTimer() {
    this.stopConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.pc && this.pc.connectionState !== 'connected' && this.state !== CALL_STATE.CONNECTED) {
        this.fail(CALL_ERRORS.FAILED, 'The voice connection timed out.');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  stopConnectTimer() {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  startReconnectGrace() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => this.hangupLocal('connection-lost'), RECONNECT_GRACE_MS);
  }

  stopReconnectGrace() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /* ------------------------------ state -------------------------------- */

  setState(state) {
    if (this.state === state) {
      this.emitChange();
      return;
    }
    this.state = state;
    this.emitChange();
  }

  emitChange() {
    this.emit('change', this.snapshot());
    this.emit('state', this.state);
  }

  snapshot() {
    return {
      state: this.state,
      role: this.role,
      peerName: this.peer?.name || '',
      peerId: this.peer?.id || '',
      muted: this.muted,
      remoteMuted: this.remoteMuted,
      connection: this.pc?.connectionState || this.pc?.iceConnectionState || '',
      remoteTracks: this.remoteStream ? this.remoteStream.getAudioTracks().length : 0,
      localActive: Boolean(this.localStream),
      supported: VoiceCall.supported,
      canStart: this.canStart(),
      error: this.lastError,
      endedReason: this.endedReason,
    };
  }
}
