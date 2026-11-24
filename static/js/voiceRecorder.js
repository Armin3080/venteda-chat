/**
 * VENTEDA CHAT — Real In-Browser Voice Recording Engine
 * Uses MediaRecorder & Web Audio API AnalyserNode for live visual waveform.
 */

export class VoiceRecorder {
  constructor(options = {}) {
    this.onStateChange = options.onStateChange || (() => {});
    this.onTimeUpdate = options.onTimeUpdate || (() => {});
    this.onWaveform = options.onWaveform || (() => {});

    this.mediaStream = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.audioBlob = null;
    this.audioUrl = null;

    this.state = 'inactive'; // 'inactive', 'recording', 'paused', 'recorded'
    this.startTime = 0;
    this.elapsedSeconds = 0;
    this.timerInterval = null;

    this.audioContext = null;
    this.analyser = null;
    this.animationFrame = null;
  }

  async start() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone audio recording is not supported in this browser.');
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Setup Web Audio Analyser for live visual feedback
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.audioContext = new AudioCtx();
          const source = this.audioContext.createMediaStreamSource(this.mediaStream);
          this.analyser = this.audioContext.createAnalyser();
          this.analyser.fftSize = 64;
          source.connect(this.analyser);
          this.startWaveformLoop();
        }
      } catch (e) {
        console.warn('AudioContext not available for waveform visualization:', e);
      }

      // Detect supported mime type
      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/aac'
      ];
      let selectedMime = '';
      for (const t of mimeTypes) {
        if (MediaRecorder.isTypeSupported(t)) {
          selectedMime = t;
          break;
        }
      }

      const recorderOptions = selectedMime ? { mimeType: selectedMime } : {};
      this.mediaRecorder = new MediaRecorder(this.mediaStream, recorderOptions);
      this.audioChunks = [];
      this.audioBlob = null;
      this.audioUrl = null;

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const mime = this.mediaRecorder.mimeType || 'audio/webm';
        this.audioBlob = new Blob(this.audioChunks, { type: mime });
        this.audioUrl = URL.createObjectURL(this.audioBlob);
        this.setState('recorded');
      };

      this.mediaRecorder.start(100); // 100ms chunks
      this.startTime = Date.now();
      this.elapsedSeconds = 0;
      this.startTimer();
      this.setState('recording');
      return true;
    } catch (err) {
      this.cleanup();
      throw err;
    }
  }

  pause() {
    if (this.mediaRecorder && this.state === 'recording') {
      this.mediaRecorder.pause();
      this.stopTimer();
      this.setState('paused');
    }
  }

  resume() {
    if (this.mediaRecorder && this.state === 'paused') {
      this.mediaRecorder.resume();
      this.startTimer();
      this.setState('recording');
    }
  }

  stop() {
    if (this.mediaRecorder && this.state !== 'inactive') {
      this.stopTimer();
      this.stopWaveformLoop();
      this.mediaRecorder.stop();
      this.stopTracks();
    }
  }

  // Stops recording and resolves with the complete audio Blob once the
  // browser has flushed the final chunk (fixes the race with a fixed timeout).
  stopAndGetBlob() {
    return new Promise((resolve, reject) => {
      const recorder = this.mediaRecorder;
      if (!recorder || recorder.state === 'inactive') {
        reject(new Error('No active recording.'));
        return;
      }
      recorder.addEventListener('stop', () => {
        const mime = recorder.mimeType || 'audio/webm';
        this.audioBlob = new Blob(this.audioChunks, { type: mime });
        resolve(this.audioBlob);
      }, { once: true });
      this.stopTimer();
      this.stopWaveformLoop();
      try {
        recorder.stop();
      } catch (e) {
        reject(e);
        return;
      }
      this.stopTracks();
    });
  }

  cancel() {
    this.cleanup();
    this.setState('inactive');
  }

  startTimer() {
    this.stopTimer();
    const tick = () => {
      this.elapsedSeconds += 1;
      this.onTimeUpdate(this.elapsedSeconds, this.formatTime(this.elapsedSeconds));
    };
    this.timerInterval = setInterval(tick, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  startWaveformLoop() {
    if (!this.analyser) return;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    const update = () => {
      if (this.state === 'recording') {
        this.analyser.getByteFrequencyData(dataArray);
        // Normalize 8 bands
        const bands = [];
        const step = Math.floor(dataArray.length / 8);
        for (let i = 0; i < 8; i++) {
          const val = dataArray[i * step] || 0;
          bands.push(Math.max(4, Math.round((val / 255) * 24)));
        }
        this.onWaveform(bands);
      }
      this.animationFrame = requestAnimationFrame(update);
    };
    this.animationFrame = requestAnimationFrame(update);
  }

  stopWaveformLoop() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  stopTracks() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  cleanup() {
    this.stopTimer();
    this.stopWaveformLoop();
    this.stopTracks();
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    this.audioChunks = [];
    this.audioBlob = null;
    this.elapsedSeconds = 0;
  }

  setState(newState) {
    this.state = newState;
    this.onStateChange(this.state);
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getAudioBlob() {
    return this.audioBlob;
  }

  getAudioUrl() {
    return this.audioUrl;
  }

  getDuration() {
    return this.elapsedSeconds;
  }
}
