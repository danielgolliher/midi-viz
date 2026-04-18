import { MidiInput } from './js/midi.js';
import { KeyboardInput } from './js/keyboard.js';
import { detectTriad, ArpeggioDetector, PITCH_NAMES } from './js/music.js';
import { PaintingGallery, moodLabel } from './js/paintings.js';
import { Synth } from './js/synth.js';
// AbstractViz is loaded dynamically so Three.js / WebGL failures can't
// prevent MIDI initialization.

const TRIAD_HOLD_MS = 220;   // hold a triad this long before committing
const TRIAD_COOLDOWN_MS = 700; // don't re-trigger the same chord quicker than this

const canvas = document.getElementById('viz');
const modeBtn = document.getElementById('mode-toggle');
const modeLabel = modeBtn.querySelector('.label');
const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connect-btn');
const muteBtn = document.getElementById('mute-btn');
const muteLabel = muteBtn.querySelector('.label');
const helpBtn = document.getElementById('help-toggle');
const helpEl = document.getElementById('help');
const paintingLayer = document.getElementById('painting-layer');
const paintingImg = document.getElementById('painting-img');
const paintingCap = document.getElementById('painting-caption');

const state = {
  mode: 'abstract', // or 'painting'
  active: new Map(), // note -> velocity
  lastTriad: null,
  lastTriadAt: 0,
  pendingTriad: null,
  pendingTriadAt: 0,
};

function makeNoopViz() {
  return {
    noteOn() {}, noteOff() {}, onChord() {}, onArpeggio() {}, frame() {}, clear() {},
  };
}
let viz = makeNoopViz();
const gallery = new PaintingGallery();
const arp = new ArpeggioDetector();
const synth = new Synth();

// Load the Three.js visual engine in the background. MIDI will already
// be running by the time this resolves.
let vizFailed = null;
(async () => {
  try {
    const { AbstractViz } = await import('./js/abstract.js');
    viz = new AbstractViz(canvas);
    console.log('[viz] Three.js engine ready');
  } catch (e) {
    console.error('[viz] failed to load:', e, e && e.stack);
    vizFailed = e;
    const message = (e && (e.message || e.toString())) || 'unknown error';
    const firstLine = String(message).split('\n')[0].slice(0, 180);
    setTimeout(() => {
      setOverride(`Visuals: ${firstLine}`, 'err');
      showVizErrorPanel(e);
    }, 50);
  }
})();

function showVizErrorPanel(err) {
  if (document.getElementById('viz-error')) return;
  const el = document.createElement('div');
  el.id = 'viz-error';
  const msg = (err && (err.message || err.toString())) || 'unknown';
  const stack = (err && err.stack) ? String(err.stack) : '';
  el.innerHTML = `
    <div class="ve-inner">
      <strong>Visual engine failed to load</strong>
      <div class="ve-msg"></div>
      <details><summary>Stack trace</summary><pre></pre></details>
      <button id="ve-close" aria-label="Close">&times;</button>
    </div>`;
  el.querySelector('.ve-msg').textContent = msg;
  el.querySelector('pre').textContent = stack;
  document.body.appendChild(el);
  el.querySelector('#ve-close').addEventListener('click', () => el.remove());
}

// Call on any user gesture so iOS/iPadOS Safari unlocks audio.
function unlockAudio() { synth.ensure().catch(() => {}); }

function showIpadBanner() {
  let banner = document.getElementById('ipad-banner');
  if (banner) return;
  banner = document.createElement('div');
  banner.id = 'ipad-banner';
  banner.innerHTML = `
    <div class="ib-inner">
      <strong>MIDI can't work in iPad browsers.</strong>
      Apple has not implemented Web MIDI in Safari, and every other iPad browser uses Safari's engine.
      Either view this site on a laptop (Chrome / Edge / Safari 18+ on Mac all work), or try the
      <a href="https://apps.apple.com/us/app/web-midi-browser/id953846217" target="_blank" rel="noopener">Web MIDI Browser</a>
      app from the App Store — it's an older third-party browser that polyfills MIDI, results may vary.
      <button id="ib-close" type="button" aria-label="Dismiss">&times;</button>
    </div>`;
  document.body.appendChild(banner);
  banner.querySelector('#ib-close').addEventListener('click', () => banner.remove());
}

