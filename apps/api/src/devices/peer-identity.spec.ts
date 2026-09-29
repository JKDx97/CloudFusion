import { isMatchingEd25519PeerIdentity } from './peer-identity';

describe('libp2p Ed25519 peer identity', () => {
  it('accepts a peer id derived from its protobuf public key', () => {
    const publicKey = Buffer.from([0x08, 0x01, 0x12, 0x20, ...Array.from({ length: 32 }, (_, index) => index)]);
    const peerId = encodeBase58(Buffer.concat([Buffer.from([0x00, 0x24]), publicKey]));

    expect(isMatchingEd25519PeerIdentity(peerId, publicKey.toString('base64'))).toBe(true);
    expect(isMatchingEd25519PeerIdentity(`${peerId}1`, publicKey.toString('base64'))).toBe(false);
  });
});

function encodeBase58(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return '1'.repeat(leadingZeroes) + encoded;
}
