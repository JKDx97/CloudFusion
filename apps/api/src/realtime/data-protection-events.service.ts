import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable, Subject, defer, finalize, interval, map, merge } from 'rxjs';

export type DataProtectionEventType =
  | 'ENCRYPTION_COMPLETED'
  | 'VERSION_CREATED'
  | 'SNAPSHOT_STARTED'
  | 'SNAPSHOT_COMPLETED'
  | 'SNAPSHOT_FAILED'
  | 'BACKUP_STARTED'
  | 'BACKUP_PROGRESS'
  | 'BACKUP_COMPLETED'
  | 'BACKUP_FAILED'
  | 'RESTORE_STARTED'
  | 'RESTORE_PROGRESS'
  | 'RESTORE_COMPLETED'
  | 'RESTORE_FAILED'
  | 'MASS_CHANGE_DETECTED'
  | 'HEARTBEAT';

export interface DataProtectionEvent {
  type: DataProtectionEventType;
  entityId: string | null;
  status?: string;
  progress?: number;
  occurredAt: string;
  details?: Record<string, string | number | boolean | null>;
}

@Injectable()
export class DataProtectionEventsService {
  private readonly listeners = new Map<string, Set<Subject<DataProtectionEvent>>>();

  emit(
    userId: string,
    type: Exclude<DataProtectionEventType, 'HEARTBEAT'>,
    entityId: string | null,
    status?: string,
    details?: DataProtectionEvent['details'],
  ): void {
    const event: DataProtectionEvent = { type, entityId, status, occurredAt: new Date().toISOString(), details };
    for (const listener of this.listeners.get(userId) ?? []) listener.next(event);
  }

  events(userId: string): Observable<MessageEvent> {
    return defer(() => {
      const listener = new Subject<DataProtectionEvent>();
      const userListeners = this.listeners.get(userId) ?? new Set<Subject<DataProtectionEvent>>();
      userListeners.add(listener);
      this.listeners.set(userId, userListeners);
      const heartbeat = interval(25_000).pipe(map((): DataProtectionEvent => ({
        type: 'HEARTBEAT', entityId: null, occurredAt: new Date().toISOString(),
      })));
      return merge(listener, heartbeat).pipe(
        map((data) => ({ data })),
        finalize(() => {
          listener.complete();
          userListeners.delete(listener);
          if (!userListeners.size) this.listeners.delete(userId);
        }),
      );
    });
  }
}
