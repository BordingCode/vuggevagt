// Sounds the parent phone makes.
//
// Two deliberately different voices:
//   wake  — the baby is making noise. Warm, rising, stops on its own.
//   dead  — the link is broken and you are no longer being watched. Harsh,
//           repeating, and it does NOT stop until a human taps it away.
//
// The second one is the whole point of the app. A baby monitor that fails
// silently is more dangerous than no baby monitor, because you trust it.

let ctx = null;
let deadTimer = null;
let deadPlaying = false;

export function audio() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'playback' });
  return ctx;
}

// Must be called from a real tap, once, or Android will not let us make a sound
// later. Crucially this must NEVER block: outside a user gesture Chrome leaves
// the resume() promise pending forever, and an app that auto-starts from a
// saved pairing would hang there instead of connecting.
export async function unlock() {
  const c = audio();
  if (c.state === 'suspended') {
    try {
      await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 400))]);
    } catch (e) { /* no gesture yet — armOnFirstGesture will retry */ }
  }
  if (c.state !== 'running') return false;
  // a one-sample silent blip proves the context is really running
  const b = c.createBuffer(1, 1, 22050);
  const s = c.createBufferSource();
  s.buffer = b;
  s.connect(c.destination);
  s.start(0);
  return c.state === 'running';
}

export function running() { return !!ctx && ctx.state === 'running'; }

// The alarm is the entire point of the app, so we keep trying to earn the right
// to make a sound until we actually have it.
export function armOnFirstGesture(onReady) {
  const tryIt = async () => {
    const ok = await unlock();
    if (ok) {
      remove();
      if (onReady) onReady();
    }
  };
  const remove = () => {
    document.removeEventListener('pointerdown', tryIt, true);
    document.removeEventListener('keydown', tryIt, true);
    document.removeEventListener('visibilitychange', tryIt, true);
  };
  document.addEventListener('pointerdown', tryIt, true);
  document.addEventListener('keydown', tryIt, true);
  document.addEventListener('visibilitychange', tryIt, true);
  tryIt();
}

function tone({ freq, dur, gain = 0.25, type = 'sine', at = 0, slideTo = null }) {
  const c = audio();
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  // soft edges: a click is more startling than the tone itself
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.03);
  g.gain.setValueAtTime(gain, t0 + dur - 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Gentle two-note rise — "there is a sound in the room".
export function wake() {
  if (!running()) return;
  tone({ freq: 587.33, dur: 0.18, gain: 0.22, at: 0 });
  tone({ freq: 880.0, dur: 0.3, gain: 0.22, at: 0.16 });
  buzz([120, 60, 120]);
}

// Soft confirmation for taps.
export function blip(up = true) {
  if (!running()) return;
  tone({ freq: up ? 660 : 440, dur: 0.09, gain: 0.14, type: 'triangle' });
}

// Two-way talk push-to-talk edges.
export function talkOn() { if (running()) tone({ freq: 520, dur: 0.1, gain: 0.16, type: 'triangle' }); }
export function talkOff() { if (running()) tone({ freq: 390, dur: 0.12, gain: 0.14, type: 'triangle' }); }

// The alarm you cannot ignore. Repeats until stopDead() is called.
export function startDead() {
  if (deadPlaying) return;
  deadPlaying = true;
  const cycle = () => {
    if (!deadPlaying) return;
    if (running()) {
      for (let i = 0; i < 3; i++) {
        tone({ freq: 990, dur: 0.16, gain: 0.42, type: 'square', at: i * 0.24, slideTo: 660 });
      }
    }
    buzz([300, 120, 300, 120, 300]);
    deadTimer = setTimeout(cycle, 1600);
  };
  cycle();
}

export function stopDead() {
  deadPlaying = false;
  clearTimeout(deadTimer);
  deadTimer = null;
}

export function deadIsPlaying() { return deadPlaying; }

// Vibration is ignored by Chrome while the page is hidden, so it is a bonus,
// never the thing we rely on.
export function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* unsupported */ }
}

// A system notification is the third channel: it survives the screen being off
// and shows on the lock screen, as long as the page itself is still alive.
export function notify(title, body, tag = 'vuggevagt') {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, tag, renotify: true, silent: false, icon: 'icons/icon-192.png' });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { /* some Android builds require the service worker instead */ }
}
