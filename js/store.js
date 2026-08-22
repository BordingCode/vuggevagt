// Everything that must survive a reload. Deliberately tiny: the pairing is the
// only thing that is painful to lose.
//
// `?ns=` namespaces the key so two tabs on one machine can act as two phones
// during testing. Never used on a real device.

const ns = new URLSearchParams(location.search).get('ns');
const KEY = 'vuggevagt_v1' + (ns ? '_' + ns : '');

const DEFAULTS = {
  role: null,          // 'baby' | 'parent'
  code: null,          // shared pairing code, uppercase
  peerId: null,        // this device's identity inside the pair
  sens: 42,            // 0-100 sensitivity slider (higher = reacts to quieter sounds)
  holdMs: 1500,        // noise must persist this long before it counts
  volume: 0.85,
  vox: false,          // quiet until the baby makes a noise
  notify: false,       // permission granted for notifications
};

export const S = { ...DEFAULTS };

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(S, DEFAULTS, JSON.parse(raw));
  } catch (e) { /* corrupt or blocked storage — defaults are fine */ }
  if (!S.peerId) { S.peerId = newId(24); save(); }
  return S;
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* private mode */ }
}

export function set(patch) { Object.assign(S, patch); save(); return S; }

export function forgetPairing() {
  set({ role: null, code: null });
}

// Unambiguous alphabet: no O/0, no I/1, nothing you can mistype at 3am.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newId(len = 24) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return [...b].map((n) => ALPHABET[n % ALPHABET.length]).join('');
}

// 8 characters = 32^8 ≈ a thousand billion combinations. Shown as XXXX-XXXX.
export function newCode() {
  return newId(8);
}

export const pretty = (code) => (code ? code.slice(0, 4) + '-' + code.slice(4) : '');
export const normalise = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
