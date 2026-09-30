import { describe, expect, it } from 'vitest';
import { TransferPathSelector } from './transfer-path-selector';

describe('TransferPathSelector', () => {
  const selector = new TransferPathSelector();

  it('prefers LAN, then direct Internet P2P, relay, and finally unknown routes', () => {
    const sources = [
      { peerId: 'unknown', lastVerifiedAt: '2026-09-30T12:00:00Z' },
      { peerId: 'relay', lastVerifiedAt: '2026-09-30T12:00:00Z' },
      { peerId: 'direct', lastVerifiedAt: '2026-09-30T12:00:00Z' },
      { peerId: 'lan', lastVerifiedAt: '2026-09-30T12:00:00Z' },
    ];
    const ordered = selector.orderSources(sources, {
      lan: 'connected:LAN_DIRECT',
      direct: 'connected:P2P_DIRECT',
      relay: 'connected:P2P_RELAY',
    });

    expect(ordered.map(({ peerId }) => peerId)).toEqual(['lan', 'direct', 'relay', 'unknown']);
    expect(sources.map(({ peerId }) => peerId)).toEqual(['unknown', 'relay', 'direct', 'lan']);
  });

  it('prefers the most recently verified source when route quality is equal', () => {
    const ordered = selector.orderSources([
      { peerId: 'older', lastVerifiedAt: '2026-09-30T10:00:00Z' },
      { peerId: 'newer', lastVerifiedAt: '2026-09-30T11:00:00Z' },
    ], {});

    expect(ordered.map(({ peerId }) => peerId)).toEqual(['newer', 'older']);
  });
});
