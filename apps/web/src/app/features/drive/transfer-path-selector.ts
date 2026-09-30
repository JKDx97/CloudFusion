export interface TransferSourceCandidate {
  peerId: string;
  lastVerifiedAt: string;
}

/** Orders already-authorized peer copies by the best currently observed route. */
export class TransferPathSelector {
  orderSources<T extends TransferSourceCandidate>(
    sources: readonly T[],
    peerStatuses: Readonly<Record<string, string>>,
  ): T[] {
    return [...sources].sort((left, right) => {
      const routeDifference = this.routePriority(left.peerId, peerStatuses) - this.routePriority(right.peerId, peerStatuses);
      if (routeDifference !== 0) return routeDifference;
      return this.verifiedAt(right.lastVerifiedAt) - this.verifiedAt(left.lastVerifiedAt);
    });
  }

  private routePriority(peerId: string, peerStatuses: Readonly<Record<string, string>>): number {
    switch (peerStatuses[peerId]) {
      case 'connected:LAN_DIRECT': return 0;
      case 'connected:P2P_DIRECT': return 1;
      case 'connected:P2P_RELAY': return 2;
      case 'discovered': return 3;
      default: return 4;
    }
  }

  private verifiedAt(value: string): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
