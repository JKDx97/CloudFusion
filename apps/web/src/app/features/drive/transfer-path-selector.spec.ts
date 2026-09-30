import { describe, expect, it, vi } from 'vitest';
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

  it('tries the next authorized peer after a failure and stops on success', async () => {
    const attempts: string[] = [];
    const fallback = vi.fn(async () => 'cloud');
    const result = await selector.attemptPeersThenFallback(
      [
        { peerId: 'lan', lastVerifiedAt: '2026-09-30T12:00:00Z' },
        { peerId: 'relay', lastVerifiedAt: '2026-09-30T12:00:00Z' },
      ],
      { lan: 'connected:LAN_DIRECT', relay: 'connected:P2P_RELAY' },
      async (source) => {
        attempts.push(source.peerId);
        if (source.peerId === 'lan') throw new Error('peer unavailable');
        return 'received';
      },
      fallback,
    );

    expect(attempts).toEqual(['lan', 'relay']);
    expect(result).toEqual({ route: 'peer', source: expect.objectContaining({ peerId: 'relay' }), result: 'received' });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses the cloud fallback when no peer is available or every peer fails', async () => {
    const attempts: string[] = [];
    const cloudFallback = vi.fn(async () => 'downloaded');
    const result = await selector.attemptPeersThenFallback(
      [
        { peerId: 'unknown', lastVerifiedAt: '2026-09-30T12:00:00Z' },
        { peerId: 'direct', lastVerifiedAt: '2026-09-30T12:00:00Z' },
      ],
      { direct: 'connected:P2P_DIRECT' },
      async (source) => {
        attempts.push(source.peerId);
        throw new Error('peer unavailable');
      },
      cloudFallback,
    );

    expect(attempts).toEqual(['direct', 'unknown']);
    expect(result).toEqual({ route: 'cloud', result: 'downloaded' });
    expect(cloudFallback).toHaveBeenCalledOnce();
  });

  it('uses cloud directly when there are no advertised peer sources', async () => {
    const attemptPeer = vi.fn(async () => 'peer');
    const cloudFallback = vi.fn(async () => 'downloaded');
    const result = await selector.attemptPeersThenFallback([], {}, attemptPeer, cloudFallback);

    expect(result).toEqual({ route: 'cloud', result: 'downloaded' });
    expect(attemptPeer).not.toHaveBeenCalled();
    expect(cloudFallback).toHaveBeenCalledOnce();
  });
});
