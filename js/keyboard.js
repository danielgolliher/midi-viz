// QWERTY -> MIDI fallback so the visualizer works without a physical keyboard.
// Two rows starting at middle C (MIDI 60). Z/X shift octave.
const WHITE = ['a','s','d','f','g','h','j','k','l',';'];
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16]; // C D E F G A B C D E
const BLACK = { 'w': 1, 'e': 3, 't': 6, 'y': 8, 'u': 10, 'o': 13, 'p': 15 }; // C# D# F# G# A# C# D#

export class KeyboardInput {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.baseNote = 60;
    this.active = new Set();
    this._onDown = (e) => this.handleDown(e);
    this._onUp = (e) => this.handleUp(e);
  }

  attach() {
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
  }

  detach() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
  }

  noteFor(key) {
    const k = key.toLowerCase();
    const wi = WHITE.indexOf(k);
    if (wi >= 0) return this.baseNote + WHITE_OFFSETS[wi];
    if (k in BLACK) return this.baseNote + BLACK[k];
    return null;
  }

  handleDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k === 'z') { this.baseNote = Math.max(24, this.baseNote - 12); return; }
    if (k === 'x') { this.baseNote = Math.min(96, this.baseNote + 12); return; }
    const n = this.noteFor(k);
    if (n === null || this.active.has(n) || e.repeat) return;
    this.active.add(n);
    this.onEvent('on', n, 90);
  }

  handleUp(e) {
    const n = this.noteFor(e.key);
    if (n === null) return;
    this.active.delete(n);
    this.onEvent('off', n, 0);
  }
}
