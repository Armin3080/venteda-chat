/**
 * VENTEDA CHAT: Group audio/video calls.
 * Full mesh: every participant keeps one RTCPeerConnection per other participant.
 * The member who joins later always makes the offer, so each pair negotiates once.
 */

export class GroupCallManager {
  constructor(options = {}) {
    this.sendSignal = options.sendSignal || (() => {});
    this.getIceServers = options.getIceServers || (() => []);
    this.onStateChange = options.onStateChange || (() => {});
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onPeerLeft = options.onPeerLeft || (() => {});
    this.onInvite = options.onInvite || (() => {});
    this.onEnded = options.onEnded || (() => {});

    this.groupCallId = null;
    this.localStream = null;
    this.peers = new Map();      // userId -> { pc, pending: [] }
    this.earlyIce = new Map();   // userId -> [candidates that arrived before the peer existed]
    this.names = new Map();      // userId -> display name
    this.pendingStart = false;
    this.pendingJoin = false;
    this.isMuted = false;
    this.isVideoOff = false;
  }

  get busy() {
    return this.pendingStart || this.pendingJoin || !!this.groupCallId;
  }

  async acquire(callType) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (callType === 'video') {
      const hd = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: hd });
      } catch (err) {
        console.warn('HD camera failed for group call, retrying with default settings:', err);
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: true });
        } catch (err2) {
          console.warn('Camera unavailable for group call, continuing with audio:', err2);
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
          alert(`Camera could not be started (${err2?.name || 'unknown error'}). You will join with audio only.`);
        }
      }
    } else {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    this.onLocalStream(this.localStream);
  }

  async tuneSenders(pc) {
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const isVideo = sender.track.kind === 'video';
      if (isVideo) sender.track.contentHint = 'motion';
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = isVideo ? 1500000 : 128000;
        if (isVideo) params.degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
      } catch (e) {
        console.warn('Could not tune group sender quality:', e);
      }
    }
  }

  async start(conversationId, callType) {
    this.cleanup();
    try {
      await this.acquire(callType);
    } catch (err) {
      this.cleanup();
      throw err;
    }
    this.pendingStart = true;
    this.sendSignal({ action: 'group_call_start', data: { conversation_id: conversationId, call_type: callType } });
  }

  async join(groupCallId, callType) {
    this.cleanup();
    try {
      await this.acquire(callType);
    } catch (err) {
      this.cleanup();
      throw err;
    }
    this.pendingJoin = true;
    this.sendSignal({ action: 'group_call_join', data: { group_call_id: groupCallId } });
  }

  handleServerError() {
    if (this.pendingStart || this.pendingJoin) {
      this.cleanup();
      this.onStateChange('ended', {});
    }
  }

  handleEvent(event, data) {
    const isMine = !data || !data.group_call_id || data.group_call_id === this.groupCallId;
    switch (event) {
      case 'group_call_invite':
        this.onInvite(data);
        break;
      case 'group_call_started':
        this.pendingStart = false;
        this.groupCallId = data.group_call_id;
        this.onStateChange('active', { peers: [] });
        break;
      case 'group_call_joined':
        this.pendingJoin = false;
        this.groupCallId = data.group_call_id;
        (data.peers || []).forEach(p => {
          this.names.set(p.user_id, p.display_name);
          this.connectTo(p.user_id, true);
        });
        this.onStateChange('active', { peers: data.peers || [] });
        break;
      case 'group_call_peer_joined':
        if (!isMine) return;
        this.names.set(data.user_id, data.display_name);
        this.onStateChange('peer_joined', data);
        break;
      case 'group_call_signal':
        if (!isMine) return;
        this.handleSignal(data);
        break;
      case 'group_call_peer_left':
        if (!isMine) return;
        this.removePeer(data.user_id);
        break;
      case 'group_call_ended':
        if (!isMine) return;
        this.cleanup();
        this.onEnded(data);
        break;
      default:
        break;
    }
  }

  connectTo(userId, initiator) {
    if (this.peers.has(userId)) return this.peers.get(userId);

    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    const entry = { pc, pending: this.earlyIce.get(userId) || [] };
    this.earlyIce.delete(userId);
    this.peers.set(userId, entry);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
    }
    setTimeout(() => this.tuneSenders(pc), 1500);

    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      this.onRemoteStream(userId, this.names.get(userId) || 'Member', stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          action: 'group_call_signal',
          data: { group_call_id: this.groupCallId, to_user_id: userId, kind: 'ice', payload: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.removePeer(userId);
    };

    if (initiator) this.makeOffer(userId, entry);
    return entry;
  }

  async makeOffer(userId, entry) {
    try {
      const offer = await entry.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await entry.pc.setLocalDescription(offer);
      this.sendSignal({
        action: 'group_call_signal',
        data: { group_call_id: this.groupCallId, to_user_id: userId, kind: 'offer', payload: offer }
      });
    } catch (err) {
      console.error('Group call: failed to create offer', err);
      this.removePeer(userId);
    }
  }

  async handleSignal({ from_user_id, kind, payload }) {
    if (kind === 'offer') {
      const entry = this.connectTo(from_user_id, false);
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(payload));
        await this.flush(entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        this.sendSignal({
          action: 'group_call_signal',
          data: { group_call_id: this.groupCallId, to_user_id: from_user_id, kind: 'answer', payload: answer }
        });
      } catch (err) {
        console.error('Group call: failed to answer', err);
        this.removePeer(from_user_id);
      }
    } else if (kind === 'answer') {
      const entry = this.peers.get(from_user_id);
      if (!entry) return;
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(payload));
        await this.flush(entry);
      } catch (err) {
        console.error('Group call: failed to apply answer', err);
      }
    } else if (kind === 'ice') {
      const entry = this.peers.get(from_user_id);
      if (!entry) {
        // The offer has not been handled yet; keep the candidate until it is
        const list = this.earlyIce.get(from_user_id) || [];
        list.push(payload);
        this.earlyIce.set(from_user_id, list);
        return;
      }
      if (!entry.pc.remoteDescription) {
        entry.pending.push(payload);
        return;
      }
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(payload));
      } catch (err) {
        console.warn('Group call: ICE candidate rejected', err);
      }
    }
  }

  async flush(entry) {
    while (entry.pending.length) {
      const candidate = entry.pending.shift();
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Group call: queued ICE candidate rejected', err);
      }
    }
  }

  removePeer(userId) {
    const entry = this.peers.get(userId);
    if (entry) {
      try { entry.pc.close(); } catch (e) { /* already closed */ }
      this.peers.delete(userId);
    }
    this.onPeerLeft(userId);
  }

  leave() {
    if (this.groupCallId) {
      this.sendSignal({ action: 'group_call_leave', data: { group_call_id: this.groupCallId } });
    }
    this.cleanup();
    this.onStateChange('ended', {});
  }

  cleanup() {
    this.peers.forEach(entry => { try { entry.pc.close(); } catch (e) { /* already closed */ } });
    this.peers.clear();
    this.earlyIce.clear();
    this.names.clear();
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    this.groupCallId = null;
    this.pendingStart = false;
    this.pendingJoin = false;
    this.isMuted = false;
    this.isVideoOff = false;
  }

  toggleMute() {
    const track = this.localStream?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    this.isMuted = !track.enabled;
    return this.isMuted;
  }

  toggleVideo() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    this.isVideoOff = !track.enabled;
    return this.isVideoOff;
  }
}
