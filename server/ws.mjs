// Minimal RFC 6455 WebSocket server (text + binary, ping/pong, close). No dependencies, Node 18+.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function attachWebSocket(server, path, onConnection) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== path || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const ws = new Peer(socket, req, url);
    onConnection(ws);
  });
}

class Peer {
  constructor(socket, req, url) {
    this.socket = socket;
    this.req = req;
    this.url = url;
    this.open = true;
    this.handlers = { message: [], close: [] };
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.lastSeen = Date.now();
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }
  on(ev, fn) { this.handlers[ev].push(fn); }
  _emit(ev, ...a) { for (const fn of this.handlers[ev]) { try { fn(...a); } catch (e) { console.error('ws handler', e); } } }
  _closed() {
    if (!this.open) return;
    this.open = false;
    this._emit('close');
  }
  _data(d) {
    if (!this.open) return;
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 8 * 1024 * 1024) { this.close(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      this._frame(fin, opcode, payload);
      if (!this.open) return;
    }
  }
  _frame(fin, opcode, payload) {
    if (opcode === 0x8) { this._send(0x8, Buffer.alloc(0)); this.socket.end(); this._closed(); return; }
    if (opcode === 0x9) { this._send(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (this.fragments.reduce((a, f) => a + f.length, 0) > 8 * 1024 * 1024) { this.close(); return; }
      if (fin) { const all = Buffer.concat(this.fragments); this.fragments = []; this._deliver(this.fragOpcode, all); }
      return;
    }
    if (!fin) { this.fragOpcode = opcode; this.fragments = [payload]; return; }
    this._deliver(opcode, payload);
  }
  _deliver(opcode, payload) {
    this._emit('message', opcode === 0x1 ? payload.toString('utf8') : payload, opcode === 0x2);
  }
  _send(opcode, data) {
    if (!this.open || this.socket.destroyed) return;
    const len = data.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    // Drop frames for clients that can't keep up instead of buffering forever.
    if (this.socket.writableLength > 2 * 1024 * 1024) return;
    this.socket.write(Buffer.concat([header, data]));
  }
  send(data) {
    if (typeof data === 'string') this._send(0x1, Buffer.from(data, 'utf8'));
    else this._send(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }
  get backlog() { return this.socket.writableLength; }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  close() { if (this.open) { this._send(0x8, Buffer.alloc(0)); this.socket.end(); this._closed(); } }
}
