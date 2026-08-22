// The phone-to-phone link.
//
// Audio never touches a server: WebRTC negotiates the shortest path between the
// two phones and encrypts the media end-to-end (DTLS-SRTP is not optional in
// WebRTC — there is no unencrypted mode).
//
// Two things here matter for battery, both on the Opus encoder:
//   usedtx=1  — during silence Opus sends a tiny "still quiet" frame instead of
//               a full stream. A sleeping nursery costs almost no radio at all.
//   ptime=60  — 60ms packets instead of 20ms: a third of the packet rate, and
//               it is packet rate, not bytes, that keeps a phone radio awake.
// The 40ms of extra delay is irrelevant when you are listening to a cot.

const OPUS_BITRATE = 24000;

export class Peer extends EventTarget {
  constructor({ role, signal }) {
    super();
    this.role = role;
    this.polite = role === 'parent';   // the baby leads, the parent yields
    this.signal = signal;
    this.pc = null;
    this.dc = null;
    this.localTrack = null;
    this.talkTrack = null;
    this.talkSender = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingRemoteAnswer = false;
    this.lastHb = 0;
    this.hbTimer = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  emit(t, d) { this.dispatchEvent(new CustomEvent(t, { detail: d })); }

  // Prefer the peer link for signalling — it keeps the server (and the parent
  // phone's radio) out of the loop once the two phones have found each other.
  //
  // But ONLY while the connection is genuinely up. A data channel reports
  // 'open' for a while after the other phone has vanished, so trusting it
  // during a repair posts the reconnect offer into a void and the two phones
  // never find each other again. When in doubt, use the server.
  post(msg, forceSocket = false) {
    const healthy = this.pc && this.pc.connectionState === 'connected';
    if (!forceSocket && healthy && this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(msg)); return true; } catch (e) { /* fall through */ }
    }
    return this.signal.send(msg);
  }

  async build(iceServers) {
    this.teardown();
    if (iceServers) this.iceServers = iceServers;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    this.pc = pc;

    pc.onicecandidate = ({ candidate }) => { if (candidate) this.post({ t: 'ice', c: candidate.toJSON() }); };

    pc.ontrack = ({ track, streams }) => {
      this.emit('track', { track, stream: streams[0] || new MediaStream([track]) });
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription(await this.offerWithOpusTuning(pc));
        this.post({ t: 'sdp', sdp: pc.localDescription });
      } catch (e) {
        this.emit('error', { where: 'negotiation', error: e });
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.emit('state', { state: s });
      if (s === 'failed') this.restartIce();
    };

    pc.ondatachannel = ({ channel }) => this.attachChannel(channel);

    // The baby owns the control channel, so exactly one side creates it.
    if (this.role === 'baby') {
      this.attachChannel(pc.createDataChannel('ctl', { ordered: true }));
    }
    return pc;
  }

  attachChannel(ch) {
    this.dc = ch;
    ch.onopen = () => {
      this.lastHb = Date.now();
      this.emit('channel', { open: true });
      this.startHeartbeat();
    };
    ch.onclose = () => { this.emit('channel', { open: false }); this.stopHeartbeat(); };
    ch.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.t === 'hb') { this.lastHb = Date.now(); this.emit('hb'); return; }
      this.handle(m);
    };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    // 2s: fast enough that a dead link is obvious within seconds, slow enough
    // to be invisible on the battery.
    this.hbTimer = setInterval(() => {
      if (this.dc && this.dc.readyState === 'open') {
        try { this.dc.send(JSON.stringify({ t: 'hb' })); } catch (e) { /* closing */ }
      }
    }, 2000);
  }

  stopHeartbeat() { clearInterval(this.hbTimer); this.hbTimer = null; }

  silentFor() { return this.lastHb ? Date.now() - this.lastHb : Infinity; }

  // ---- signalling (arrives from either transport) ---------------------------
  async handle(msg) {
    if (!msg || !this.pc) return;
    const pc = this.pc;

    if (msg.t === 'sdp') {
      const desc = msg.sdp;
      const offerCollision = desc.type === 'offer'
        && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      try {
        if (desc.type === 'answer' && pc.signalingState === 'stable') return; // duplicate
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription(await this.answerWithOpusTuning(pc));
          this.post({ t: 'sdp', sdp: pc.localDescription });
        }
      } catch (e) { this.emit('error', { where: 'sdp', error: e }); }
      return;
    }

    if (msg.t === 'ice') {
      try { await pc.addIceCandidate(msg.c); }
      catch (e) { if (!this.ignoreOffer) this.emit('error', { where: 'ice', error: e }); }
      return;
    }

    this.emit('ctl', msg); // lvl / blind / talk / bye — the app decides
  }

  // ---- Opus tuning ----------------------------------------------------------
  async offerWithOpusTuning(pc) {
    const offer = await pc.createOffer();
    offer.sdp = tuneOpus(offer.sdp);
    return offer;
  }

  async answerWithOpusTuning(pc) {
    const answer = await pc.createAnswer();
    answer.sdp = tuneOpus(answer.sdp);
    return answer;
  }

  async setMicTrack(track) {
    this.localTrack = track;
    if (!this.pc) return;
    const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'audio' && s.track === this.localTrack);
    if (!sender) this.pc.addTrack(track, new MediaStream([track]));
    await this.capBitrate();
  }

  // Talk-back: added late and on purpose, so the parent phone never asks for
  // microphone permission until the moment it is actually used.
  async setTalkTrack(track) {
    this.talkTrack = track;
    if (!this.pc) return;
    if (this.talkSender) await this.talkSender.replaceTrack(track);
    else this.talkSender = this.pc.addTrack(track, new MediaStream([track]));
    await this.capBitrate();
  }

  async capBitrate() {
    if (!this.pc) return;
    for (const sender of this.pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'audio') continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = OPUS_BITRATE;
        p.encodings[0].networkPriority = 'high';
        await sender.setParameters(p);
      } catch (e) { /* not fatal — the SDP cap still applies */ }
    }
  }

  async restartIce() {
    if (!this.pc || this.role !== 'baby') return; // one side leads the repair
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer({ iceRestart: true });
      offer.sdp = tuneOpus(offer.sdp);
      await this.pc.setLocalDescription(offer);
      this.post({ t: 'sdp', sdp: this.pc.localDescription });
    } catch (e) {
      this.emit('error', { where: 'ice-restart', error: e });
    } finally { this.makingOffer = false; }
  }

  async stats() {
    if (!this.pc) return null;
    const out = { bitrate: 0, packets: 0, rtt: null, candidateType: null, bytes: 0 };
    try {
      const report = await this.pc.getStats();
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.packets = r.packetsReceived || 0; out.bytes = r.bytesReceived || 0; }
        if (r.type === 'outbound-rtp' && r.kind === 'audio' && !out.bytes) { out.packets = r.packetsSent || 0; out.bytes = r.bytesSent || 0; }
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          out.rtt = r.currentRoundTripTime != null ? Math.round(r.currentRoundTripTime * 1000) : null;
          const local = report.get(r.localCandidateId);
          if (local) out.candidateType = local.candidateType; // 'relay' means TURN is carrying it
        }
      });
    } catch (e) { /* stats are best-effort */ }
    return out;
  }

  teardown() {
    this.stopHeartbeat();
    if (this.dc) { try { this.dc.close(); } catch (e) { /* ignore */ } this.dc = null; }
    if (this.pc) { try { this.pc.close(); } catch (e) { /* ignore */ } this.pc = null; }
    this.talkSender = null;
    this.makingOffer = false;
    this.settingRemoteAnswer = false;
  }
}

