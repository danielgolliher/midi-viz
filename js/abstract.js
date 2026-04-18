import { pitchClass, fifthsIndex } from './music.js';

const MIN_NOTE = 21;  // A0
const MAX_NOTE = 108; // C8

function hueFor(pc) {
  return (fifthsIndex(pc) / 12) * 360;
}

export class AbstractViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.particles = [];
    this.blooms = [];
    this.trails = [];
    this.held = new Map(); // note -> {x, hue, born}
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Paint the background fully once so fade trails don't blend with white.
    this.ctx.fillStyle = '#06060c';
    this.ctx.fillRect(0, 0, w, h);
  }

  noteToX(note) {
    const t = (note - MIN_NOTE) / (MAX_NOTE - MIN_NOTE);
    return Math.max(0, Math.min(1, t)) * window.innerWidth;
  }

  noteOn(note, velocity) {
    const x = this.noteToX(note);
    const pc = pitchClass(note);
    const hue = hueFor(pc);
    const v = velocity / 127;
    const count = 10 + Math.floor(v * 28);

    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 40;
      this.particles.push({
        x: x + spread,
        y: window.innerHeight - 10 - Math.random() * 6,
        vx: (Math.random() - 0.5) * 1.8,
        vy: -1 - Math.random() * 2 - v * 2.5,
        ay: 0.012 + Math.random() * 0.004,
        drag: 0.992,
        life: 1.0,
        decay: 0.004 + Math.random() * 0.006,
        size: 1.6 + v * 4 + Math.random() * 1.5,
        hue,
        sat: 80 + Math.random() * 15,
        light: 55 + v * 15,
      });
    }

    // Small radial burst at the note's column
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.particles.push({
        x, y: window.innerHeight - 10,
        vx: Math.cos(a) * (1 + v * 3),
        vy: Math.sin(a) * (1 + v * 3) - 1,
        ay: 0.01,
        drag: 0.98,
        life: 1.0,
        decay: 0.02,
        size: 2 + v * 2,
        hue, sat: 90, light: 70,
      });
    }

    this.held.set(note, { x, hue, born: performance.now() });
  }

  noteOff(note) {
    this.held.delete(note);
  }

  onChord(chord) {
    if (!chord) return;
    const hue = hueFor(chord.root);
    const qualityStyle = {
      major:      { s: 82, l: 62, sides: 3,  wobble: 0.00, strokes: 3 },
      minor:      { s: 48, l: 42, sides: 3,  wobble: 0.00, strokes: 3 },
      diminished: { s: 38, l: 32, sides: 3,  wobble: 0.08, strokes: 2 },
      augmented:  { s: 92, l: 70, sides: 6,  wobble: 0.05, strokes: 4 },
    }[chord.quality];

    const cx = window.innerWidth / 2 + (Math.random() - 0.5) * 140;
    const cy = window.innerHeight / 2 + (Math.random() - 0.5) * 140;

    for (let k = 0; k < qualityStyle.strokes; k++) {
      this.blooms.push({
        x: cx, y: cy,
        r: 10 + k * 6,
        maxR: 160 + Math.random() * 180 + k * 30,
        hue, s: qualityStyle.s, l: qualityStyle.l,
        sides: qualityStyle.sides,
        wobble: qualityStyle.wobble,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.01,
        life: 1.0,
        decay: 0.005 + k * 0.001,
      });
    }
  }

  onArpeggio(arp) {
    const pts = arp.notes.map((n, i) => {
      const t = i / (arp.notes.length - 1);
      return {
        x: this.noteToX(n),
        y: window.innerHeight * (0.35 + (arp.direction === 'up' ? -t * 0.1 : t * 0.1))
           + (Math.random() - 0.5) * 80,
        hue: hueFor(pitchClass(n)),
      };
    });
    this.trails.push({
      pts,
      life: 1.0,
      decay: 0.006,
      width: 2.5,
    });
  }

  frame() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.ctx;

    // Fade trails
    ctx.fillStyle = 'rgba(6, 6, 12, 0.09)';
    ctx.fillRect(0, 0, w, h);

    // Ambient glow under held notes
    const now = performance.now();
    for (const { x, hue, born } of this.held.values()) {
      const age = (now - born) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(age * 3);
      const grad = ctx.createRadialGradient(x, h - 6, 0, x, h - 6, 130);
      grad.addColorStop(0, `hsla(${hue}, 85%, 60%, ${0.18 + pulse * 0.1})`);
      grad.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - 130, h - 140, 260, 140);
    }

    // Particles
    const keep = [];
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.ay;
      p.life -= p.decay;
      if (p.life <= 0 || p.y < -20 || p.x < -20 || p.x > w + 20) continue;
      const alpha = Math.max(0, p.life);
      ctx.fillStyle = `hsla(${p.hue}, ${p.sat}%, ${p.light}%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
      keep.push(p);
    }
    this.particles = keep;

    // Blooms (chord shapes)
    const keepBlooms = [];
    for (const b of this.blooms) {
      b.r += (b.maxR - b.r) * 0.045;
      b.rotation += b.rotSpeed;
      b.life -= b.decay;
      if (b.life <= 0) continue;

      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rotation);
      ctx.globalAlpha = b.life * 0.55;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `hsl(${b.hue}, ${b.s}%, ${b.l}%)`;
      ctx.beginPath();
      for (let i = 0; i <= b.sides; i++) {
        const a = (i / b.sides) * Math.PI * 2 - Math.PI / 2;
        const wob = 1 + Math.sin(a * 3 + b.rotation * 4) * b.wobble;
        const px = Math.cos(a) * b.r * wob;
        const py = Math.sin(a) * b.r * wob;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Inner filled core
      ctx.globalAlpha = b.life * 0.08;
      ctx.fillStyle = `hsl(${b.hue}, ${b.s}%, ${Math.min(b.l + 10, 90)}%)`;
      ctx.fill();
      ctx.restore();
      keepBlooms.push(b);
    }
    this.blooms = keepBlooms;

    // Arpeggio trails
    const keepTrails = [];
    for (const t of this.trails) {
      t.life -= t.decay;
      if (t.life <= 0) continue;
      ctx.save();
      ctx.globalAlpha = t.life * 0.9;
      ctx.lineWidth = t.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Draw a smooth curve through points
      if (t.pts.length >= 2) {
        const grad = ctx.createLinearGradient(t.pts[0].x, t.pts[0].y,
          t.pts[t.pts.length - 1].x, t.pts[t.pts.length - 1].y);
        grad.addColorStop(0, `hsla(${t.pts[0].hue}, 80%, 70%, ${t.life})`);
        grad.addColorStop(1, `hsla(${t.pts[t.pts.length - 1].hue}, 80%, 70%, ${t.life})`);
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(t.pts[0].x, t.pts[0].y);
        for (let i = 1; i < t.pts.length - 1; i++) {
          const cx = (t.pts[i].x + t.pts[i + 1].x) / 2;
          const cy = (t.pts[i].y + t.pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(t.pts[i].x, t.pts[i].y, cx, cy);
        }
        const last = t.pts[t.pts.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
      ctx.restore();
      keepTrails.push(t);
    }
    this.trails = keepTrails;
  }

  clear() {
    const w = window.innerWidth, h = window.innerHeight;
    this.ctx.fillStyle = '#06060c';
    this.ctx.fillRect(0, 0, w, h);
    this.particles.length = 0;
    this.blooms.length = 0;
    this.trails.length = 0;
  }
}
