const EMPTY_SHA1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export function sha1Plain(data: Uint8Array): string {
  const words = new Uint32Array(80);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rol = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rol(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const next = (rol(a, 5) + f + e + k + words[i]!) | 0;
      [e, d, c, b, a] = [d, c, rol(b, 30), a, next];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) | 0, (h1 + b) | 0, (h2 + c) | 0, (h3 + d) | 0, (h4 + e) | 0];
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((value, i) => outView.setUint32(i * 4, value >>> 0));
  return hex(out);
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
  const whole = new Uint8Array(head.length + body.length);
  whole.set(head);
  whole.set(body, head.length);
  return sha1Plain(whole);
}

export const isTextOfBytes = (text: string, sha: string): boolean => gitBlobShaOfText(text) === sha || gitBlobShaOfText(`\uFEFF${text}`) === sha;

export async function gitBlobSha(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const whole = new Uint8Array(head.length + body.length);
  whole.set(head);
  whole.set(body, head.length);
  return (await sha1())(whole);
}
