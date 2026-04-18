// Thin Web MIDI wrapper. Calls onEvent('on'|'off', note, velocity).
export class MidiInput {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.access = null;
    this.deviceNames = new Set();
  }

  async init(onStatusChange) {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI API not supported in this browser (try Chrome or Edge).');
    }
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.bindAllInputs();
    this.access.onstatechange = () => {
      this.bindAllInputs();
      onStatusChange && onStatusChange(this.listDevices());
    };
    onStatusChange && onStatusChange(this.listDevices());
  }

  bindAllInputs() {
    this.deviceNames.clear();
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.handle(e);
      this.deviceNames.add(input.name || 'MIDI device');
    }
  }

  listDevices() {
    return [...this.deviceNames];
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
