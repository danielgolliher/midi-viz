// Canvas 2D fallback for the abstract visualizer. Same public interface
// as the Three.js version. Used automatically when WebGL context creation
// fails — e.g. hardware acceleration disabled, privacy extension blocking
// WebGL, or a dual-GPU driver rejecting the requested power preference.
//
// Physics (turbulence, chord attractors, tempo/polyphony scaling) is the
// same idea as the WebGL version; rendering uses soft filled circles with
// `globalCompositeOperation = 'lighter'` for an additive-glow effect.

import { pitchClass, fifthsIndex } from './music.js';

const MAX_PARTICLES = 1500;
const MIN_NOTE = 21;
const MAX_NOTE = 108;

function hsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r, g, b;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

export class AbstractViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('Canvas 2D context unavailable');

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.particles = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i] = {
        x: 0, y: 0, vx: 0, vy: 0,
        r: 0, g: 0, b: 0,
        size: 1, age: 0, life: 0, lifespan: 1,
        seed: Math.random() * 1000,
      };
    }
    this.nextIdx = 0;

    this.held = new Map();
    this.noteTimestamps = [];
    this.tempoFactor = 0;
    this.polyFactor = 0;
    this.attractor = null;

    this.lastFrame = performance.now();
    this.elapsed = 0;

    console.log('[viz] Canvas 2D fallback active');
    this._welcome();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.aspect = w / h;
    this.ctx.fillStyle = '#06060c';
    this.ctx.fillRect(0, 0, w, h);
  }

  _welcome() {
    for (let i = 0; i < 80; i++) {
      const x = (Math.random() - 0.5) * 2 * this.aspect;
      this._emit(x, -0.95,
        (Math.random() - 0.5) * 0.3, 0.25 + Math.random() * 0.3,
        Math.random() * 360, 0.8, 3.5, 0.08);
    }
  }

  noteToX(note) {
    const t = (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
    return (Math.max(0, Math.min(1, t)) - 0.5) * 2 * this.aspect;
  }

  _take() {
    const idx = this.nextIdx;
    this.nextIdx = (this.nextIdx + 1) % MAX_PARTICLES;
    return idx;
  }

  _emit(x, y, vx, vy, hue, sat, lifespan, spread = 0.04) {
    const i = this._take();
    const p = this.particles[i];
    p.x = x + (Math.random() - 0.5) * spread;
    p.y = y + (Math.random() - 0.5) * spread;
    p.vx = vx + (Math.random() - 0.5) * 0.25;
    p.vy = vy + (Math.random() - 0.5) * 0.25;
    const [r, g, b] = hsv(hue, sat, 1);
    p.r = r; p.g = g; p.b = b;
    p.life = 1;
    p.age = 0;
    p.lifespan = lifespan * (0.8 + Math.random() * 0.5);
    p.seed = Math.random() * 1000;
  }

  noteOn(note, velocity) {
    const x = this.noteToX(note);
    const hue = (fifthsIndex(pitchClass(note)) / 12) * 360;
    const v = velocity / 127;
    const base = 18 + Math.floor(v * 28);
    const extra = Math.floor(base * (this.polyFactor * 0.8 + this.tempoFactor * 0.6));
    const count = base + extra;
    for (let i = 0; i < count; i++) {
      this._emit(x, -0.95,
        (Math.random() - 0.5) * (1 + this.tempoFactor * 1.5),
        0.9 + v * 1.8 + this.tempoFactor * 0.8,
        hue, 1, 2.2 + v * 1.3);
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this._emit(x, -0.95,
        Math.cos(a) * (1.4 + v * 2),
        Math.sin(a) * (1.0 + v * 1.2) + 0.3,
        hue, 0.7, 0.8);
    }
    this.held.set(note, { x, hue, born: performance.now() });
    this.noteTimestamps.push(performance.now());
    if (this.noteTimestamps.length > 128) this.noteTimestamps.shift();
  }

  noteOff(note) { this.held.delete(note); }

  onChord(chord) {
    if (!chord) return;
    const hue = (fifthsIndex(chord.root) / 12) * 360;
    const style = {
      major:      { sat: 1.00, ring: 90,  speed: 1.0, radius: 0.55, strength: 0.35, lifespan: 3.5 },
      minor:      { sat: 0.65, ring: 80,  speed: 0.6, radius: 0.50, strength: 0.55, lifespan: 3.8 },
      diminished: { sat: 0.55, ring: 100, speed: 1.6, radius: 0.60, strength: 0.85, lifespan: 2.8 },
      augmented:  { sat: 1.00, ring: 110, speed: 1.2, radius: 0.55, strength: 0.45, lifespan: 4.2 },
    }[chord.quality];
    for (let i = 0; i < style.ring; i++) {
      const a = (i / style.ring) * Math.PI * 2 + Math.random() * 0.08;
      const r = style.radius + (Math.random() - 0.5) * 0.06;
      this._emit(Math.cos(a) * r, Math.sin(a) * r,
        -Math.sin(a) * style.speed, Math.cos(a) * style.speed,
        hue, style.sat, style.lifespan, 0.01);
    }
    for (let i = 0; i < 32; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.4 + Math.random() * 0.8;
      this._emit(0, 0, Math.cos(a) * sp, Math.sin(a) * sp, hue, style.sat, 1.5, 0.02);
    }
    this.attractor = {
      x: 0, y: 0,
      strength: style.strength,
      life: 1, decay: 0.35,
      quality: chord.quality,
    };
  }

  onArpeggio(arp) {
    const pts = arp.notes.map((n, i) => {
      const t = i / Math.max(1, arp.notes.length - 1);
      return {
        x: this.noteToX(n),
        y: (arp.direction === 'up' ? -0.35 + t * 0.7 : 0.35 - t * 0.7) + (Math.random() - 0.5) * 0.1,
        hue: (fifthsIndex(pitchClass(n)) / 12) * 360,
      };
    });
    const steps = 30 * Math.max(1, pts.length - 1);
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      const seg = Math.min(Math.floor(u * (pts.length - 1)), pts.length - 2);
      const local = u * (pts.length - 1) - seg;
      const a = pts[seg], b = pts[seg + 1];
      const x = a.x + (b.x - a.x) * local;
      const y = a.y + (b.y - a.y) * local;
      const hue = a.hue + (b.hue - a.hue) * local;
      this._emit(x, y, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.4 + 0.1, hue, 1, 1.4, 0.02);
    }
  }

  _updateFactors() {
    const now = performance.now();
    this.noteTimestamps = this.noteTimestamps.filter(t => now - t < 2000);
    const rate = this.noteTimestamps.length / 2;
    const targetTempo = Math.min(1, rate / 6);
    this.tempoFactor += (targetTempo - this.tempoFactor) * 0.15;
    const targetPoly = Math.min(1, this.held.size / 6);
    this.polyFactor += (targetPoly - this.polyFactor) * 0.1;
  }

  _flow(x, y, t) {
    const a = Math.sin(x * 2.1 + y * 1.3 + t * 0.45) + Math.cos(x * 1.7 - y * 2.5 + t * 0.28);
    const b = Math.cos(x * 2.3 - y * 1.9 + t * 0.37) - Math.sin(x * 1.5 + y * 2.1 - t * 0.52);
    return [a * 0.5, b * 0.5];
  }

  // world coords ([-aspect..aspect] × [-1..1]) → screen pixels
  _toScreen(wx, wy) {
    const sx = (wx / this.aspect + 1) * 0.5 * this.w;
    const sy = (1 - (wy + 1) * 0.5) * this.h;
    return [sx, sy];
  }

  frame() {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    this.elapsed += dt;
    const t = this.elapsed;
    this._updateFactors();

    if (this.attractor) {
      this.attractor.life -= dt * this.attractor.decay;
      if (this.attractor.life <= 0) this.attractor = null;
    }

    const wind = 0.02 + this.tempoFactor * 0.25;
    const windX = Math.sin(t * 0.4) * wind;
    const turb = 0.15 + this.polyFactor * 0.55 + this.tempoFactor * 0.35;

    const ctx = this.ctx;
    // Fade trails
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(6, 6, 12, 0.18)';
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.globalCompositeOperation = 'lighter';

    const baseSize = 6 + this.polyFactor * 3 + this.tempoFactor * 3;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.age += dt;
      p.life = Math.max(0, 1 - p.age / p.lifespan);

      const [fx, fy] = this._flow(p.x * 1.6 + p.seed * 0.01, p.y * 1.6, t * 0.6);
      p.vx += fx * turb * dt;
      p.vy += fy * turb * dt;
      p.vx += windX * dt;
      p.vy += 0.18 * dt;

      if (this.attractor) {
        const dx = this.attractor.x - p.x;
        const dy = this.attractor.y - p.y;
        const d2 = dx * dx + dy * dy + 0.06;
        const str = this.attractor.strength * this.attractor.life;
        if (this.attractor.quality === 'augmented') {
          p.vx += (-dy) * str * dt * 2.2;
          p.vy += ( dx) * str * dt * 2.2;
        } else if (this.attractor.quality === 'diminished') {
          p.vx -= dx / d2 * str * dt * 0.45;
          p.vy -= dy / d2 * str * dt * 0.45;
        } else {
          p.vx += dx / d2 * str * dt * 0.6;
          p.vy += dy / d2 * str * dt * 0.6;
        }
      }
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const [sx, sy] = this._toScreen(p.x, p.y);
      if (sx < -60 || sx > this.w + 60 || sy < -60 || sy > this.h + 60) continue;

      const fade = Math.pow(p.life, 0.7);
      const size = baseSize * (0.6 + p.life * 0.8);

      // Core
      ctx.fillStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${fade * 0.85})`;
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, Math.PI * 2);
      ctx.fill();

      // Soft halo (second pass, larger and dimmer) for glow
      ctx.fillStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${fade * 0.18})`;
      ctx.beginPath();
      ctx.arc(sx, sy, size * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  clear() {
    for (const p of this.particles) p.life = 0;
    this.attractor = null;
    this.noteTimestamps.length = 0;
    this.held.clear();
    this.tempoFactor = 0;
    this.polyFactor = 0;
    this.ctx.fillStyle = '#06060c';
    this.ctx.fillRect(0, 0, this.w, this.h);
  }
}
