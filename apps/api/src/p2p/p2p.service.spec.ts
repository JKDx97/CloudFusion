import { ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PeerTransferSession } from './entities/peer-transfer-session.entity';
import { DeviceFileAvailability } from './entities/device-file-availability.entity';
import { PeerTransferStatus } from './enums/peer-transfer-status.enum';
import { P2pService } from './p2p.service';
import { VirtualNodeStatus } from '../virtual-fs/enums/virtual-node-status.enum';
import { VirtualNodeType } from '../virtual-fs/enums/virtual-node-type.enum';

const checksum = 'ab'.repeat(32);
const sourceDevice = {
  id: 'source-device', userId: 'source-user', name: 'Source', platform: 'WINDOWS',
  peerId: '12D3KooWSource', p2pEnabled: true, serveLocalFiles: true, revokedAt: null,
} as never;
const destinationDevice = {
  id: 'destination-device', userId: 'destination-user', name: 'Destination', platform: 'WINDOWS',
  peerId: '12D3KooWDestination', p2pEnabled: true, serveLocalFiles: false, revokedAt: null,
} as never;
const node = {
  id: 'node-id', userId: 'source-user', type: VirtualNodeType.FILE, status: VirtualNodeStatus.AVAILABLE, deletedAt: null,
} as never;
const version = { id: 'version-id', virtualNodeId: 'node-id', checksum, size: '17' } as never;