// ---------- Status indicator ----------
// Base shows MIDI connection state; `override` temporarily replaces it
// (e.g. painting-load progress) until cleared.
let midiLine = { text: 'Detecting MIDI…', cls: 'info' };
let override = null;

function renderStatus() {
  const s = override || midiLine;
  statusEl.textContent = s.text;
  statusEl.className = s.cls;
}
function setMidiStatus(text, cls) {
  midiLine = { text, cls };
  renderStatus();
}
function setOverride(text, cls) {
  override = text ? { text, cls } : null;
  renderStatus();
}
function updateConnectBtn(connected) {
  connectBtn.classList.toggle('visible', !connected);
}

// ---------- Triad commit/debounce ----------

function maybeCommitTriad(now) {
  const notes = [...state.active.keys()];
  const triad = detectTriad(notes);

  if (!triad) {
    state.pendingTriad = null;
    return;
  }

  const sig = `${triad.root}:${triad.quality}`;
  const prevSig = state.pendingTriad && `${state.pendingTriad.root}:${state.pendingTriad.quality}`;

  if (sig !== prevSig) {
    state.pendingTriad = triad;
    state.pendingTriadAt = now;
    return;
  }

  // Held long enough — commit
  if (now - state.pendingTriadAt < TRIAD_HOLD_MS) return;

  const sameAsLast = state.lastTriad
    && state.lastTriad.root === triad.root
    && state.lastTriad.quality === triad.quality;

  if (sameAsLast && now - state.lastTriadAt < TRIAD_COOLDOWN_MS) return;

  state.lastTriad = triad;
  state.lastTriadAt = now;

  viz.onChord(triad);
  if (state.mode === 'painting') {
    showPaintingFor(triad);
  }
}

// ---------- Note routing ----------

function onNote(kind, note, velocity) {
  const now = performance.now();
  if (kind === 'on') {
    state.active.set(note, velocity);
    synth.noteOn(note, velocity);
    viz.noteOn(note, velocity);
    arp.push(note, now);
    const a = arp.detect(now);
    if (a) viz.onArpeggio(a);
    maybeCommitTriad(now);
  } else {
    state.active.delete(note);
    synth.noteOff(note);
    viz.noteOff(note);
    // If a chord breaks apart, clear pending so we don't commit a stale read
    if (state.active.size < 3) state.pendingTriad = null;
  }
}

// Re-evaluate pending triads on a timer (so a held chord commits even with no new events)
setInterval(() => {
  if (state.active.size >= 3) maybeCommitTriad(performance.now());
}, 80);

// ---------- Painting mode ----------

async function activatePaintingMode() {
  paintingLayer.classList.add('visible');
  if (!gallery.hasAny()) {
    setOverride('Loading paintings from the Met…', 'info');
    try {
      await gallery.ensureLoaded(({ done, finished, total }) => {
        if (!done && finished && total) {
          setOverride(`Loading paintings… ${finished}/${total}`, 'info');
        }
      });
      setOverride(null);
    } catch (e) {
      setOverride('Couldn’t reach the Met API.', 'err');
      console.error(e);
      setTimeout(() => setOverride(null), 3000);
    }
  }
  // If a chord is currently held, display it
  const triad = detectTriad([...state.active.keys()]);
  if (triad) showPaintingFor(triad);
}

function deactivatePaintingMode() {
  paintingLayer.classList.remove('visible');
}

function showPaintingFor(triad) {
  const painting = gallery.pick(triad.quality);
  if (!painting) return;

  paintingImg.classList.remove('loaded');
  const next = new Image();
  next.onload = () => {
    paintingImg.src = next.src;
    requestAnimationFrame(() => paintingImg.classList.add('loaded'));
    paintingCap.querySelector('.pc-title').textContent = painting.title;
    paintingCap.querySelector('.pc-meta').textContent =
      [painting.artist, painting.year].filter(Boolean).join(' · ');
    paintingCap.querySelector('.pc-chord').textContent =
      `${triad.rootName} ${triad.quality} · ${moodLabel(triad.quality)}`;
  };
  next.onerror = () => {
    setOverride('Painting failed to load.', 'warn');
    setTimeout(() => setOverride(null), 2500);
  };
  next.src = painting.url;
}

