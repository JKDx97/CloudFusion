import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';

interface OAuthStateRecord {
  userId: string;
  provider: string;
  expiresAt: number;
}

@Injectable()
export class OAuthStateService {
  private readonly states = new Map<string, OAuthStateRecord>();

  constructor(private readonly config: ConfigService) {}

  create(userId: string, provider: string): string {
    this.cleanup();
    const state = randomBytes(32).toString('base64url');
    const ttl = this.config.get<number>('cloud.oauthStateTtlSeconds') ?? 600;
    this.states.set(state, { userId, provider, expiresAt: Date.now() + ttl * 1000 });
    return state;
  }

  consume(state: string, provider: string): string | null {
    this.cleanup();
    const record = this.states.get(state);
    this.states.delete(state);
    if (!record || record.provider !== provider || record.expiresAt < Date.now()) return null;
    return record.userId;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [state, record] of this.states) {
      if (record.expiresAt < now) this.states.delete(state);
    }
  }
}