function createTransfer(status = PeerTransferStatus.AUTHORIZED): PeerTransferSession {
  return {
    id: 'transfer-id',
    sourceUserId: 'source-user',
    destinationUserId: 'destination-user',
    sourceDeviceId: 'source-device',
    destinationDeviceId: 'destination-device',
    nodeId: 'node-id',
    versionId: 'version-id',
    contentHash: checksum,
    totalBytes: '17',
    status,
    transport: null,
    bytesTransferred: '0',
    ticketExpiresAt: new Date(Date.now() + 60_000),
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as PeerTransferSession;
}

function makeService() {
  const devices = { findOne: jest.fn().mockResolvedValue(sourceDevice) };
  const nodes = { findOne: jest.fn().mockResolvedValue(node) };
  const versions = { findOne: jest.fn().mockResolvedValue(version) };
  const availability = {
    findOne: jest.fn().mockResolvedValue({
      deviceId: 'source-device', nodeId: 'node-id', versionId: 'version-id',
      contentHash: checksum, sizeBytes: '17', expiresAt: new Date(Date.now() + 60_000),
    }),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const queryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const transfers = {
    create: jest.fn((value) => ({ id: 'transfer-id', createdAt: new Date(), updatedAt: new Date(), ...value })),
    save: jest.fn(async (value) => value),
    count: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(createTransfer()),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };
  const manager = {
    query: jest.fn().mockResolvedValue(undefined),
    getRepository: jest.fn(() => transfers),
  };
  const dataSource = { transaction: jest.fn((callback) => callback(manager)) };
  const deviceSessions = {
    getActive: jest.fn(async (_userId: string, deviceId: string) => {
      if (deviceId === 'destination-device') return destinationDevice;
      if (deviceId === 'source-device') return sourceDevice;
      throw new UnauthorizedException('Unknown test device');
    }),
  };
  const permissions = { canDownload: jest.fn().mockResolvedValue(true) };
  const ticketClaims = {
    sub: 'source-user', type: 'peer-transfer', transferId: 'transfer-id', jti: 'transfer-id',
    sourceDeviceId: 'source-device', destinationDeviceId: 'destination-device',
    nodeId: 'node-id', versionId: 'version-id', contentHash: checksum, totalBytes: '17',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
    iss: 'cloudfusion-api', aud: 'cloudfusion-peer-transfer',
  };
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed-short-lived-ticket'),
    verifyAsync: jest.fn().mockResolvedValue(ticketClaims),
  };
  const config = { get: jest.fn((key: string) => key === 'jwt.accessSecret' ? 'test-access-secret' : undefined) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new P2pService(
    devices as never,
    nodes as never,
    versions as never,
    availability as never,
    transfers as never,
    dataSource as never,
    deviceSessions as never,
    permissions as never,
    jwt as never,
    config as never,
    audit as never,
  );
  return { service, devices, nodes, versions, availability, transfers, dataSource, manager, deviceSessions, permissions, jwt, config, audit, queryBuilder, ticketClaims };
}

describe('P2pService transfer coordination', () => {
  it('advertises only an exact readable version for a device that opted in to serving files', async () => {
    const ctx = makeService();
    const result = await ctx.service.advertiseAvailability('source-user', 'source-device', {
      nodeId: 'node-id', versionId: 'version-id', contentHash: checksum, sizeBytes: '17',
    });

    expect(ctx.availability.save).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'source-user', deviceId: 'source-device', nodeId: 'node-id',
      versionId: 'version-id', contentHash: checksum, sizeBytes: '17',
    }));
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not publish availability when the device has not allowed serving local files', async () => {
    const ctx = makeService();
    ctx.deviceSessions.getActive.mockResolvedValue({ ...sourceDevice, serveLocalFiles: false } as never);

    await expect(ctx.service.advertiseAvailability('source-user', 'source-device', {
      nodeId: 'node-id', versionId: 'version-id', contentHash: checksum, sizeBytes: '17',
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.availability.save).not.toHaveBeenCalled();
  });

  it('issues a short-lived ticket bound to both devices and one exact version', async () => {
    const ctx = makeService();
    const result = await ctx.service.authorizeTransfer('destination-user', 'destination-device', {
      sourceDeviceId: 'source-device', nodeId: 'node-id', versionId: 'version-id',
    });

    expect(ctx.jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({
      type: 'peer-transfer', transferId: 'transfer-id', sourceDeviceId: 'source-device',
      destinationDeviceId: 'destination-device', nodeId: 'node-id', versionId: 'version-id',
      contentHash: checksum, totalBytes: '17',
    }), expect.objectContaining({ expiresIn: 120, algorithm: 'HS256' }));
    expect(result.ticket).toBe('signed-short-lived-ticket');
    expect(result.transfer.status).toBe(PeerTransferStatus.AUTHORIZED);
    expect(ctx.audit.record).toHaveBeenCalledWith('destination-user', 'P2P_TRANSFER_AUTHORIZED', 'PeerTransferSession', 'transfer-id', expect.any(Object));
  });

  it('refuses to issue a ticket if either participant loses read permission', async () => {
    const ctx = makeService();
    ctx.permissions.canDownload.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(ctx.service.authorizeTransfer('destination-user', 'destination-device', {
      sourceDeviceId: 'source-device', nodeId: 'node-id', versionId: 'version-id',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.jwt.signAsync).not.toHaveBeenCalled();
  });

  it('refuses to authorize a version not freshly advertised by the source', async () => {
    const ctx = makeService();
    ctx.availability.findOne.mockResolvedValue(null);

    await expect(ctx.service.authorizeTransfer('destination-user', 'destination-device', {
      sourceDeviceId: 'source-device', nodeId: 'node-id', versionId: 'version-id',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(ctx.transfers.save).not.toHaveBeenCalled();
  });

  it('enforces the configured active-transfer limit while holding per-device locks', async () => {
    const ctx = makeService();
    ctx.config.get.mockImplementation((key: string) => {
      if (key === 'jwt.accessSecret') return 'test-access-secret';
      if (key === 'p2p.maxConcurrentTransfers') return 1;
      return undefined;
    });
    ctx.transfers.count.mockResolvedValue(1);

    const error = await ctx.service.authorizeTransfer('destination-user', 'destination-device', {
      sourceDeviceId: 'source-device', nodeId: 'node-id', versionId: 'version-id',
    }).catch((value) => value as HttpException);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(ctx.manager.query).toHaveBeenCalledTimes(2);
    expect(ctx.transfers.create).not.toHaveBeenCalled();
  });

  it('lets only the named source device consume an unexpired, still-authorized ticket once', async () => {
    const ctx = makeService();
    const result = await ctx.service.claimTransfer('source-user', 'source-device', 'transfer-id', 'received-ticket');

    expect(ctx.jwt.verifyAsync).toHaveBeenCalledWith('received-ticket', expect.objectContaining({
      issuer: 'cloudfusion-api', audience: 'cloudfusion-peer-transfer', algorithms: ['HS256'],
    }));
    expect(ctx.queryBuilder.where).toHaveBeenCalledWith(expect.stringContaining('status = :status'), expect.any(Object));
    expect(result.sourcePeerId).toBe(sourceDevice.peerId);
    expect(result.destinationPeerId).toBe(destinationDevice.peerId);
    expect(result.contentHash).toBe(checksum);
  });

  it('rejects a ticket presented by a device other than its named source', async () => {
    const ctx = makeService();

    await expect(ctx.service.claimTransfer('source-user', 'another-device', 'transfer-id', 'received-ticket'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.transfers.findOne).not.toHaveBeenCalled();
  });

  it('rechecks permissions when a peer presents the ticket after a share was revoked', async () => {
    const ctx = makeService();
    ctx.permissions.canDownload.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(ctx.service.claimTransfer('source-user', 'source-device', 'transfer-id', 'received-ticket'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.transfers.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects an expired ticket before consuming its session', async () => {
    const ctx = makeService();
    ctx.ticketClaims.exp = Math.floor(Date.now() / 1000) - 10;

    await expect(ctx.service.claimTransfer('source-user', 'source-device', 'transfer-id', 'expired-ticket'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.transfers.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('prevents the source device from declaring receiver-side hash verification complete', async () => {
    const ctx = makeService();
    ctx.transfers.findOne.mockResolvedValue(createTransfer(PeerTransferStatus.VERIFYING));

    await expect(ctx.service.updateTransferState(
      'source-user', 'source-device', 'transfer-id', PeerTransferStatus.COMPLETED, undefined, '17',
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows only the receiver to advance monotonic byte progress during a transfer', async () => {
    const ctx = makeService();
    const transfer = createTransfer(PeerTransferStatus.TRANSFERRING);
    transfer.bytesTransferred = '8';
    ctx.transfers.findOne.mockResolvedValue(transfer);

    const result = await ctx.service.updateTransferState(
      'destination-user', 'destination-device', 'transfer-id',
      PeerTransferStatus.TRANSFERRING, undefined, '12',
    );

    expect(result.bytesTransferred).toBe('12');
    expect(ctx.transfers.save).toHaveBeenCalledWith(expect.objectContaining({ bytesTransferred: '12' }));
  });

  it('does not allow the source device to report receiver-side byte progress', async () => {
    const ctx = makeService();
    ctx.transfers.findOne.mockResolvedValue(createTransfer(PeerTransferStatus.TRANSFERRING));

    await expect(ctx.service.updateTransferState(
      'source-user', 'source-device', 'transfer-id',
      PeerTransferStatus.TRANSFERRING, undefined, '8',
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.transfers.save).not.toHaveBeenCalled();
  });

  it('rejects transfer progress that moves backwards', async () => {
    const ctx = makeService();
    const transfer = createTransfer(PeerTransferStatus.TRANSFERRING);
    transfer.bytesTransferred = '8';
    ctx.transfers.findOne.mockResolvedValue(transfer);

    await expect(ctx.service.updateTransferState(
      'destination-user', 'destination-device', 'transfer-id',
      PeerTransferStatus.TRANSFERRING, undefined, '7',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.transfers.save).not.toHaveBeenCalled();
  });

  it('does not mark a file complete unless the receiver reports the exact authorized byte count', async () => {
    const ctx = makeService();
    const transfer = createTransfer(PeerTransferStatus.VERIFYING);
    ctx.transfers.findOne.mockResolvedValue(transfer);

    await expect(ctx.service.updateTransferState(
      'destination-user', 'destination-device', 'transfer-id', PeerTransferStatus.COMPLETED, undefined, '16',
    )).rejects.toBeInstanceOf(ConflictException);
    expect(ctx.transfers.save).not.toHaveBeenCalled();
  });
});
