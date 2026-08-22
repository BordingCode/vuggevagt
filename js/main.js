// Vuggevagt — boot, screens and the two roles.
//
// Baby phone : holds the microphone, measures the room, sends audio + levels.
// Parent phone: plays the audio, decides when a noise counts, raises the alarm.
//
// The alarm logic lives on the parent side on purpose — that is where the
// settings are, and it means no round trip before you get woken up.

import { S, load, save, set, newCode, pretty, normalise, forgetPairing } from './store.js';
import { Signal, iceServers, API_URL } from './signal.js';
import { Peer } from './peer.js';
import { Meter, NoiseGate, sensToDb, dbToBar } from './meter.js';
import * as Alarm from './alarm.js';
import { Battery, batteryText, batteryWarning } from './battery.js';

const $ = (s) => document.querySelector(s);
const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

const DEAD_MS = 8000;          // no heartbeat for this long = the link is gone
const HOLD_STEPS = [0, 500, 1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 15000];

let signal = null;
let peer = null;
let meter = null;
let gate = null;
let micStream = null;
let talkStream = null;
let wakeLock = null;
let watchdog = null;
let statsTimer = null;
let driftTimer = null;
let panelTimer = null;
let repairTimer = null;
let deadReason = null;   // 'link' heals by itself; 'blind' must not
let battery = null;
let saver = false;       // unplugged: spend as little as possible on the screen
let lastLvlSent = 0;
let lastPaint = 0;
let lvlPeak = -90;
let babyBat = null;      // the parent's copy of the baby phone's battery
let batWarned = null;
let lastLevelDb = -90;
let linkDead = false;
let alertActive = false;
let started = false;

// ---------------------------------------------------------------- screens ---
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.body.classList.toggle('night-mode', id === 'scr-baby');
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------- boot ---
function boot() {
  load();

  // a shared link carries the code: .../#p=ABCD2345
  const hash = new URLSearchParams(location.hash.slice(1));
  const linked = normalise(hash.get('p'));
  if (linked && linked.length === 8) {
    set({ code: linked, role: S.role === 'baby' ? 'baby' : 'parent' });
    history.replaceState(null, '', location.pathname + location.search);
    $('#code-input').value = pretty(linked);
  }

  wireUi();
  // Earn the right to make a sound as early as possible, and keep trying.
  Alarm.armOnFirstGesture(() => { const b = document.querySelector('#audio-hint'); if (b) b.hidden = true; });

  if (S.role === 'baby' && S.code) return show('scr-pair-baby'), showBabyCode();
  if (S.role === 'parent' && S.code) return startParent();
  show('scr-welcome');
}

