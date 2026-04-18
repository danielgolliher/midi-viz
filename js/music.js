export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function pitchClass(note) {
  return ((note % 12) + 12) % 12;
}

// Circle-of-fifths position for a pitch class (C=0, G=1, D=2, ...).
export function fifthsIndex(pc) {
  return (pc * 7) % 12;
}

const TRIAD_PATTERNS = {
  major:      [0, 4, 7],
  minor:      [0, 3, 7],
  diminished: [0, 3, 6],
  augmented:  [0, 4, 8],
};

// Returns { root, rootName, quality } or null.
// Accepts any set of active MIDI notes; considers all pitch classes, dedup'd.
// If more than 3 pitch classes are held, prefers a triad subset if one exists.
export function detectTriad(activeNotes) {
  if (activeNotes.length < 3) return null;
  const pcs = [...new Set(activeNotes.map(pitchClass))];
  if (pcs.length < 3) return null;

  for (const root of pcs) {
    const intervals = new Set(pcs.map(pc => (pc - root + 12) % 12));
    for (const [quality, pattern] of Object.entries(TRIAD_PATTERNS)) {
      if (pattern.every(i => intervals.has(i))) {
        return { root, rootName: PITCH_NAMES[root], quality };
      }
    }
  }
  return null;
}

// Tracks recent note-on events to recognize ascending/descending arpeggios.
export class ArpeggioDetector {
  constructor({ windowMs = 900, minNotes = 3 } = {}) {
    this.windowMs = windowMs;
    this.minNotes = minNotes;
    this.history = [];
    this.lastEmittedAt = 0;
  }

  push(note, time) {
    this.history.push({ note, time });
    this.history = this.history.filter(n => time - n.time < this.windowMs);
  }

  detect(now) {
    if (this.history.length < this.minNotes) return null;
    if (now - this.lastEmittedAt < 300) return null;

    const recent = this.history.slice(-6);
    const notes = recent.map(n => n.note);
    if (notes.length < this.minNotes) return null;

    let ascending = true, descending = true;
    for (let i = 1; i < notes.length; i++) {
      const d = notes[i] - notes[i - 1];
      if (!(d > 0 && d <= 12)) ascending = false;
      if (!(d < 0 && d >= -12)) descending = false;
    }
    if (!ascending && !descending) return null;

    this.lastEmittedAt = now;
    return { notes: notes.slice(), direction: ascending ? 'up' : 'down' };
  }
}
