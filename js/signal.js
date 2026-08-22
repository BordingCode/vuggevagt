// The connection-setup channel to the Worker.
//
// It is only needed to get the two phones talking. Once the WebRTC data channel
// is open the app sends its signalling through THAT instead (see peer.js), and
// the parent phone drops this socket entirely — every socket kept open at night
// is a radio wake-up, and the parent phone is the one running on battery.

export const SIGNAL_URL = 'wss://vuggevagt-signal.mathiasjob.workers.dev';
export const API_URL = 'https://vuggevagt-signal.mathiasjob.workers.dev';

const KEEPALIVE_MS = 25000; // NATs drop idle sockets long before this

export class Signal extends EventTarget {
  constructor({ code, peerId, role }) {
    super();
    this.code = code;
    this.peerId = peerId;
    this.role = role;
    this.ws = null;
    this.want = false;      // should we be connected right now?
    this.tries = 0;
    this.timer = null;
    this.ka = null;
  }

  get open() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  connect() {
    this.want = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = `${SIGNAL_URL}/room/${this.code}?peer=${this.peerId}&role=${this.role}`;
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.retry(); return; }
    this.ws = ws;

    ws.onopen = () => {
      this.tries = 0;
      this.emit('open');
      clearInterval(this.ka);
      this.ka = setInterval(() => { if (this.open) this.ws.send('ping'); }, KEEPALIVE_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      this.emit('msg', msg);
    };
    ws.onclose = (e) => {
      clearInterval(this.ka);
      this.emit('close', { code: e.code, reason: e.reason });
      // 4001 unbonded / 403 rejected: do not hammer the server, the app must react
      if (e.code === 4001) { this.want = false; this.emit('rejected', { reason: e.reason || 'unbonded' }); return; }
      if (this.want) this.retry();
    };
    ws.onerror = () => { /* onclose always follows */ };
  }

  retry() {
    clearTimeout(this.timer);
    const wait = Math.min(30000, 800 * Math.pow(1.7, Math.min(this.tries++, 8)));
    this.timer = setTimeout(() => { if (this.want) this.connect(); }, wait);
  }

  send(obj) {
    if (!this.open) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  // Let it go, but be ready to come back the moment the peer link wobbles.
  sleep() {
    this.want = false;
    clearTimeout(this.timer);
    clearInterval(this.ka);
    if (this.ws) { try { this.ws.close(1000, 'sleeping'); } catch (e) { /* already gone */ } }
    this.ws = null;
    this.emit('sleep');
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

// STUN is enough for most home networks; TURN (if configured on the Worker)
// covers mobile networks that refuse to let two phones talk directly.
export async function iceServers() {
  try {
    const r = await fetch(`${API_URL}/ice`, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (d.iceServers && d.iceServers.length) return d.iceServers;
    }
  } catch (e) { /* offline or blocked — fall back below */ }
  return [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
}
