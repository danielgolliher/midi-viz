// Polyphonic Web Audio synth with switchable voices. Context starts
// suspended on iOS/iPadOS until a user gesture calls ensure().

// Each voice is an oscillator stack + ADSR envelope + optional filter.
// `sustain` is the level (relative to peak) the envelope holds at after
// the initial attack/decay; hold is how long it dwells there before
// gently decaying further when a note is held indefinitely.
const VOICES = {
  bell: {
    name: 'Bell',
    master: 0.42,
    oscillators: [
      { type: 'triangle', freq: 1, gain: 1.0, detune: 0 },
      { type: 'sine',     freq: 2, gain: 0.18, detune: 0 },
    ],
    envelope: { attack: 0.008, decay: 0.35, sustain: 0.35, hold: 2.2, release: 0.18 },
    filter: null,
  },
  pad: {
    name: 'Pad',
    master: 0.32,
    oscillators: [
      { type: 'sawtooth', freq: 1,   gain: 0.45, detune: -8 },
      { type: 'sawtooth', freq: 1,   gain: 0.45, detune:  8 },
      { type: 'sine',     freq: 0.5, gain: 0.25, detune:  0 },
    ],
    envelope: { attack: 0.35, decay: 0.6, sustain: 0.7, hold: 8, release: 1.2 },
    filter: { type: 'lowpass', freq: 1400, Q: 1.2 },
  },
  organ: {
    name: 'Organ',
    master: 0.35,
    oscillators: [
      { type: 'sine', freq: 1, gain: 0.55, detune: 0 },
      { type: 'sine', freq: 2, gain: 0.28, detune: 0 },
      { type: 'sine', freq: 3, gain: 0.16, detune: 0 },
      { type: 'sine', freq: 4, gain: 0.08, detune: 0 },
    ],
    envelope: { attack: 0.012, decay: 0.06, sustain: 0.9, hold: 20, release: 0.12 },
    filter: null,
  },
  pluck: {
    name: 'Pluck',
    master: 0.48,
    oscillators: [
      { type: 'square', freq: 1, gain: 0.55, detune: 0 },
      { type: 'sine',   freq: 2, gain: 0.22, detune: 0 },
    ],
    envelope: { attack: 0.003, decay: 0.12, sustain: 0.04, hold: 0.6, release: 0.1 },
    filter: { type: 'lowpass', freq: 2200, Q: 3, envAmount: 4200, envDecay: 0.18 },
  },
};

export class Synth {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.active = new Map(); // note -> { oscs, env, filter }
    this.voiceName = 'bell';
  }

  async ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio not supported');
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 1.0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (m) for (const note of [...this.active.keys()]) this.noteOff(note);
  }

  setVoice(name) {
    if (!VOICES[name]) return;
    this.voiceName = name;
    // Release in-flight notes so you hear the new voice on the next key.
    for (const note of [...this.active.keys()]) this.noteOff(note);
  }

  voices() {
    return Object.entries(VOICES).map(([key, v]) => ({ key, name: v.name }));
  }

  currentVoice() { return this.voiceName; }

  noteOn(note, velocity) {
    if (this.muted || !this.ctx) return;
    if (this.active.has(note)) this.noteOff(note);

    const v = VOICES[this.voiceName];
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    const now = this.ctx.currentTime;
    const vel = Math.max(0.08, velocity / 127);
    const peak = vel * v.master;
    const e = v.envelope;

    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + e.attack);
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * e.sustain),
      now + e.attack + e.decay
    );
    // Slow drift while held
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.00005, peak * e.sustain * 0.35),
      now + e.attack + e.decay + e.hold
    );

    let tail = env;
    let filter = null;
    if (v.filter) {
      filter = this.ctx.createBiquadFilter();
      filter.type = v.filter.type;
      filter.Q.value = v.filter.Q;
      if (v.filter.envAmount) {
        filter.frequency.setValueAtTime(v.filter.freq + v.filter.envAmount, now);
        filter.frequency.exponentialRampToValueAtTime(
          v.filter.freq, now + v.filter.envDecay
        );
      } else {
        filter.frequency.setValueAtTime(v.filter.freq, now);
      }
      env.connect(filter);
      tail = filter;
    }
    tail.connect(this.master);

    const oscs = [];
    for (const od of v.oscillators) {
      const osc = this.ctx.createOscillator();
      osc.type = od.type;
      osc.frequency.value = freq * od.freq;
      if (od.detune) osc.detune.value = od.detune;
      const og = this.ctx.createGain();
      og.gain.value = od.gain;
      osc.connect(og);
      og.connect(env);
      osc.start(now);
      oscs.push(osc);
    }

    this.active.set(note, { oscs, env, filter });
  }

  noteOff(note) {
    if (!this.ctx) return;
    const voice = this.active.get(note);
    if (!voice) return;
    const now = this.ctx.currentTime;
    const release = VOICES[this.voiceName].envelope.release;
    const g = voice.env.gain;
    const current = Math.max(g.value, 0.0001);
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.exponentialRampToValueAtTime(0.0001, now + release);
    for (const osc of voice.oscs) {
      try { osc.stop(now + release + 0.04); } catch {}
    }
    this.active.delete(note);
  }
}
