const EMPTY_SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

const SUBTLE_INLINE_MAX_BYTES = 4 * 1024 * 1024;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const rol = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));

function compressBlock(state: [number, number, number, number, number], words: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const p = offset + i * 4;
    words[i] = ((block[p]! << 24) | (block[p + 1]! << 16) | (block[p + 2]! << 8) | block[p + 3]!) >>> 0;
  }
  for (let i = 16; i < 80; i++) {
    words[i] = rol(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
  }
  let [a, b, c, d, e] = state;
  for (let i = 0; i < 80; i++) {
    const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
    const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
    const next = (rol(a, 5) + f + e + k + words[i]!) | 0;
    e = d;
    d = c;
    c = rol(b, 30);
    b = a;
    a = next;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
}

export class StreamingSha1 {
  private readonly state: [number, number, number, number, number] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  private readonly buf = new Uint8Array(64);
  private readonly words = new Uint32Array(80);
  private buffered = 0;
  private totalBytes = 0;

  update(chunk: Uint8Array): this {
    const len = chunk.length;
    if (len === 0) return this;
    this.totalBytes += len;
    let offset = 0;
    if (this.buffered > 0) {
      const take = Math.min(64 - this.buffered, len);
      this.buf.set(chunk.subarray(0, take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) {
        compressBlock(this.state, this.words, this.buf, 0);
        this.buffered = 0;
      }
    }
    while (offset + 64 <= len) {
      compressBlock(this.state, this.words, chunk, offset);
      offset += 64;
    }
    if (offset < len) {
      this.buf.set(chunk.subarray(offset), 0);
      this.buffered = len - offset;
    }
    return this;
  }

  digestHex(): string {
    const state: [number, number, number, number, number] = [this.state[0], this.state[1], this.state[2], this.state[3], this.state[4]];
    const tail = new Uint8Array(64);
    tail.set(this.buf.subarray(0, this.buffered));
    tail[this.buffered] = 0x80;
    if (this.buffered >= 56) {
      compressBlock(state, this.words, tail, 0);
      tail.fill(0);
    }
    const view = new DataView(tail.buffer);
    view.setUint32(56, Math.floor(this.totalBytes / 0x20000000));
    view.setUint32(60, (this.totalBytes << 3) >>> 0);
    compressBlock(state, this.words, tail, 0);
    const out = new Uint8Array(20);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) outView.setUint32(i * 4, state[i]! >>> 0);
    return hex(out);
  }
}

export function sha1Plain(data: Uint8Array): string {
  return new StreamingSha1().update(data).digestHex();
}

type Sha1 = (data: Uint8Array) => Promise<string>;

async function subtleSha1(): Promise<Sha1 | null> {
  try {
    const subtle = window.crypto?.subtle;
    if (!subtle) return null;
    const digest = async (data: Uint8Array): Promise<string> => hex(new Uint8Array(await subtle.digest("SHA-1", data as BufferSource)));
    return (await digest(new Uint8Array())) === EMPTY_SHA1 ? digest : null;
  } catch {
    return null;
  }
}

let chosen: Promise<Sha1> | null = null;

function sha1(): Promise<Sha1> {
  chosen ??= subtleSha1().then((subtle) => subtle ?? ((data) => Promise.resolve(sha1Plain(data))));
  return chosen;
}

export function gitBlobShaOfText(text: string): string {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  return new StreamingSha1().update(head).update(body).digestHex();
}

export const isTextOfBytes = (text: string, sha: string): boolean => gitBlobShaOfText(text) === sha || gitBlobShaOfText(`\uFEFF${text}`) === sha;

export async function gitBlobSha(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  if (body.length > SUBTLE_INLINE_MAX_BYTES) return new StreamingSha1().update(head).update(body).digestHex();
  const whole = new Uint8Array(head.length + body.length);
  whole.set(head);
  whole.set(body, head.length);
  return (await sha1())(whole);
}

export async function gitBlobShaOfStream(size: number, stream: ReadableStream<Uint8Array>): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) {
    await stream.cancel().catch(() => undefined);
    throw new Error("Invalid blob size.");
  }
  const hasher = new StreamingSha1().update(new TextEncoder().encode(`blob ${size}\0`));
  const reader = stream.getReader();
  let seen = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      seen += value.byteLength;
      if (seen > size) throw new Error("Blob stream exceeded expected size.");
      hasher.update(value);
    }
    if (seen !== size) throw new Error("Blob stream size mismatch.");
    return hasher.digestHex();
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type BoundedStreamRead = { ok: true; bytes: ArrayBuffer } | { ok: false; outage: boolean };

export async function readStreamBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, expectedSize?: number): Promise<BoundedStreamRead> {
  if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes)) {
    await stream.cancel().catch(() => undefined);
    return { ok: false, outage: false };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let eof = false;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        return { ok: false, outage: true };
      }
      if (step.done) {
        eof = true;
        break;
      }
      const { value } = step;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes || (expectedSize !== undefined && total > expectedSize)) return { ok: false, outage: false };
      chunks.push(value);
    }
    if (expectedSize !== undefined && total !== expectedSize) return { ok: false, outage: true };
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes: out.buffer };
  } finally {
    if (!eof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