// Rewrite the Opus parameters in an SDP blob. Touching only the fmtp/ptime
// lines is one of the few SDP edits that is safe and well-supported.
export function tuneOpus(sdp) {
  const lines = sdp.split(/\r\n|\n/);
  const payloads = new Set();
  for (const l of lines) {
    const m = l.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) payloads.add(m[1]);
  }
  if (!payloads.size) return sdp;

  const wanted = {
    stereo: '0',
    'sprop-stereo': '0',
    useinbandfec: '1',
    usedtx: '1',                       // near-silence during a quiet nursery
    maxaveragebitrate: String(OPUS_BITRATE),
    ptime: '60',
    maxptime: '60',
    minptime: '10',
  };

  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const fm = line.match(/^a=fmtp:(\d+) (.*)$/);
    if (fm && payloads.has(fm[1])) {
      const params = new Map();
      for (const part of fm[2].split(';')) {
        const [k, v] = part.split('=');
        if (k) params.set(k.trim(), (v || '').trim());
      }
      for (const [k, v] of Object.entries(wanted)) params.set(k, v);
      out.push(`a=fmtp:${fm[1]} ` + [...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';'));
      seen.add(fm[1]);
      continue;
    }
    if (/^a=ptime:/.test(line) || /^a=maxptime:/.test(line)) continue; // re-added below
    out.push(line);
  }

  // Any opus payload that had no fmtp line at all gets one, and the standalone
  // ptime attribute rides just after the rtpmap — attributes are unordered
  // among themselves, but they must not jump ahead of the m=/c= lines.
  const final = [];
  for (const line of out) {
    final.push(line);
    const rm = line.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (rm) {
      if (!seen.has(rm[1])) {
        final.push(`a=fmtp:${rm[1]} ` + Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';'));
      }
      final.push('a=ptime:60');
      final.push('a=maxptime:60');
    }
  }
  return final.join('\r\n');
}
