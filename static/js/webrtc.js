/**
 * VENTEDA CHAT — WebRTC Audio & Video Calling Engine
 * Manages RTCPeerConnection, media streams, and WebSocket signaling.
 */

export class WebRTCCallManager {
  constructor(options = {}) {
    this.sendSignal = options.sendSignal || (() => {});
    this.onCallStateChange = options.onCallStateChange || (() => {});
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onCallDuration = options.onCallDuration || (() => {});

    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;

    this.currentCall = null;
    this.callState = 'idle'; // 'idle', 'dialing', 'ringing', 'connected', 'ended'
    this.callType = 'audio'; // 'audio' or 'video'
    this.isMuted = false;
    this.isVideoOff = false;
    this.facingMode = 'user'; // 'user' or 'environment'

    this.callStartTime = 0;
    this.callDurationInterval = null;
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];

    // Audio synthesizer for ringing tones
    this.ringAudioCtx = null;
    this.ringInterval = null;

    // ICE candidates that arrive before the remote description is set
    this.pendingCandidates = [];
  }

  setIceServers(servers) {
    if (servers && servers.length > 0) {
      this.iceServers = servers;
    }
  }

  async startCall(targetUserId, targetUserName, targetAvatar, callType = 'audio', conversationId = null) {
    this.cleanup();
    this.callType = callType;
    this.currentCall = {
      targetUserId,
      targetUserName,
      targetAvatar,
      callType,
      conversationId,
      isCaller: true
    };
    this.setCallState('dialing');
    this.playRingtone('outgoing');

    try {
      await this.acquireLocalMedia(callType);
      this.sendSignal({
        action: 'call_invite',
        data: {
          target_user_id: targetUserId,
          call_type: callType,
          conversation_id: conversationId
        }
      });
    } catch (err) {
      console.error('Failed to access media devices:', err);
      this.stopRingtone();
      this.cleanup();
      throw err;
    }
  }

  handleIncomingCall(callData) {
    this.cleanup();
    this.callType = callData.call_type || 'audio';
    this.currentCall = {
      callId: callData.call_id,
      targetUserId: callData.caller_id,
      targetUserName: callData.caller_name,
      targetAvatar: callData.caller_avatar,
      callType: this.callType,
      conversationId: callData.conversation_id,
      isCaller: false
    };
    this.setCallState('ringing');
    this.playRingtone('incoming');

    // Notify caller that receiver received invite
    this.sendSignal({
      action: 'call_ringing',
      data: { call_id: callData.call_id }
    });
  }

  async acceptCall() {
    if (!this.currentCall || !this.currentCall.callId) return;
    this.stopRingtone();

    try {
      await this.acquireLocalMedia(this.callType);
      this.setupPeerConnection();

      this.sendSignal({
        action: 'call_accept',
        data: { call_id: this.currentCall.callId }
      });
      this.setCallState('connected');
      this.startDurationTimer();
    } catch (err) {
      console.error('Failed to accept call:', err);
      this.rejectCall();
      throw err;
    }
  }

  rejectCall() {
    this.stopRingtone();
    if (this.currentCall && this.currentCall.callId) {
      this.sendSignal({
        action: 'call_reject',
        data: { call_id: this.currentCall.callId }
      });
    }
    this.cleanup();
    this.setCallState('idle');
  }

  cancelCall() {
    this.stopRingtone();
    if (this.currentCall && this.currentCall.callId) {
      this.sendSignal({
        action: 'call_cancel',
        data: { call_id: this.currentCall.callId }
      });
    }
    this.cleanup();
    this.setCallState('idle');
  }

  hangup() {
    this.stopRingtone();
    if (this.currentCall && this.currentCall.callId) {
      this.sendSignal({
        action: 'call_hangup',
        data: { call_id: this.currentCall.callId }
      });
    }
    this.cleanup();
    this.setCallState('idle');
  }

  // WebRTC Media Acquisition
  async acquireLocalMedia(callType) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (callType === 'video') {
      const hd = { facingMode: this.facingMode || 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: hd });
      } catch (err) {
        console.warn('HD camera failed, retrying with default camera settings:', err);
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: true });
        } catch (err2) {
          console.warn('Camera unavailable, continuing with audio only:', err2);
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
          this.cameraUnavailable = true;
          alert(`Camera could not be started (${err2?.name || 'unknown error'}). The call continues with audio only. Close other apps using the camera and check the browser permission.`);
        }
      }
    } else {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
    this.onLocalStream(this.localStream);
  }

  // Quality: high bitrate for video and clear audio; keep resolution when bandwidth drops
  async tuneSenders(pc) {
    if (!pc) return;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const isVideo = sender.track.kind === 'video';
      if (isVideo) sender.track.contentHint = 'motion';
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = isVideo ? 2500000 : 128000;
        if (isVideo) params.degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
      } catch (e) {
        console.warn('Could not tune sender quality:', e);
      }
    }
  }

  setupPeerConnection() {
    if (this.peerConnection) return;

    this.peerConnection = new RTCPeerConnection({
      iceServers: this.iceServers
    });

    // Add local tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    setTimeout(() => this.tuneSenders(this.peerConnection), 1500);

    // Remote track arrived
    this.peerConnection.ontrack = (event) => {
      this.remoteStream = event.streams[0] || new MediaStream([event.track]);
      this.onRemoteStream(this.remoteStream);
    };

    // ICE Candidate generation
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.currentCall) {
        this.sendSignal({
          action: 'ice_candidate',
          data: {
            call_id: this.currentCall.callId,
            candidate: event.candidate
          }
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === 'connected') {
        this.setCallState('connected');
        this.startDurationTimer();
      } else if (state === 'failed') {
        // 'disconnected' is often temporary (network blip); wait for recovery or 'failed'
        this.hangup();
      }
    };
  }

  // Signaling message dispatcher
  async handleSignalingEvent(event, data) {
    // Receiver side: the server pushes the incoming call here. This branch was missing,
    // so the callee never saw the ringing UI and could not answer.
    if (event === 'incoming_call') {
      this.handleIncomingCall({
        call_id: data.call_id,
        caller_id: data.caller_id,
        caller_name: data.caller_name,
        caller_avatar: data.caller_avatar,
        call_type: data.call_type,
        conversation_id: data.conversation_id
      });
      return;
    }

    if (event === 'call_initiated') {
      if (this.currentCall) {
        this.currentCall.callId = data.call_id;
      }
    } else if (event === 'call_ringing') {
      this.setCallState('ringing');
    } else if (event === 'call_accepted') {
      this.stopRingtone();
      this.setupPeerConnection();
      // Caller generates offer
      try {
        const offer = await this.peerConnection.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: this.callType === 'video'
        });
        await this.peerConnection.setLocalDescription(offer);
        this.sendSignal({
          action: 'call_offer',
          data: {
            call_id: this.currentCall.callId,
            offer: offer
          }
        });
        this.setCallState('connected');
        this.startDurationTimer();
      } catch (e) {
        console.error('Failed to create offer:', e);
        this.hangup();
      }
    } else if (event === 'call_offer') {
      this.stopRingtone();
      this.setupPeerConnection();
      try {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        await this.flushPendingCandidates();
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.sendSignal({
          action: 'call_answer',
          data: {
            call_id: this.currentCall.callId,
            answer: answer
          }
        });
      } catch (e) {
        console.error('Failed to handle offer:', e);
        this.hangup();
      }
    } else if (event === 'call_answer') {
      try {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        await this.flushPendingCandidates();
      } catch (e) {
        console.error('Failed to handle answer:', e);
      }
    } else if (event === 'ice_candidate') {
      if (!data.candidate) return;
      if (!this.peerConnection || !this.peerConnection.remoteDescription) {
        // Too early: keep the candidate until the remote description is set
        this.pendingCandidates.push(data.candidate);
        return;
      }
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn('Error adding ICE candidate:', e);
      }
    } else if (event === 'call_rejected') {
      this.stopRingtone();
      this.cleanup();
      this.setCallState('idle');
      alert('Call declined by recipient.');
    } else if (event === 'call_busy') {
      this.stopRingtone();
      this.cleanup();
      this.setCallState('idle');
      alert('User is currently on another call.');
    } else if (event === 'call_user_offline') {
      this.stopRingtone();
      this.cleanup();
      this.setCallState('idle');
      alert('User is currently offline.');
    } else if (event === 'call_cancelled' || event === 'call_ended') {
      this.stopRingtone();
      this.cleanup();
      this.setCallState('idle');
    }
  }

  async flushPendingCandidates() {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('Error adding queued ICE candidate:', e);
      }
    }
  }

  // Audio / Video Controls
  toggleMute() {
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        this.isMuted = !audioTrack.enabled;
        return this.isMuted;
      }
    }
    return false;
  }

  toggleVideo() {
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        this.isVideoOff = !videoTrack.enabled;
        return this.isVideoOff;
      }
    }
    return false;
  }

  async flipCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    if (this.localStream && this.callType === 'video') {
      const oldVideoTrack = this.localStream.getVideoTracks()[0];
      if (oldVideoTrack) oldVideoTrack.stop();

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.facingMode }
      });
      const newVideoTrack = newStream.getVideoTracks()[0];

      if (this.peerConnection) {
        const sender = this.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(newVideoTrack);
      }
      this.localStream.removeTrack(oldVideoTrack);
      this.localStream.addTrack(newVideoTrack);
      this.onLocalStream(this.localStream);
    }
  }

  startDurationTimer() {
    if (this.callDurationInterval) clearInterval(this.callDurationInterval);
    this.callStartTime = Date.now();
    this.callDurationInterval = setInterval(() => {
      const seconds = Math.floor((Date.now() - this.callStartTime) / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      this.onCallDuration(`${mins}:${secs.toString().padStart(2, '0')}`, seconds);
    }, 1000);
  }

  // Synthetic Pleasant Web Audio Chime (No external audio file dependency)
  playRingtone(type) {
    this.stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ringAudioCtx = new AudioCtx();

      const beep = () => {
        if (!this.ringAudioCtx || this.ringAudioCtx.state === 'closed') return;
        const osc = this.ringAudioCtx.createOscillator();
        const gain = this.ringAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(this.ringAudioCtx.destination);

        const freq = type === 'incoming' ? 440 : 480;
        osc.frequency.setValueAtTime(freq, this.ringAudioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.25, this.ringAudioCtx.currentTime + 0.35);

        gain.gain.setValueAtTime(0.08, this.ringAudioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ringAudioCtx.currentTime + 0.5);

        osc.start();
        osc.stop(this.ringAudioCtx.currentTime + 0.5);
      };

      beep();
      this.ringInterval = setInterval(beep, type === 'incoming' ? 2200 : 3000);
    } catch (e) {
      console.warn('Audio chime unavailable:', e);
    }
  }

  stopRingtone() {
    if (this.ringInterval) {
      clearInterval(this.ringInterval);
      this.ringInterval = null;
    }
    if (this.ringAudioCtx && this.ringAudioCtx.state !== 'closed') {
      this.ringAudioCtx.close().catch(() => {});
      this.ringAudioCtx = null;
    }
  }

  setCallState(newState) {
    this.callState = newState;
    this.onCallStateChange(newState, this.currentCall);
  }

  cleanup() {
    if (this.callDurationInterval) {
      clearInterval(this.callDurationInterval);
      this.callDurationInterval = null;
    }
    this.stopRingtone();

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.remoteStream = null;
    this.currentCall = null;
    this.isMuted = false;
    this.isVideoOff = false;
    this.pendingCandidates = [];
  }
}
