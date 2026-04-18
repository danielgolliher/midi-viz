// Polyphonic Web Audio synth. Triangle + octave-up sine for a warm,
// bell-piano tone. Context starts suspended on iOS/iPadOS until a user
// gesture calls ensure() — don't call noteOn before that.
export class Synth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.active = new Map(); // note -> {osc1, osc2, env}
  }

  async ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio not supported');
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.42;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setMuted(m) {
    this.muted = m;
    if (m) {
      for (const note of [...this.active.keys()]) this.noteOff(note);
    }
  }

  noteOn(note, velocity) {
    if (this.muted || !this.ctx) return;
    if (this.active.has(note)) this.noteOff(note);

    const freq = 440 * Math.pow(2, (note - 69) / 12);
    const now = this.ctx.currentTime;
    const v = Math.max(0.08, velocity / 127);
    const peak = v * 0.55;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.008);
    env.gain.exponentialRampToValueAtTime(peak * 0.45, now + 0.35);
    env.gain.exponentialRampToValueAtTime(peak * 0.12, now + 2.0);

    const osc1 = this.ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.value = freq;

    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2;
    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.18;

    osc1.connect(env);
    osc2.connect(osc2Gain);
    osc2Gain.connect(env);
    env.connect(this.master);

    osc1.start(now);
    osc2.start(now);

    this.active.set(note, { osc1, osc2, env });
  }

  noteOff(note) {
    if (!this.ctx) return;
    const voice = this.active.get(note);
    if (!voice) return;
    const now = this.ctx.currentTime;
    const g = voice.env.gain;
    const current = Math.max(g.value, 0.0001);
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.exponentialRampToValueAtTime(0.0001, now + 0.18);
    try { voice.osc1.stop(now + 0.22); voice.osc2.stop(now + 0.22); } catch {}
    this.active.delete(note);
  }
}
