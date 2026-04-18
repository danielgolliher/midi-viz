// Web MIDI wrapper. Calls onEvent('on'|'off', note, velocity).
// On status change, reports full device list so the UI can reason about
// what's connected vs. merely present-but-disconnected.
export class MidiInput {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.access = null;
    this.devices = []; // [{id, name, manufacturer, state, connection}]
  }

  async init(onStatusChange) {
    if (!navigator.requestMIDIAccess) {
      const err = new Error('Web MIDI not available in this browser');
      err.name = 'NotSupportedError';
      throw err;
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.bindAllInputs();

    this.access.onstatechange = (e) => {
      this.bindAllInputs();
      console.log('[midi] statechange:', e.port && {
        name: e.port.name, state: e.port.state, connection: e.port.connection,
        type: e.port.type, manufacturer: e.port.manufacturer,
      });
      onStatusChange && onStatusChange(this.snapshot());
    };

    onStatusChange && onStatusChange(this.snapshot());
  }

  bindAllInputs() {
    this.devices = [];
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.handle(e);
      this.devices.push({
        id: input.id,
        name: input.name || 'MIDI device',
        manufacturer: input.manufacturer || '',
        state: input.state,        // 'connected' | 'disconnected'
        connection: input.connection, // 'open' | 'closed' | 'pending'
      });
    }
    console.log('[midi] inputs:', this.devices);
  }

  snapshot() {
    return {
      devices: this.devices.slice(),
      connected: this.devices.filter(d => d.state === 'connected'),
    };
  }

  handle(event) {
    const [status, note, velocity] = event.data;
    const type = status & 0xf0;
    if (type === 0x90 && velocity > 0) {
      this.onEvent('on', note, velocity);
    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      this.onEvent('off', note, 0);
    }
  }
}
