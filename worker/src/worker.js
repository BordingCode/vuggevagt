// Vuggevagt signalling server.
//
// This server NEVER sees or hears any audio. Its only job is to let two phones
// that already share a pairing code find each other and exchange the connection
// details WebRTC needs. Once the two phones are talking, the audio flows
// directly between them, encrypted end-to-end (DTLS-SRTP).
//
// One Durable Object per room, addressed by the pairing code. The room bonds
// itself to the first two devices that ever join; after that nobody else can
// get in even if they learn the code.

const ROLES = ['baby', 'parent'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Answer the client's keepalive without waking the object up — an idle
    // room costs nothing while it holds two sockets open all night.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/unbond') {
      const peer = url.searchParams.get('peer');
      const bonded = (await this.ctx.storage.get('bonded')) || [];
      // only a device that is already part of the pair may break the pair
      if (!bonded.includes(peer)) return json({ error: 'not bonded' }, 403);
      await this.ctx.storage.deleteAll();
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'unbonded');
      return json({ ok: true });
    }

    if (url.pathname === '/status') {
      const bonded = (await this.ctx.storage.get('bonded')) || [];
      const live = this.ctx.getWebSockets().map((ws) => this.ctx.getTags(ws)[0]).filter(Boolean);
      return json({ bonded: bonded.length, online: live });
    }

    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426, headers: cors });
    }

    const peer = url.searchParams.get('peer');
    const role = url.searchParams.get('role');
    if (!peer || peer.length < 8 || !ROLES.includes(role)) {
      return new Response('bad request', { status: 400, headers: cors });
    }

    // --- the bond: first two devices to ever use this code own it forever ----
    let bonded = (await this.ctx.storage.get('bonded')) || [];
    if (!bonded.includes(peer)) {
      if (bonded.length >= 2) {
        return new Response('this pairing code already belongs to two other devices', {
          status: 403, headers: cors,
        });
      }
      bonded = [...bonded, peer];
      await this.ctx.storage.put('bonded', bonded);
    }

    // one socket per role — a reconnect replaces the stale one
    for (const old of this.ctx.getWebSockets(role)) {
      try { old.close(4002, 'replaced by a newer connection'); } catch (e) { /* already gone */ }
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role, peer]);
    server.serializeAttachment({ role, peer });

    // tell the newcomer who else is already here, and announce them to the other side
    const otherRole = role === 'baby' ? 'parent' : 'baby';
    const others = this.ctx.getWebSockets(otherRole);
    this.send(server, { t: 'hello', role, peerPresent: others.length > 0, bonded: bonded.length });
    for (const ws of others) this.send(ws, { t: 'peer-joined', role });

    return new Response(null, { status: 101, webSocket: client });
  }

  // Relay: anything a peer sends is forwarded verbatim to the other role.
  // The server does not inspect or store offers, answers or candidates.
  webSocketMessage(ws, raw) {
    const { role } = ws.deserializeAttachment() || {};
    if (!role) return;
    if (raw === 'ping') return; // handled by auto-response, but be safe
    const otherRole = role === 'baby' ? 'parent' : 'baby';
    const targets = this.ctx.getWebSockets(otherRole);
    if (!targets.length) {
      this.send(ws, { t: 'no-peer' });
      return;
    }
    for (const t of targets) {
      try { t.send(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (e) { /* dropped */ }
    }
  }

  webSocketClose(ws) { this.announceGone(ws); }
  webSocketError(ws) { this.announceGone(ws); }

  announceGone(ws) {
    const { role } = ws.deserializeAttachment() || {};
    if (!role) return;
    const otherRole = role === 'baby' ? 'parent' : 'baby';
    for (const other of this.ctx.getWebSockets(otherRole)) {
      this.send(other, { t: 'peer-left', role });
    }
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket already closing */ }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname === '/') {
      return json({ ok: true, service: 'vuggevagt-signal', note: 'relays connection setup only; never audio' });
    }

    // Short-lived TURN credentials, minted server-side so the account keys
    // never reach a phone. Falls back to plain STUN when TURN is not set up.
    if (url.pathname === '/ice') {
      const ice = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
      if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
        try {
          const r = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ttl: 86400 }),
            },
          );
          if (r.ok) {
            const data = await r.json();
            if (data.iceServers) return json({ iceServers: [].concat(data.iceServers, ice) });
          }
        } catch (e) { /* fall through to STUN-only */ }
      }
      return json({ iceServers: ice });
    }

    // /room/<code>  — websocket, or /room/<code>/unbond, /room/<code>/status
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9-]{4,40})(\/unbond|\/status)?$/);
    if (!m) return new Response('not found', { status: 404, headers: cors });

    const code = m[1].toUpperCase();
    const id = env.ROOM.idFromName(code);
    const stub = env.ROOM.get(id);
    const inner = new URL(req.url);
    inner.pathname = m[2] || '/ws';
    return stub.fetch(new Request(inner, req));
  },
};