// ---------- Mode toggle ----------

function setMode(mode) {
  state.mode = mode;
  modeBtn.setAttribute('aria-pressed', mode === 'painting' ? 'true' : 'false');
  modeLabel.textContent = mode === 'painting' ? 'Painting' : 'Abstract';
  if (mode === 'painting') activatePaintingMode();
  else deactivatePaintingMode();
}

modeBtn.addEventListener('click', () => {
  unlockAudio();
  setMode(state.mode === 'abstract' ? 'painting' : 'abstract');
});

// ---------- Mute ----------

function setMuted(muted) {
  synth.setMuted(muted);
  muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  muteLabel.textContent = muted ? 'Muted' : 'Sound';
}
muteBtn.addEventListener('click', () => {
  unlockAudio();
  setMuted(muteBtn.getAttribute('aria-pressed') !== 'true');
});

// ---------- Help ----------

function toggleHelp(force) {
  const show = typeof force === 'boolean' ? force : helpEl.hidden;
  helpEl.hidden = !show;
}
helpBtn.addEventListener('click', () => toggleHelp());
helpEl.addEventListener('click', (e) => { if (e.target === helpEl) toggleHelp(false); });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === '?' || (e.key === '/' && e.shiftKey)) { toggleHelp(); e.preventDefault(); }
  else if (e.key === 'Escape') toggleHelp(false);
  else if (e.key === ' ') { unlockAudio(); setMode(state.mode === 'abstract' ? 'painting' : 'abstract'); e.preventDefault(); }
  else if (e.key === 'm' || e.key === 'M') { unlockAudio(); setMuted(muteBtn.getAttribute('aria-pressed') !== 'true'); }
});

// ---------- Render loop ----------

function tick() {
  viz.frame();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------- Boot ----------

const midi = new MidiInput(onNote);

// Any browser on iPadOS/iOS is ultimately WebKit (Apple forbids other engines).
// Detecting "iPad at all" is what matters — not whether it's Safari vs. Chrome.
function isIosWebKit() {
  const ua = navigator.userAgent;
  const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || isTouchMac;
}

function applyDeviceList(snap) {
  const { devices, connected } = snap;
  if (connected.length > 0) {
    const names = connected.map(d => d.name).join(', ');
    setMidiStatus(`Piano connected · ${names}`, 'ok');
    updateConnectBtn(true);
  } else if (devices.length > 0) {
    // Device known but state !== 'connected' — likely unplugged or pending
    setMidiStatus(`${devices.length} MIDI device(s) present but disconnected — check cable/power`, 'warn');
    updateConnectBtn(false);
  } else {
    const tip = isIosWebKit()
      ? ' — iPad browsers cannot access MIDI (see banner)'
      : ' — QWERTY fallback active';
    setMidiStatus(`No MIDI device detected${tip}`, 'warn');
    updateConnectBtn(false);
  }
}

async function connectMidi() {
  unlockAudio();
  if (!navigator.requestMIDIAccess) {
    if (isIosWebKit()) {
      setMidiStatus('Web MIDI not supported on iPad (Apple limitation)', 'err');
      showIpadBanner();
    } else {
      setMidiStatus('Web MIDI not available — use Chrome, Edge, or Safari 18+ on macOS/PC', 'err');
    }
    updateConnectBtn(false);
    connectBtn.disabled = true;
    return;
  }
  setMidiStatus('Requesting MIDI access…', 'info');
  try {
    await midi.init(applyDeviceList);
  } catch (e) {
    console.error('[midi] init failed:', e);
    const name = e.name || 'Error';
    let hint = '';
    if (name === 'SecurityError') hint = ' — page must be served over HTTPS';
    else if (name === 'NotAllowedError') hint = ' — permission denied; tap Connect MIDI and Allow';
    else if (name === 'NotSupportedError') hint = ' — browser does not support Web MIDI';
    setMidiStatus(`${name}: ${e.message || 'unknown'}${hint}`, 'err');
    updateConnectBtn(false);
  }
}

connectBtn.addEventListener('click', () => { connectMidi(); });

async function boot() {
  const kb = new KeyboardInput(onNote);
  kb.attach();
  updateConnectBtn(false); // visible until we confirm a connection
  await connectMidi();
}

boot();
