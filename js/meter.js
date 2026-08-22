// Sound level measurement on the baby phone.
//
// Runs in an AudioWorklet — a separate real-time audio thread — so measuring
// the room does not depend on the main thread, which Android is free to
// throttle. The worklet reports about 10 times a second; that is plenty to
// draw a bar and to decide "the baby is awake", and it keeps the main thread
// asleep the rest of the time.

const WORKLET = `
class LevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.n = 0;
    this.peak = 0;
    this.lastPost = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        this.sum += v * v;
        if (v > this.peak) this.peak = v;
        else if (-v > this.peak) this.peak = -v;
      }
      this.n += ch.length;
    }
    // currentTime is in seconds and comes from the audio clock
    if (currentTime - this.lastPost >= 0.1) {
      const rms = this.n ? Math.sqrt(this.sum / this.n) : 0;
      this.port.postMessage({ rms, peak: this.peak });
      this.sum = 0; this.n = 0; this.peak = 0;
      this.lastPost = currentTime;
    }
    return true;
  }
}
registerProcessor('level-processor', LevelProcessor);
`;

export const dbfs = (rms) => (rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90);

// The slider runs 0-100 (higher = hears quieter sounds). Map it onto the part
// of the dB range that actually matters in a bedroom.
export const sensToDb = (sens) => -20 - (sens / 100) * 50;   // 0 -> -20dB, 100 -> -70dB
export const dbToBar = (db) => Math.max(0, Math.min(1, (db + 70) / 70));

export class Meter extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.src = null;
    this.db = -90;
    this.smooth = -90;
  }

  async start(stream) {
    this.stop();
    // 16kHz is more than enough for a baby monitor and costs less CPU than 48k.
    this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const blob = new Blob([WORKLET], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally { URL.revokeObjectURL(url); }

    this.src = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'level-processor');
    this.node.port.onmessage = ({ data }) => {
      const db = dbfs(data.peak);
      // fast attack so a cry registers at once, slow release so the bar does
      // not flicker between syllables
      this.smooth = db > this.smooth ? db : this.smooth * 0.82 + db * 0.18;
      this.db = this.smooth;
      this.dispatchEvent(new CustomEvent('level', { detail: { db: this.smooth, raw: db } }));
    };
    this.src.connect(this.node);
    // A worklet with no destination is allowed to be optimised away in some
    // engines; a zero gain sink keeps the graph alive without making a sound.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
    return this;
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* needs a gesture */ } }
  }

  stop() {
    try { if (this.src) this.src.disconnect(); } catch (e) { /* ignore */ }
    try { if (this.node) this.node.disconnect(); } catch (e) { /* ignore */ }
    if (this.ctx) { try { this.ctx.close(); } catch (e) { /* ignore */ } }
    this.ctx = this.node = this.src = null;
  }
}

// Decides "is the baby actually making noise" from a stream of levels.
// Hysteresis plus a hold time, so one cough or a passing car does not count.
export class NoiseGate {
  constructor({ thresholdDb, holdMs }) {
    this.thresholdDb = thresholdDb;
    this.holdMs = holdMs;
    this.overSince = 0;
    this.active = false;
    this.quietSince = 0;
  }

  set(thresholdDb, holdMs) {
    this.thresholdDb = thresholdDb;
    if (holdMs != null) this.holdMs = holdMs;
  }

  // returns 'rise' | 'fall' | null
  push(db, now = Date.now()) {
    const over = db >= this.thresholdDb;
    // release 6dB below the trigger, so a sound hovering on the line does not
    // rattle the alarm on and off
    const stillOver = db >= this.thresholdDb - 6;

    if (!this.active) {
      if (over) {
        if (!this.overSince) this.overSince = now;
        if (now - this.overSince >= this.holdMs) {
          this.active = true;
          this.quietSince = 0;
          return 'rise';
        }
      } else this.overSince = 0;
      return null;
    }

    if (stillOver) { this.quietSince = 0; return null; }
    if (!this.quietSince) this.quietSince = now;
    if (now - this.quietSince >= 8000) {  // 8s of calm before we call it over
      this.active = false;
      this.overSince = 0;
      return 'fall';
    }
    return null;
  }
}
