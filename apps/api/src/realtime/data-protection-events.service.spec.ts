import { DataProtectionEventsService } from './data-protection-events.service';

describe('DataProtectionEventsService', () => {
  it('streams events only to the matching user and releases listeners on unsubscribe', () => {
    const service = new DataProtectionEventsService();
    const owner: unknown[] = [];
    const other: unknown[] = [];
    const ownerSubscription = service.events('owner').subscribe((event) => owner.push(event.data));
    const otherSubscription = service.events('other').subscribe((event) => other.push(event.data));

    service.emit('owner', 'BACKUP_PROGRESS', 'job-1', 'RUNNING', { progress: 50 });
    ownerSubscription.unsubscribe();
    service.emit('owner', 'BACKUP_COMPLETED', 'job-1', 'COMPLETED');
    service.emit('other', 'MASS_CHANGE_DETECTED', 'alert-1', 'WARNING');

    expect(owner).toEqual([expect.objectContaining({ type: 'BACKUP_PROGRESS', entityId: 'job-1', status: 'RUNNING' })]);
    expect(other).toEqual([expect.objectContaining({ type: 'MASS_CHANGE_DETECTED', entityId: 'alert-1' })]);
    otherSubscription.unsubscribe();
  });
});
