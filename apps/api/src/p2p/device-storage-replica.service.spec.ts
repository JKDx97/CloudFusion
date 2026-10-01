import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DeviceStorageReplica, DeviceStorageReplicaStatus } from './entities/device-storage-replica.entity';
import { DeviceStorageReplicaService } from './device-storage-replica.service';

const fileHash = 'ab'.repeat(32);
const device = {
  id: 'device-id',
  userId: 'owner-id',
  storageContributionEnabled: true,
  p2pEnabled: false,
  serveLocalFiles: false,
};
const assignment = {
  id: 'assignment-id',
  userId: 'owner-id',
  deviceId: 'device-id',
  nodeId: 'node-id',
  versionId: 'version-id',
  storageObjectId: 'object-id',
  contentHash: fileHash,
  sizeBytes: '17',
  status: DeviceStorageReplicaStatus.DOWNLOADING,
  attempts: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  lastVerifiedAt: null,
};

function makeService(overrides: {
  activeDevice?: typeof device;
  durableReplica?: { remoteFileId: string | null } | null;
} = {}) {
  const assignments = {
    findOne: jest.fn().mockImplementation(async () => ({
      ...assignment,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })),
    save: jest.fn(async (value: DeviceStorageReplica) => value),
    create: jest.fn((value) => value),
    find: jest.fn().mockResolvedValue([]),
  };
  const nodes = { findOne: jest.fn().mockResolvedValue({ id: 'node-id' }) };
  const versions = {
    findOne: jest.fn().mockResolvedValue({
      id: 'version-id',
      virtualNodeId: 'node-id',
      checksum: fileHash,
      size: '17',
    }),
  };
  const cloudReplicas = {
    findOne: jest.fn().mockResolvedValue(
      Object.prototype.hasOwnProperty.call(overrides, 'durableReplica')
        ? overrides.durableReplica
        : { remoteFileId: 'cloud-file-id' },
    ),
  };
  const availability = { findOne: jest.fn(), create: jest.fn((value) => value), save: jest.fn() };
  const deviceSessions = {
    getActive: jest.fn().mockResolvedValue(overrides.activeDevice ?? device),
  };
  const permissions = { canDownload: jest.fn().mockResolvedValue(true) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new DeviceStorageReplicaService(
    assignments as never,
    nodes as never,
    versions as never,
    cloudReplicas as never,
    availability as never,
    {} as never,
    deviceSessions as never,
    permissions as never,
    audit as never,
  );
  return { service, assignments, nodes, versions, cloudReplicas, deviceSessions, permissions, audit };
}

describe('DeviceStorageReplicaService', () => {
  it('confirms a device replica only after matching exact content and a durable cloud copy exists', async () => {
    const fixture = makeService();

    const result = await fixture.service.complete('owner-id', 'device-id', 'assignment-id', {
      contentHash: fileHash,
      sizeBytes: '17',
    });

    expect(result).toMatchObject({ assignmentId: 'assignment-id', status: DeviceStorageReplicaStatus.AVAILABLE });
    expect(fixture.assignments.save).toHaveBeenCalledWith(expect.objectContaining({
      status: DeviceStorageReplicaStatus.AVAILABLE,
      lastVerifiedAt: expect.any(Date),
    }));
    expect(fixture.audit.record).toHaveBeenCalledWith('owner-id', 'DEVICE_REPLICA_STORED', 'DeviceStorageReplica', 'assignment-id', expect.any(Object));
  });

  it('rejects a device report whose content hash or size differs from the assignment', async () => {
    const fixture = makeService();

    await expect(fixture.service.complete('owner-id', 'device-id', 'assignment-id', {
      contentHash: 'cd'.repeat(32),
      sizeBytes: '17',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.assignments.save).not.toHaveBeenCalled();
  });

  it('does not confirm a device copy if its durable cloud replica is no longer healthy', async () => {
    const fixture = makeService({ durableReplica: null });

    await expect(fixture.service.complete('owner-id', 'device-id', 'assignment-id', {
      contentHash: fileHash,
      sizeBytes: '17',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.assignments.save).not.toHaveBeenCalled();
  });

  it('rejects use by a device that has not opted into storage contribution', async () => {
    const fixture = makeService({ activeDevice: { ...device, storageContributionEnabled: false } });

    await expect(fixture.service.complete('owner-id', 'device-id', 'assignment-id', {
      contentHash: fileHash,
      sizeBytes: '17',
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.assignments.findOne).not.toHaveBeenCalled();
  });
});
