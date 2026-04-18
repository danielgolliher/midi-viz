// GPU particle field on Three.js + UnrealBloomPass.
//
// Uses the built-in PointsMaterial with a radial-gradient point sprite so
// shader compilation can't silently fail on any given GPU/driver combo.
// Per-particle color carries both hue AND life: we multiply the color by
// `life` each frame, so a dying particle fades to black and (under additive
// blending) disappears.
//
// Same public surface as before: noteOn / noteOff / onChord / onArpeggio /
// frame / clear. Polyphony (keys held) and tempo (notes/sec) continuously
// modulate turbulence, emission density, attractor strength, and bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { pitchClass, fifthsIndex } from './music.js';

const MAX_PARTICLES = 5000;
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
  return [r + m, g + m, b + m];
}

function makeDiskTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export class AbstractViz {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x06060c, 1);

    console.log('[viz] WebGL:', this.renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1',
                '| pixel ratio:', this.renderer.getPixelRatio());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06060c);

    this.aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.OrthographicCamera(-this.aspect, this.aspect, 1, -1, -10, 10);
    this.camera.position.z = 1;

    // Particle buffers
    const positions = new Float32Array(MAX_PARTICLES * 3);
    const colors    = new Float32Array(MAX_PARTICLES * 3);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

    this.mat = new THREE.PointsMaterial({
      size: 22,
      sizeAttenuation: false,   // size in pixels
      vertexColors: true,
      map: makeDiskTexture(),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geom, this.mat);
    this.scene.add(this.points);

    // CPU simulation state (parallels the GPU buffers)
    this.particles = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i] = {
        x: 0, y: 0, vx: 0, vy: 0,
        r: 0, g: 0, b: 0,
        size: 1, age: 0, life: 0, lifespan: 1,
        seed: Math.random() * 1000,
      };
      positions[i * 3]     = 99999;
      positions[i * 3 + 1] = 99999;
    }
    this.nextIdx = 0;

    // Postprocessing — bloom and proper sRGB output
    let composerOk = false;
    try {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.75, 0.85, 0.0
      );
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      composerOk = true;
    } catch (e) {
      console.warn('[viz] postprocessing unavailable, falling back to direct render:', e);
      this.composer = null;
    }
    this.useComposer = composerOk;

    this.clock = new THREE.Clock();

    // Input-driven state
    this.held = new Map();
    this.noteTimestamps = [];
    this.tempoFactor = 0;
    this.polyFactor = 0;
    this.attractor = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // A quiet welcome emission so the viz is clearly alive before the
    // user plays anything.
    this._welcome();
  }

  _welcome() {
    for (let i = 0; i < 120; i++) {
      const x = (Math.random() - 0.5) * 2 * this.aspect;
      const hue = Math.random() * 360;
      this._emit(x, -0.95, (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.3,
                 hue, 0.8, 1, 3.5, 0.08);
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    this.camera.left = -this.aspect;
    this.camera.right = this.aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
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

  // The `size` argument is unused visually now (uniform point size), but
  // the signature is kept for clarity and future use.
  _emit(x, y, vx, vy, hue, sat, _size, lifespan, spread = 0.04) {
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
    const pc = pitchClass(note);
    const hue = (fifthsIndex(pc) / 12) * 360;
    const v = velocity / 127;

    const base = 28 + Math.floor(v * 44);
    const extra = Math.floor(base * (this.polyFactor * 0.9 + this.tempoFactor * 0.7));
    const count = base + extra;
    for (let i = 0; i < count; i++) {
      this._emit(
        x, -0.95,
        (Math.random() - 0.5) * (1 + this.tempoFactor * 1.5),
        0.9 + v * 1.8 + this.tempoFactor * 0.8,
        hue, 1, 1,
        2.4 + v * 1.5
      );
    }
    // Radial spark at the column base
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      this._emit(
        x, -0.95,
        Math.cos(a) * (1.4 + v * 2.2),
        Math.sin(a) * (1.0 + v * 1.4) + 0.3,
        hue, 0.7, 1, 0.9
      );
    }

    this.held.set(note, { x, hue, born: performance.now() });
    this.noteTimestamps.push(performance.now());
    if (this.noteTimestamps.length > 128) this.noteTimestamps.shift();
  }

  noteOff(note) {
    this.held.delete(note);
  }

  onChord(chord) {
    if (!chord) return;
    const hue = (fifthsIndex(chord.root) / 12) * 360;
    const style = {
      major:      { sat: 1.00, ring: 140, speed: 1.0, radius: 0.55, strength: 0.35, lifespan: 3.5 },
      minor:      { sat: 0.65, ring: 120, speed: 0.6, radius: 0.50, strength: 0.55, lifespan: 3.8 },
      diminished: { sat: 0.55, ring: 160, speed: 1.6, radius: 0.60, strength: 0.85, lifespan: 2.8 },
      augmented:  { sat: 1.00, ring: 180, speed: 1.2, radius: 0.55, strength: 0.45, lifespan: 4.2 },
    }[chord.quality];

    for (let i = 0; i < style.ring; i++) {
      const a = (i / style.ring) * Math.PI * 2 + Math.random() * 0.08;
      const r = style.radius + (Math.random() - 0.5) * 0.06;
      const tx = -Math.sin(a) * style.speed;
      const ty =  Math.cos(a) * style.speed;
      this._emit(Math.cos(a) * r, Math.sin(a) * r, tx, ty, hue, style.sat, 1, style.lifespan, 0.01);
    }

    for (let i = 0; i < 48; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.4 + Math.random() * 0.8;
      this._emit(0, 0, Math.cos(a) * sp, Math.sin(a) * sp, hue, style.sat, 1, 1.5, 0.02);
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

    const density = 42;
    const steps = density * Math.max(1, pts.length - 1);
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      const seg = Math.min(Math.floor(u * (pts.length - 1)), pts.length - 2);
      const local = u * (pts.length - 1) - seg;
      const a = pts[seg], b = pts[seg + 1];
      const x = a.x + (b.x - a.x) * local;
      const y = a.y + (b.y - a.y) * local;
      const hue = a.hue + (b.hue - a.hue) * local;
      this._emit(x, y, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.4 + 0.1,
                 hue, 1, 1, 1.4, 0.02);
    }
  }

  _updateFactors() {
    const now = performance.now();
    const recent = this.noteTimestamps.filter(t => now - t < 2000);
    this.noteTimestamps = recent;
    const notesPerSec = recent.length / 2;
    const targetTempo = Math.min(1, notesPerSec / 6);
    this.tempoFactor += (targetTempo - this.tempoFactor) * 0.15;
    const targetPoly = Math.min(1, this.held.size / 6);
    this.polyFactor += (targetPoly - this.polyFactor) * 0.1;
  }

  _flow(x, y, t) {
    const a = Math.sin(x * 2.1 + y * 1.3 + t * 0.45) + Math.cos(x * 1.7 - y * 2.5 + t * 0.28);
    const b = Math.cos(x * 2.3 - y * 1.9 + t * 0.37) - Math.sin(x * 1.5 + y * 2.1 - t * 0.52);
    return [a * 0.5, b * 0.5];
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this._updateFactors();

    if (this.attractor) {
      this.attractor.life -= dt * this.attractor.decay;
      if (this.attractor.life <= 0) this.attractor = null;
    }

    const wind = 0.02 + this.tempoFactor * 0.25;
    const windX = Math.sin(t * 0.4) * wind;
    const turb = 0.15 + this.polyFactor * 0.55 + this.tempoFactor * 0.35;

    const pos = this.geom.attributes.position.array;
    const col = this.geom.attributes.color.array;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p.life <= 0) {
        pos[i * 3]     = 99999;
        pos[i * 3 + 1] = 99999;
        col[i * 3]     = 0;
        col[i * 3 + 1] = 0;
        col[i * 3 + 2] = 0;
        continue;
      }
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

      pos[i * 3]     = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = 0;

      // Fade by multiplying color by life (additive blending makes
      // color=0 effectively invisible, so we don't need a separate alpha).
      const fade = Math.pow(p.life, 0.7);
      col[i * 3]     = p.r * fade;
      col[i * 3 + 1] = p.g * fade;
      col[i * 3 + 2] = p.b * fade;
    }

    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.color.needsUpdate = true;

    if (this.bloom) {
      this.bloom.strength = 0.55 + this.tempoFactor * 0.9 + this.polyFactor * 0.6;
    }

    if (this.useComposer && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  clear() {
    for (const p of this.particles) p.life = 0;
    this.attractor = null;
    this.noteTimestamps.length = 0;
    this.held.clear();
    this.tempoFactor = 0;
    this.polyFactor = 0;
  }
}
