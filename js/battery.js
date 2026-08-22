// Battery watch for the phone that is doing the listening.
//
// The baby phone has to keep its screen on, so when it is NOT on a charger —
// in a pram, in the hall, out in the garden — the battery is the thing that
// decides how long the monitor lives. A monitor that dies quietly is the
// failure we care most about, so we measure the real drain on the real phone
// and say out loud how long there is left.

export class Battery extends EventTarget {
  constructor() {
    super();
    this.mgr = null;
    this.level = null;        // 0..1
    this.charging = null;
    this.samples = [];        // [{ t, level }] for the drain estimate
    this.perHour = null;      // measured drain, % per hour
    this.timer = null;
  }

  get supported() { return typeof navigator !== 'undefined' && 'getBattery' in navigator; }

  async start() {
    if (!this.supported) return false;
    try { this.mgr = await navigator.getBattery(); }
    catch (e) { return false; }

    const read = () => {
      const wasCharging = this.charging;
      this.level = this.mgr.level;
      this.charging = this.mgr.charging;
      // a charge event invalidates the drain history
      if (wasCharging !== null && wasCharging !== this.charging) this.samples = [];
      this.sample();
      this.emit();
    };
    this.mgr.addEventListener('levelchange', read);
    this.mgr.addEventListener('chargingchange', read);
    read();

    // Sample on a slow clock too: levelchange can be coarse (1% steps), and we
    // want a usable estimate within the first few minutes.
    clearInterval(this.timer);
    this.timer = setInterval(() => { this.sample(); this.emit(); }, 60000);
    return true;
  }

  sample() {
    if (this.level == null) return;
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (!last || last.level !== this.level) this.samples.push({ t: now, level: this.level });
    // keep an hour of history — enough to be steady, short enough to react
    const cutoff = now - 60 * 60 * 1000;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();

    const first = this.samples[0];
    const latest = this.samples[this.samples.length - 1];
    const hours = (latest.t - first.t) / 3600000;
    const drop = (first.level - latest.level) * 100;
    // need a real span and a real drop before claiming a rate
    this.perHour = hours >= 0.05 && drop > 0 ? drop / hours : null;
  }

  // Hours of listening left at the measured rate, or null while unknown.
  get hoursLeft() {
    if (this.charging || this.level == null || !this.perHour) return null;
    return (this.level * 100) / this.perHour;
  }

  get pct() { return this.level == null ? null : Math.round(this.level * 100); }

  snapshot() {
    return {
      pct: this.pct,
      charging: !!this.charging,
      perHour: this.perHour != null ? Math.round(this.perHour * 10) / 10 : null,
      hoursLeft: this.hoursLeft != null ? Math.round(this.hoursLeft * 10) / 10 : null,
    };
  }

  emit() { this.dispatchEvent(new CustomEvent('change', { detail: this.snapshot() })); }

  stop() { clearInterval(this.timer); this.timer = null; }
}

// Plain-language battery line, e.g. "63 % · ikke i opladning · ca. 6 t tilbage".
export function batteryText(b) {
  if (!b || b.pct == null) return '';
  const parts = [`${b.pct} %`];
  if (b.charging) parts.push('oplader');
  else {
    if (b.perHour) parts.push(`−${String(b.perHour).replace('.', ',')} %/time`);
    if (b.hoursLeft != null) {
      const h = b.hoursLeft;
      parts.push(h < 1 ? `ca. ${Math.round(h * 60)} min tilbage` : `ca. ${String(Math.round(h * 10) / 10).replace('.', ',')} t tilbage`);
    }
  }
  return parts.join(' · ');
}

// Warning thresholds for the phone that is listening. The last one is the
// point where you should genuinely go and do something about it.
export function batteryWarning(b) {
  if (!b || b.pct == null || b.charging) return null;
  if (b.pct <= 10) return { level: 'critical', text: `Barnets telefon har kun ${b.pct} % tilbage — den slukker snart` };
  if (b.pct <= 20) return { level: 'low', text: `Barnets telefon er nede på ${b.pct} %` };
  if (b.hoursLeft != null && b.hoursLeft < 0.5) return { level: 'critical', text: 'Barnets telefon holder under en halv time endnu' };
  return null;
}
