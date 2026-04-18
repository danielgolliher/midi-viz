// GPU particle field built on Three.js + UnrealBloomPass.
// Same public interface as before: noteOn / noteOff / onChord / onArpeggio /
// frame / clear. Polyphony (how many keys are held) and tempo (how many
// notes/sec are arriving) continuously modulate turbulence, emission
// density, attractor strength, and bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { pitchClass, fifthsIndex } from './music.js';

const MAX_PARTICLES = 5000;
const MIN_NOTE = 21;  // A0
const MAX_NOTE = 108; // C8

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

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uPixelRatio;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float glow = pow(core, 1.6);
    vec3 col = vColor * (glow * 1.8 + 0.2 * core);
    gl_FragColor = vec4(col * vAlpha, vAlpha * core);
  }
`;

export class AbstractViz {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06060c);

    this.aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.OrthographicCamera(-this.aspect, this.aspect, 1, -1, 0.1, 10);
    this.camera.position.z = 1;

    // Particle buffers
    const positions = new Float32Array(MAX_PARTICLES * 3);
    const colors    = new Float32Array(MAX_PARTICLES * 3);
    const sizes     = new Float32Array(MAX_PARTICLES);
    const alphas    = new Float32Array(MAX_PARTICLES);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geom.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
    this.geom.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
    this.geom.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    this.points = new THREE.Points(this.geom, this.mat);
    this.scene.add(this.points);

    // CPU-side simulation state (same indexing as the GPU buffers).
    this.particles = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i] = {
        x: 0, y: 0, vx: 0, vy: 0,
        r: 0, g: 0, b: 0,
        size: 0, age: 0, life: 0, lifespan: 1,
        seed: Math.random() * 1000,
      };
      positions[i * 3] = 99999; // park offscreen
    }
    this.nextIdx = 0; // rolling index for O(1) spawn

    // Postprocessing: bloom for that glowing-night-sky look
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.75,  // strength (animated)
      0.85,  // radius
      0.0    // threshold — bloom everything
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();

    // Input-driven state
    this.held = new Map();
    this.noteTimestamps = [];
    this.tempoFactor = 0;   // 0..1, notes-per-second / 6
    this.polyFactor = 0;    // 0..1, keys held / 6
    this.attractor = null;  // {x, y, strength, life, quality}

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
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
    if (this.mat) this.mat.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
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

  _emit(x, y, vx, vy, hue, sat, size, lifespan, spread = 0.04) {
    const i = this._take();
    const p = this.particles[i];
    p.x = x + (Math.random() - 0.5) * spread;
    p.y = y + (Math.random() - 0.5) * spread;
    p.vx = vx + (Math.random() - 0.5) * 0.25;
    p.vy = vy + (Math.random() - 0.5) * 0.25;
    const [r, g, b] = hsv(hue, sat, 1);
    p.r = r; p.g = g; p.b = b;
    p.size = size * (0.6 + Math.random() * 0.8);
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
    // Polyphony and tempo both add to the burst density.
    const base = 22 + Math.floor(v * 40);
    const extra = Math.floor(base * (this.polyFactor * 0.9 + this.tempoFactor * 0.7));
    const count = base + extra;
    for (let i = 0; i < count; i++) {
      this._emit(
        x, -0.95,
        (Math.random() - 0.5) * (1 + this.tempoFactor * 1.5),
        0.8 + v * 1.6 + this.tempoFactor * 0.8,
        hue, 1,
        14 + v * 22,
        2.2 + v * 1.5
      );
    }
    // Radial kiss at the column base
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this._emit(
        x, -0.95,
        Math.cos(a) * (1.2 + v * 2),
        Math.sin(a) * (0.8 + v * 1.2) + 0.2,
        hue, 0.7, 12 + v * 10, 0.8
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
    const qualityStyle = {
      major:      { sat: 1.00, ring: 140, speed: 1.0, radius: 0.55, strength: 0.35, lifespan: 3.5 },
      minor:      { sat: 0.65, ring: 120, speed: 0.6, radius: 0.50, strength: 0.55, lifespan: 3.8 },
      diminished: { sat: 0.55, ring: 160, speed: 1.6, radius: 0.60, strength: 0.85, lifespan: 2.8 },
      augmented:  { sat: 1.00, ring: 180, speed: 1.2, radius: 0.55, strength: 0.45, lifespan: 4.2 },
    }[chord.quality];

    // Launch a tangent ring from the center
    for (let i = 0; i < qualityStyle.ring; i++) {
      const a = (i / qualityStyle.ring) * Math.PI * 2 + Math.random() * 0.08;
      const r = qualityStyle.radius + (Math.random() - 0.5) * 0.06;
      const tx = -Math.sin(a) * qualityStyle.speed;
      const ty =  Math.cos(a) * qualityStyle.speed;
      this._emit(
        Math.cos(a) * r, Math.sin(a) * r,
        tx, ty, hue, qualityStyle.sat, 16, qualityStyle.lifespan, 0.01
      );
    }

    // Central burst
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.4 + Math.random() * 0.8;
      this._emit(0, 0, Math.cos(a) * sp, Math.sin(a) * sp, hue, qualityStyle.sat, 14, 1.5, 0.02);
    }

    this.attractor = {
      x: 0, y: 0,
      strength: qualityStyle.strength,
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

    const density = 36;
    const steps = density * Math.max(1, pts.length - 1);
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      const seg = Math.min(Math.floor(u * (pts.length - 1)), pts.length - 2);
      const local = u * (pts.length - 1) - seg;
      const a = pts[seg], b = pts[seg + 1];
      const x = a.x + (b.x - a.x) * local;
      const y = a.y + (b.y - a.y) * local;
      const hue = a.hue + (b.hue - a.hue) * local;
      this._emit(
        x, y,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.4 + 0.1,
        hue, 1, 12, 1.4, 0.02
      );
    }
  }

  _updateFactors() {
    const now = performance.now();
    const recent = this.noteTimestamps.filter(t => now - t < 2000);
    this.noteTimestamps = recent;
    const notesPerSec = recent.length / 2;
    // Smooth: ease toward target
    const targetTempo = Math.min(1, notesPerSec / 6);
    this.tempoFactor += (targetTempo - this.tempoFactor) * 0.15;

    const targetPoly = Math.min(1, this.held.size / 6);
    this.polyFactor += (targetPoly - this.polyFactor) * 0.1;
  }

  // Cheap pseudo-curl noise
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

    // Tempo drives wind; polyphony + tempo both drive turbulence.
    const wind = 0.02 + this.tempoFactor * 0.25;
    const windX = Math.sin(t * 0.4) * wind;
    const turb = 0.15 + this.polyFactor * 0.55 + this.tempoFactor * 0.35;

    const pos = this.geom.attributes.position.array;
    const col = this.geom.attributes.aColor.array;
    const sz  = this.geom.attributes.aSize.array;
    const al  = this.geom.attributes.aAlpha.array;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p.life <= 0) {
        al[i] = 0;
        pos[i * 3] = 99999;
        continue;
      }
      p.age += dt;
      p.life = Math.max(0, 1 - p.age / p.lifespan);

      const [fx, fy] = this._flow(p.x * 1.6 + p.seed * 0.01, p.y * 1.6, t * 0.6);
      p.vx += fx * turb * dt;
      p.vy += fy * turb * dt;
      p.vx += windX * dt;
      p.vy += 0.18 * dt; // gentle upward buoyancy

      if (this.attractor) {
        const dx = this.attractor.x - p.x;
        const dy = this.attractor.y - p.y;
        const d2 = dx * dx + dy * dy + 0.06;
        const str = this.attractor.strength * this.attractor.life;
        if (this.attractor.quality === 'augmented') {
          // Orbital — tangential push
          p.vx += (-dy) * str * dt * 2.2;
          p.vy += ( dx) * str * dt * 2.2;
        } else if (this.attractor.quality === 'diminished') {
          // Repel outward
          p.vx -= dx / d2 * str * dt * 0.45;
          p.vy -= dy / d2 * str * dt * 0.45;
        } else {
          // major/minor: gentle pull inward
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
      col[i * 3]     = p.r;
      col[i * 3 + 1] = p.g;
      col[i * 3 + 2] = p.b;
      sz[i] = p.size * Math.pow(p.life, 0.55);
      al[i] = p.life;
    }

    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.aColor.needsUpdate = true;
    this.geom.attributes.aSize.needsUpdate = true;
    this.geom.attributes.aAlpha.needsUpdate = true;

    // Bloom intensity responds to how much is going on.
    this.bloom.strength = 0.55 + this.tempoFactor * 0.9 + this.polyFactor * 0.6;

    this.composer.render();
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
