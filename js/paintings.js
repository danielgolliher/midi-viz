// Painting bank sourced at runtime from the Met Museum Open Access API.
// https://metmuseum.github.io/  — public domain works only.

const MET_API = 'https://collectionapi.metmuseum.org/public/collection/v1';
const CACHE_KEY = 'midi-viz-paintings-v3';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

// Artists grouped by the mood their best-known work evokes.
const MOOD_ARTISTS = {
  major: [       // luminous, triumphant, grand — Hudson River / Luminism
    'Frederic Edwin Church',
    'Albert Bierstadt',
    'Thomas Moran',
    'John Frederick Kensett',
    'Fitz Henry Lane',
  ],
  minor: [       // tonalist, pensive, nocturnal
    'George Inness',
    'James McNeill Whistler',
    'Dwight William Tryon',
    'John Henry Twachtman',
  ],
  diminished: [  // stormy, ominous, unresolved
    'Albert Pinkham Ryder',
    'Winslow Homer',
    'Washington Allston',
  ],
  augmented: [   // sublime, dreamlike, allegorical
    'Thomas Cole',
    'Martin Johnson Heade',
    'Sanford Robinson Gifford',
    'Elihu Vedder',
  ],
};

const MAX_PER_ARTIST = 8;

export class PaintingGallery {
  constructor() {
    this.byMood = { major: [], minor: [], diminished: [], augmented: [] };
    this.loaded = false;
    this.loading = null;
    this.lastShown = new Map(); // mood -> painting
  }

  hasAny() {
    return Object.values(this.byMood).some(arr => arr.length > 0);
  }

  async ensureLoaded(onProgress) {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this._load(onProgress).finally(() => { this.loading = null; });
    return this.loading;
  }

  async _load(onProgress) {
    const cached = this._readCache();
    if (cached) {
      this.byMood = cached;
      this.loaded = true;
      onProgress && onProgress({ done: true, cached: true });
      return;
    }

    const totalArtists = Object.values(MOOD_ARTISTS).reduce((a, b) => a + b.length, 0);
    let finished = 0;

    for (const [mood, artists] of Object.entries(MOOD_ARTISTS)) {
      for (const artist of artists) {
        try {
          const items = await this._fetchArtist(artist);
          this.byMood[mood].push(...items);
        } catch (e) {
          console.warn(`[paintings] ${artist}:`, e.message);
        }
        finished++;
        onProgress && onProgress({ done: false, finished, total: totalArtists, artist });
      }
    }

    this._writeCache(this.byMood);
    this.loaded = true;
    onProgress && onProgress({ done: true, cached: false });
  }

  async _fetchArtist(artist) {
    const searchUrl = `${MET_API}/search?hasImages=true&artistOrCulture=true&q=${encodeURIComponent(artist)}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error(`search ${searchRes.status}`);
    const search = await searchRes.json();
    if (!search.objectIDs || search.objectIDs.length === 0) return [];

    const ids = search.objectIDs.slice(0, MAX_PER_ARTIST * 2);
    const objs = await Promise.all(ids.map(id =>
      fetch(`${MET_API}/objects/${id}`).then(r => r.ok ? r.json() : null).catch(() => null)
    ));

    const lastName = artist.split(' ').pop().toLowerCase();
    // Met's `classification` field is empty for most painting records, so we
    // can't rely on it. Instead, keep anything with a public-domain primary
    // image whose artist name actually matches, and prefer oil/canvas media
    // when available. Non-painting media (engraving, drawing) still land in
    // the pool but are visually on-theme for these artists.
    return objs
      .filter(o => o
        && o.isPublicDomain
        && o.primaryImage
        && (o.artistDisplayName || '').toLowerCase().includes(lastName))
      .sort((a, b) => {
        const score = (o) => /oil|canvas|panel/i.test(o.medium || '') ? 0 : 1;
        return score(a) - score(b);
      })
      .slice(0, MAX_PER_ARTIST)
      .map(o => ({
        url: o.primaryImage,
        thumb: o.primaryImageSmall || o.primaryImage,
        title: o.title || 'Untitled',
        artist: o.artistDisplayName || artist,
        year: o.objectDate || '',
        objectUrl: o.objectURL || '',
      }));
  }

  _readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const { stored, byMood } = JSON.parse(raw);
      if (!stored || !byMood) return null;
      if (Date.now() - stored > CACHE_TTL_MS) return null;
      return byMood;
    } catch { return null; }
  }

  _writeCache(byMood) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ stored: Date.now(), byMood }));
    } catch { /* quota exceeded; ignore */ }
  }

  pick(mood) {
    const bucket = this.byMood[mood] || [];
    if (bucket.length === 0) return null;
    const prev = this.lastShown.get(mood);
    let choice = bucket[Math.floor(Math.random() * bucket.length)];
    // One retry to avoid immediate repeat
    if (bucket.length > 1 && choice === prev) {
      choice = bucket[Math.floor(Math.random() * bucket.length)];
    }
    this.lastShown.set(mood, choice);
    return choice;
  }
}

// Human-readable mood label for captioning
export function moodLabel(quality) {
  return {
    major: 'luminous',
    minor: 'tonalist',
    diminished: 'stormy',
    augmented: 'sublime',
  }[quality] || quality;
}