function wireUi() {
  on('#pick-baby', 'click', () => {
    if (!S.code) set({ code: newCode() });
    set({ role: 'baby' });
    showBabyCode();
    show('scr-pair-baby');
  });
  on('#pick-parent', 'click', () => {
    set({ role: 'parent' });
    if (S.code) $('#code-input').value = pretty(S.code);
    show('scr-pair-parent');
    $('#code-input').focus();
  });
  on('#go-help', 'click', () => show('scr-help'));
  on('#help-back', 'click', () => show(S.role === 'parent' && started ? 'scr-parent' : 'scr-welcome'));
  on('#baby-back', 'click', () => { forgetPairing(); show('scr-welcome'); });
  on('#parent-back', 'click', () => { forgetPairing(); show('scr-welcome'); });

  on('#btn-share', 'click', async () => {
    const url = `${location.origin}${location.pathname}#p=${S.code}`;
    const text = `Vuggevagt-kode: ${pretty(S.code)}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Vuggevagt', text, url });
      else { await navigator.clipboard.writeText(url); toast('Link kopieret'); }
    } catch (e) { /* the user closed the share sheet */ }
  });
  on('#btn-copy', 'click', async () => {
    try { await navigator.clipboard.writeText(pretty(S.code)); toast('Kode kopieret'); }
    catch (e) { toast('Kunne ikke kopiere — skriv koden af'); }
  });

  on('#btn-start-baby', 'click', () => startBaby());
  on('#baby-stop', 'click', () => stopAll('scr-pair-baby'));
  on('#baby-reset', 'click', () => unpair());
  on('#parent-stop', 'click', () => stopAll('scr-welcome'));

  on('#code-input', 'input', (e) => {
    const raw = normalise(e.target.value).slice(0, 8);
    e.target.value = raw.length > 4 ? raw.slice(0, 4) + '-' + raw.slice(4) : raw;
  });
  on('#btn-join', 'click', () => {
    const code = normalise($('#code-input').value);
    if (code.length !== 8) { $('#join-status').textContent = 'Koden er 8 tegn.'; return; }
    set({ code, role: 'parent' });
    startParent();
  });

  // --- parent controls
  on('#volume', 'input', (e) => {
    set({ volume: e.target.value / 100 });
    applyVolume();
  });
  on('#sens', 'input', (e) => {
    set({ sens: +e.target.value });
    if (gate) gate.set(sensToDb(S.sens));
    paintThreshold();
  });
  on('#vox', 'change', (e) => { set({ vox: e.target.checked }); applyVolume(); });
  on('#parent-settings', 'click', () => show('scr-settings'));
  on('#settings-back', 'click', () => show(started ? 'scr-parent' : 'scr-welcome'));
  on('#hold', 'input', (e) => {
    const ms = HOLD_STEPS[+e.target.value];
    set({ holdMs: ms });
    $('#hold-val').textContent = (ms / 1000).toFixed(1).replace('.', ',');
    if (gate) gate.set(sensToDb(S.sens), ms);
  });
  on('#btn-notify', 'click', async () => {
    try {
      const p = await Notification.requestPermission();
      set({ notify: p === 'granted' });
      toast(p === 'granted' ? 'Notifikationer slået til' : 'Ikke tilladt');
    } catch (e) { toast('Notifikationer understøttes ikke her'); }
  });
  on('#btn-test-alarm', 'click', async () => {
    await Alarm.unlock();
    toast('Alarmen lyder om 5 sekunder — sluk skærmen nu');
    setTimeout(() => { Alarm.startDead(); setTimeout(() => Alarm.stopDead(), 6000); }, 5000);
  });
  on('#btn-unpair', 'click', () => unpair());
  on('#alert-dismiss', 'click', () => clearAlert(true));

  // hold-to-talk
  const talk = $('#talk-btn');
  const down = (e) => { e.preventDefault(); startTalking(); };
  const up = (e) => { e.preventDefault(); stopTalking(); };
  talk.addEventListener('pointerdown', down);
  talk.addEventListener('pointerup', up);
  talk.addEventListener('pointercancel', up);
  talk.addEventListener('pointerleave', up);

  document.addEventListener('visibilitychange', onVisibility);
}

// -------------------------------------------------------------- baby side ---
function showBabyCode() {
  $('#code-show').textContent = pretty(S.code);
}

async function startBaby() {
  if (started) return;
  try {
    Alarm.unlock();  // fire and forget — a tap already happened, but never block on it
    // ?fakemic=1 swaps the microphone for a generated tone, so the whole chain
    // can be tested on a machine with no microphone and no permission prompt.
    micStream = new URLSearchParams(location.search).has('fakemic')
      ? window.__vv.fakeMic()
      : await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,   // needed, or talk-back howls
          noiseSuppression: false,  // we WANT the faint sounds
          autoGainControl: false,   // keep the level meter honest
        },
      });
  } catch (e) {
    $('#pair-status').textContent = 'Ingen adgang til mikrofonen. Tillad mikrofon i browseren og prøv igen.';
    return;
  }

  started = true;
  show('scr-baby');
  revealPanel();

  meter = new Meter();
  await meter.start(micStream);
  meter.addEventListener('level', ({ detail }) => {
    lastLevelDb = detail.db;
    if (detail.db > lvlPeak) lvlPeak = detail.db;

    // Only paint what is actually on screen. On the dark night screen the panel
    // is hidden, so painting its bars is pure battery burnt for nobody.
    const panelOpen = document.body.classList.contains('panel-open');
    if (panelOpen) paintBar('#baby-fill', detail.db);
    const now = Date.now();
    const paintEvery = saver ? 1000 : 200;
    if (now - lastPaint >= paintEvery) { paintBar('#baby-mini-fill', lvlPeak); lastPaint = now; }

    // Send the PEAK since the last message, never the latest sample: throttling
    // to save radio must not let a short cry slip through between packets.
    const sendEvery = saver ? 500 : 200;
    if (peer && now - lastLvlSent >= sendEvery) {
      peer.post({ t: 'lvl', v: Math.round(lvlPeak) });
      lastLvlSent = now;
      lvlPeak = -90;
    }
  });

  await connect();
  await acquireWakeLock();
  startDrift();
  startStats('#baby-stats');

  // A phone in a pram is not on a charger, and then the screen we are forced to
  // keep on is the whole budget. Measure it, say it out loud, and spend less.
  battery = new Battery();
  // listen BEFORE starting: the first reading is emitted during start()
  battery.addEventListener('change', ({ detail }) => {
    setSaver(!detail.charging);
    const line = $('#baby-battery');
    if (line) line.textContent = batteryText(detail);
    if (peer) peer.post({ t: 'bat', b: detail });
  });
  if (!(await battery.start())) {
    const line = $('#baby-battery');
    if (line) line.textContent = 'Batteristatus kan ikke aflæses i denne browser — hold selv øje med strømmen.';
  }
}

// Keeping the screen awake is the whole reason the baby phone works at all.
async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator)) { babyWarn('Denne browser kan ikke holde skærmen tændt — sæt skærmtimeout til "aldrig".'); return; }
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    babyWarn(null);
  } catch (e) {
    babyWarn('Kunne ikke holde skærmen tændt. Sæt skærmtimeout til "aldrig" i telefonens indstillinger.');
  }
}

// Off the charger every repaint counts, so the night screen stops breathing
// and the little meter updates once a second instead of ten times.
function setSaver(on) {
  if (saver === on) return;
  saver = on;
  document.body.classList.toggle('saver', on);
  const note = $('#baby-note');
  if (note) {
    note.textContent = on
      ? 'Ikke i opladning — skærmen skal blive tændt for at mikrofonen virker, så batteriet løber ud. Se hvor lang tid der er tilbage nedenfor.'
      : 'Skærmen skal blive tændt, ellers lukker Android for mikrofonen.';
  }
}

function babyWarn(msg) {
  const el = $('#baby-warn');
  el.hidden = !msg;
  if (msg) el.textContent = '⚠ ' + msg;
}

// The panel is hidden after a few seconds so the room goes properly dark.
function revealPanel() {
  document.body.classList.add('panel-open');
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => document.body.classList.remove('panel-open'), 8000);
}

// A screen that is lit for eight hours a night, every night, will burn its
// image into an OLED panel. Drift the few lit pixels slowly around.
function startDrift() {
  clearInterval(driftTimer);
  let step = 0;
  const move = () => {
    const el = $('#baby-drift');
    if (!el) return;
    const a = (step++ * Math.PI) / 6;
    el.style.transform = `translate(${Math.cos(a) * 34}px, ${Math.sin(a) * 52}px)`;
  };
  move();
  driftTimer = setInterval(move, 60000);
}

// ------------------------------------------------------------ parent side ---
async function startParent() {
  if (started) return;   // the #p= link already started us
  started = true;
  show('scr-parent');
  Alarm.unlock().then(showAudioHint);

  $('#volume').value = Math.round(S.volume * 100);
  $('#sens').value = S.sens;
  $('#vox').checked = S.vox;
  $('#hold').value = Math.max(0, HOLD_STEPS.indexOf(S.holdMs)) || 3;
  $('#hold-val').textContent = (S.holdMs / 1000).toFixed(1).replace('.', ',');
  paintThreshold();

  gate = new NoiseGate({ thresholdDb: sensToDb(S.sens), holdMs: S.holdMs });

  await connect();
  startStats('#parent-stats');
  startWatchdog();
}

// If the browser will not let us make a sound yet, the alarm is mute — and a
// mute baby monitor is the one failure the user must never be unaware of.
function showAudioHint() {
  const el = document.querySelector('#audio-hint');
  if (!el) return;
  el.hidden = Alarm.running();
}

function applyVolume() {
  const a = $('#remote-audio');
  // Never mute and never truly zero: a silent element lets Android treat the
  // page as "not playing media" and freeze it. A whisper keeps it alive.
  const quiet = S.vox && !alertActive;
  a.volume = quiet ? 0.05 : Math.max(0.05, S.volume);
  a.muted = false;
}

function paintThreshold() {
  const pct = dbToBar(sensToDb(S.sens)) * 100;
  document.querySelectorAll('#parent-thresh, #baby-thresh').forEach((el) => { el.style.left = pct + '%'; });
  const val = $('#sens-val');
  if (val) val.textContent = Math.round(sensToDb(S.sens)) + ' dB';
}

function paintBar(sel, db) {
  const el = $(sel);
  if (!el) return;
  el.style.width = (dbToBar(db) * 100).toFixed(1) + '%';
  el.classList.toggle('hot', db >= sensToDb(S.sens));
}

// The parent phone's judgement: is this noise worth waking someone for?
function onLevel(db) {
  lastLevelDb = db;
  paintBar('#parent-fill', db);
  $('#parent-level').textContent = db <= -89 ? 'helt stille' : Math.round(db) + ' dB';
  if (!gate) return;
  const edge = gate.push(db);
  if (edge === 'rise') raiseAlert();
  else if (edge === 'fall') clearAlert(false);
}

// The baby phone's battery is the parent phone's problem: when it dies, the
// monitoring stops. Warn well before that, not after.
function onBabyBattery(b) {
  babyBat = b;
  const el = $('#baby-battery-line');
  if (el) {
    el.textContent = b.pct == null ? '' : `Barnets telefon: ${batteryText(b)}`;
    el.hidden = b.pct == null;
    el.classList.toggle('warn', !b.charging && b.pct != null && b.pct <= 20);
  }
  const w = batteryWarning(b);
  if (!w) { batWarned = null; return; }
  if (batWarned === w.level) return;      // say each step once, not every minute
  batWarned = w.level;
  toast(w.text, 6000);
  Alarm.notify('Vuggevagt', w.text);
  if (w.level === 'critical') { Alarm.wake(); Alarm.buzz([300, 150, 300]); }
}

function raiseAlert() {
  if (alertActive) return;
  alertActive = true;
  applyVolume();
  $('#alert-banner').hidden = false;
  $('#alert-title').textContent = 'Barnet gør lyd';
  $('#alert-sub').textContent = new Date().toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  Alarm.wake();
  Alarm.notify('Vuggevagt', 'Barnet gør lyd');
  document.body.classList.add('alerting');
}

function clearAlert(byHand) {
  if (!alertActive && !byHand) return;
  alertActive = false;
  applyVolume();
  $('#alert-banner').hidden = true;
  document.body.classList.remove('alerting');
  if (gate) { gate.active = false; gate.overSince = 0; }
}

// --------------------------------------------------------------- the link ---
async function connect() {
  const ice = await iceServers();

  signal = new Signal({ code: S.code, peerId: S.peerId, role: S.role });
  peer = new Peer({ role: S.role, signal });
  await peer.build(ice);

  if (S.role === 'baby' && micStream) {
    await peer.setMicTrack(micStream.getAudioTracks()[0]);
  }

  peer.addEventListener('track', ({ detail }) => {
    const el = S.role === 'parent' ? $('#remote-audio') : $('#baby-audio');
    el.srcObject = detail.stream;
    el.play().catch(() => { /* autoplay is allowed: we came from a tap */ });
    if (S.role === 'parent') {
      applyVolume();
      setupMediaSession();
    }
  });

  peer.addEventListener('ctl', ({ detail }) => {
    if (detail.t === 'lvl' && S.role === 'parent') onLevel(detail.v);
    if (detail.t === 'bat' && S.role === 'parent') onBabyBattery(detail.b);
    if (detail.t === 'blind') babyWentBlind(detail.on);
    if (detail.t === 'talk' && S.role === 'baby') halfDuplex(detail.on);
    if (detail.t === 'bye') markDead('Den anden telefon blev stoppet');
  });

  peer.addEventListener('state', ({ detail }) => {
    const s = detail.state;
    if (s === 'connected') onLinkUp();
    if (s === 'failed' || s === 'closed') onLinkTrouble();
    if (s === 'disconnected') {
      setPill('Mistede forbindelsen…', 'warn');
      // ICE can sit in 'disconnected' indefinitely when the other phone simply
      // disappears, so don't wait for 'failed' that may never come.
      clearTimeout(repairTimer);
      repairTimer = setTimeout(() => {
        if (peer && peer.pc && peer.pc.connectionState !== 'connected') { onLinkTrouble(); rebuild(); }
      }, 5000);
    }
    if (s === 'connected') clearTimeout(repairTimer);
  });

  peer.addEventListener('channel', ({ detail }) => {
    if (detail.open) onLinkUp();
  });

  signal.addEventListener('msg', ({ detail }) => {
    const m = detail;
    if (m.t === 'hello') {
      setPill(m.peerPresent ? 'Forbinder…' : 'Venter på den anden telefon…', 'warn');
      // the baby leads: if the parent is already here, start the handshake
      if (S.role === 'baby' && m.peerPresent) kick();
      return;
    }
    if (m.t === 'peer-joined') {
      // The other phone has a brand-new, empty connection — reusing our old one
      // half-works at best. Start clean; it is the one path that always works.
      if (S.role === 'baby') rebuild();
      return;
    }
    if (m.t === 'peer-left') {
      // an old socket closing must not scare us while the phones are actually
      // talking to each other — the peer link is the source of truth
      if (!peer || !peer.pc || peer.pc.connectionState !== 'connected') {
        setPill('Den anden telefon forsvandt', 'warn');
      }
      return;
    }
    if (m.t === 'no-peer') return;
    peer.handle(m);
  });

  // A socket that (re)opens after a wobble may be holding an offer that never
  // reached anyone. Push it again rather than waiting for the other side.
  signal.addEventListener('open', () => {
    if (S.role === 'baby' && peer && peer.pc && peer.pc.connectionState !== 'connected') kick();
  });

  signal.addEventListener('rejected', ({ detail }) => {
    setPill('Parringen blev nulstillet', 'bad');
    toast('Parringen er nulstillet på den anden telefon');
  });

  signal.connect();
}

// Throw the connection away and start a fresh one. Deliberately blunt: during
// a night-time repair, "start over" beats "work out what survived".
let rebuilding = false;
async function rebuild() {
  if (!peer || rebuilding || S.role !== 'baby') return;
  rebuilding = true;
  try {
    if (signal && !signal.open) signal.connect();
    const ice = await iceServers();
    await peer.build(ice);
    if (micStream) await peer.setMicTrack(micStream.getAudioTracks()[0]);
    // negotiationneeded fires from the track above; send it over the server,
    // because by definition we have no working peer link right now
    await new Promise((r) => setTimeout(r, 250));
    if (peer.pc && peer.pc.localDescription) peer.post({ t: 'sdp', sdp: peer.pc.localDescription }, true);
  } catch (e) {
    /* the watchdog will come round again */
  } finally { rebuilding = false; }
}

// Nudge the negotiation. Adding the microphone track fires negotiationneeded
// immediately — usually before the socket is even open and long before the
// other phone arrives — so that first offer goes nowhere. When the parent
// finally turns up we must re-send the offer we are already holding, not
// refuse because the connection is no longer "stable".
async function kick() {
  if (!peer || !peer.pc) return;
  const pc = peer.pc;
  if (pc.connectionState === 'connected') return;
  if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
    peer.post({ t: 'sdp', sdp: pc.localDescription }, true);
    return;
  }
  if (pc.signalingState !== 'stable') return;
  try {
    peer.makingOffer = true;
    await peer.pc.setLocalDescription(await peer.offerWithOpusTuning(peer.pc));
    peer.post({ t: 'sdp', sdp: peer.pc.localDescription }, true);
  } catch (e) { /* negotiationneeded will retry */ }
  finally { peer.makingOffer = false; }
}

function onLinkUp() {
  // A healthy network link does NOT mean we can hear the baby again. If the
  // baby phone told us its microphone was taken away, only the baby phone can
  // tell us it is back — otherwise a reconnect would quietly cancel the very
  // alarm that says "you are not being watched".
  if (linkDead && deadReason !== 'blind') clearDead();
  if (linkDead) return;   // still deaf: never paint a healthy status over an alarm
  setPill(S.role === 'parent' ? 'Lytter' : 'Forbundet', 'ok');
  // The battery only emits when it changes, which can be many minutes away.
  // Tell the parent where we stand the moment there is a link to tell it over.
  if (S.role === 'baby' && battery && peer) peer.post({ t: 'bat', b: battery.snapshot() });
  babyWarn(null);
  // The parent phone drops the signalling socket once the phones can talk
  // directly — every open socket is a radio wake-up all night long. The baby
  // phone is on a charger, so it stays reachable.
  if (S.role === 'parent' && signal) setTimeout(() => { if (!linkDead && peer && peer.dc && peer.dc.readyState === 'open') signal.sleep(); }, 10000);
}

function clearDead() {
  linkDead = false;
  deadReason = null;
  Alarm.stopDead();
  document.body.classList.remove('dead');
  $('#alert-banner').hidden = true;
}

function onLinkTrouble() {
  if (signal && !signal.open) signal.connect();   // wake the socket to repair
  setPill('Genopretter forbindelsen…', 'warn');
}

function startWatchdog() {
  clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (!peer) return;
    const quiet = peer.silentFor();
    showAudioHint();
    if (quiet > DEAD_MS) markDead('Ingen kontakt med telefonen ved barnet');
    // A blind baby phone still sends heartbeats for a while — its microphone is
    // gone, not its network. Only a genuine link failure may heal on its own.
    else if (linkDead && deadReason === 'link' && quiet < DEAD_MS) onLinkUp();
  }, 1000);
}

// The one alarm that matters: we are no longer watching, and you must know.
function markDead(reason, kind = 'link') {
  if (linkDead) return;
  linkDead = true;
  deadReason = kind;
  document.body.classList.add('dead');
  setPill('AFBRUDT', 'bad');
  if (S.role === 'parent') {
    Alarm.startDead();
    Alarm.notify('Vuggevagt — AFBRUDT', reason);
    $('#alert-banner').hidden = false;
    $('#alert-title').textContent = 'Forbindelsen er væk';
    $('#alert-sub').textContent = reason;
  }
  if (signal) signal.connect();
  if (peer) peer.restartIce();
  if (S.role === 'baby') rebuild();
}

// The baby phone lost focus: Android has taken its microphone away, even though
// the network link is still perfectly healthy. This is the failure that looks
// like nothing is wrong, which is exactly why it gets the loud alarm.
function babyWentBlind(blind) {
  if (S.role !== 'parent') return;
  if (blind === false) { clearDead(); onLinkUp(); return; }
  markDead('Telefonen ved barnet kom i baggrunden — mikrofonen er lukket', 'blind');
}

function setPill(text, kind) {
  ['#parent-pill', '#baby-pill'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = text;
    el.className = 'pill ' + (kind || '');
  });
}

// ------------------------------------------------------------- talk back ----
async function startTalking() {
  if (S.role !== 'parent' || !peer) return;
  try {
    if (!talkStream) {
      talkStream = new URLSearchParams(location.search).has('fakemic')
        ? window.__vv.fakeMic(320)
        : await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      await peer.setTalkTrack(talkStream.getAudioTracks()[0]);
    }
    talkStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    peer.post({ t: 'talk', on: true });
    $('#talk-btn').classList.add('live');
    Alarm.talkOn();
  } catch (e) {
    toast('Ingen adgang til mikrofonen på denne telefon');
  }
}

function stopTalking() {
  if (!talkStream) return;
  talkStream.getAudioTracks().forEach((t) => { t.enabled = false; });
  if (peer) peer.post({ t: 'talk', on: false });
  $('#talk-btn').classList.remove('live');
  Alarm.talkOff();
}

// While a parent is talking the baby phone stops sending, so the two speakers
// cannot feed into each other and scream.
function halfDuplex(talking) {
  if (!micStream) return;
  micStream.getAudioTracks().forEach((t) => { t.enabled = !talking; });
  const el = $('#baby-audio');
  if (el) el.volume = 1;
}

// -------------------------------------------------------------- lifecycle ---
async function onVisibility() {
  if (document.visibilityState === 'visible') {
    if (S.role === 'baby' && started) {
      await acquireWakeLock();          // Android takes the lock back when hidden
      if (meter) await meter.resume();
      revealPanel();
      if (peer) peer.post({ t: 'blind', on: false });   // we can hear again
    }
    if (meter) await meter.resume();
    return;
  }
  // hidden
  if (S.role === 'baby' && started) {
    // Tell the parent instantly rather than making them wait for the watchdog:
    // a backgrounded baby phone is a deaf baby phone.
    if (peer) peer.post({ t: 'blind', on: true });
  }
}

function startStats(sel) {
  clearInterval(statsTimer);
  let lastBytes = 0;
  let lastAt = Date.now();
  statsTimer = setInterval(async () => {
    if (!peer) return;
    const s = await peer.stats();
    if (!s) return;
    const now = Date.now();
    const kbps = lastBytes ? ((s.bytes - lastBytes) * 8) / (now - lastAt) : 0;
    lastBytes = s.bytes; lastAt = now;
    const path = s.candidateType === 'relay' ? 'via relæ' : s.candidateType ? 'direkte' : '—';
    const el = $(sel);
    if (el) el.textContent = `${path} · ${kbps.toFixed(1)} kbit/s${s.rtt != null ? ` · ${s.rtt} ms` : ''}`;
  }, 3000);
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Vuggevagt', artist: 'Lytter til barnet',
      artwork: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = 'playing';
    // Do not let a lock-screen tap silence the monitor by accident.
    navigator.mediaSession.setActionHandler('pause', () => {
      $('#remote-audio').play().catch(() => {});
      toast('Vuggevagt kører videre');
    });
  } catch (e) { /* not supported */ }
}

function stopAll(screen) {
  if (peer) peer.post({ t: 'bye' });
  started = false;
  clearInterval(watchdog); clearInterval(statsTimer); clearInterval(driftTimer);
  Alarm.stopDead();
  linkDead = false;
  document.body.classList.remove('dead', 'alerting', 'panel-open');
  if (peer) { peer.teardown(); peer = null; }
  if (signal) { signal.sleep(); signal = null; }
  if (meter) { meter.stop(); meter = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (talkStream) { talkStream.getTracks().forEach((t) => t.stop()); talkStream = null; }
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* gone */ } wakeLock = null; }
  show(screen);
}

async function unpair() {
  try {
    await fetch(`${API_URL}/room/${S.code}/unbond?peer=${S.peerId}`, { method: 'GET' });
  } catch (e) { /* offline — local state still clears */ }
  stopAll('scr-welcome');
  forgetPairing();
  toast('Parringen er glemt på begge telefoner');
}

// Test hooks. `?ns=` gives a tab its own storage so one machine can play both
// phones; the fake microphone lets the whole chain be tested without a device.
window.__vv = {
  get state() { return { ...S, started, linkDead, alertActive, lastLevelDb }; },
  get peer() { return peer; },
  get signal() { return signal; },
  stats: () => (peer ? peer.stats() : null),
  level: (db) => onLevel(db),
  saver: (on) => setSaver(on),          // pretend the charger was pulled out
  battery: () => (battery ? battery.snapshot() : null),
  fakeNoise(db = -20, ms = 2000) {   // pretend the room got loud
    const t0 = Date.now();
    const iv = setInterval(() => {
      onLevel(db);
      if (Date.now() - t0 > ms) { clearInterval(iv); onLevel(-85); }
    }, 100);
  },
  fakeMic(freq = 440) {              // a microphone that needs no permission
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    osc.frequency.value = freq;
    gain.gain.value = 0.0005;        // near silence until loud() is called
    osc.connect(gain).connect(dest);
    osc.start();
    window.__vv._fake = { ctx, gain };
    return dest.stream;
  },
  loud(v = 0.35) { if (window.__vv._fake) window.__vv._fake.gain.gain.value = v; },
  errors: [],
};

window.addEventListener('error', (e) => window.__vv.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__vv.errors.push(String(e.reason)));

boot();
