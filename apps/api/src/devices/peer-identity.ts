const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function isMatchingEd25519PeerIdentity(peerId: string, publicKeyBase64: string): boolean {
  const publicKey = Buffer.from(publicKeyBase64, 'base64');
  if (publicKey.toString('base64') !== publicKeyBase64 || publicKey.length !== 36) return false;
  if (publicKey[0] !== 0x08 || publicKey[1] !== 0x01 || publicKey[2] !== 0x12 || publicKey[3] !== 0x20) return false;

  // Ed25519 public keys use libp2p's identity multihash (code 0, digest length 36).
  const multihash = Buffer.concat([Buffer.from([0x00, publicKey.length]), publicKey]);
  return encodeBase58(multihash) === peerId;
}

function encodeBase58(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return '1'.repeat(leadingZeroes) + encoded;
}
