import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataProtectionException } from './data-protection-error';
import { EncryptionService } from './encryption.service';
import { KeyManagementService } from './key-management.service';

describe('EncryptionService', () => {
  let directory: string;
  const masterKey = Buffer.alloc(32, 7).toString('base64');

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cloudfusion-encryption-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function service(key = masterKey, version = 1, ring?: string): EncryptionService {
    const config = {
      get: (name: string) => ({
        'dataProtection.masterKey': key,
        'dataProtection.keyVersion': version,
        'dataProtection.masterKeysJson': ring,
      })[name],
    };
    return new EncryptionService(new KeyManagementService(config as never));
  }

  async function encryptedFixture(input = 'CloudFusion keeps files private') {
    const inputPath = join(directory, 'plain.bin');
    const encryptedPath = join(directory, 'encrypted.bin');
    await writeFile(inputPath, input);
    const encrypted = await service().encryptFile(inputPath, encryptedPath, 'object-1');
    return { inputPath, encryptedPath, encrypted };
  }

  it('encrypts and decrypts a file while keeping plaintext out of the replica file', async () => {
    const { inputPath, encryptedPath, encrypted } = await encryptedFixture();
    const original = await readFile(inputPath);
    const ciphertext = await readFile(encryptedPath);
    const outputPath = join(directory, 'restored.bin');

    await service().decryptFile(require('node:fs').createReadStream(encryptedPath), outputPath, 'object-1', encrypted);

    expect(ciphertext.equals(original)).toBe(false);
    expect(await readFile(outputPath)).toEqual(original);
    expect(encrypted.encryptionAlgorithm).toBe('AES-256-GCM');
    expect(encrypted.encryptedDek).not.toContain(original.toString());
  });

  it('generates a different random DEK for every object', async () => {
    const first = await encryptedFixture('same payload');
    const secondInput = join(directory, 'second.bin');
    const secondCiphertext = join(directory, 'second-encrypted.bin');
    await writeFile(secondInput, 'same payload');
    const second = await service().encryptFile(secondInput, secondCiphertext, 'object-2');

    expect(first.encrypted.encryptedDek).not.toBe(second.encryptedDek);
  });

  it('rejects a modified GCM authentication tag', async () => {
    const { encryptedPath, encrypted } = await encryptedFixture();
    const outputPath = join(directory, 'tampered.bin');
    const corrupted = { ...encrypted, contentAuthTag: Buffer.alloc(16).toString('base64') };

    await expect(service().decryptFile(require('node:fs').createReadStream(encryptedPath), outputPath, 'object-1', corrupted))
      .rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
  });

  it('rejects decryption with a different master key', async () => {
    const { encryptedPath, encrypted } = await encryptedFixture();
    const outputPath = join(directory, 'wrong-key.bin');
    const otherKey = Buffer.alloc(32, 9).toString('base64');

    await expect(service(otherKey).decryptFile(require('node:fs').createReadStream(encryptedPath), outputPath, 'object-1', encrypted))
      .rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
  });

  it('reports unknown key versions without exposing key material', async () => {
    const { encryptedPath, encrypted } = await encryptedFixture();
    const outputPath = join(directory, 'unknown-key.bin');

    await expect(service().decryptFile(
      require('node:fs').createReadStream(encryptedPath),
      outputPath,
      'object-1',
      { ...encrypted, keyVersion: 42 },
    )).rejects.toBeInstanceOf(DataProtectionException);
    await expect(service().decryptFile(
      require('node:fs').createReadStream(encryptedPath),
      outputPath,
      'object-1',
      { ...encrypted, keyVersion: 42 },
    )).rejects.toMatchObject({ code: 'KEY_VERSION_UNKNOWN' });
  });

  it('supports rewrapping a DEK with a new KEK while keeping ciphertext intact', async () => {
    const { encryptedPath, encrypted } = await encryptedFixture();
    const oldKey = masterKey;
    const newKey = Buffer.alloc(32, 11).toString('base64');
    const keyring = JSON.stringify({ '1': oldKey, '2': newKey });
    const rotatingService = service(newKey, 2, keyring);
    const keys = new KeyManagementService({
      get: (name: string) => ({
        'dataProtection.masterKey': newKey,
        'dataProtection.keyVersion': 2,
        'dataProtection.masterKeysJson': keyring,
      })[name],
    } as never);
    const rewrapped = keys.rewrapDataKey(encrypted, 'object-1');
    const outputPath = join(directory, 'rotated-restored.bin');

    await rotatingService.decryptFile(
      require('node:fs').createReadStream(encryptedPath),
      outputPath,
      'object-1',
      { ...encrypted, ...rewrapped },
    );

    expect(rewrapped.keyVersion).toBe(2);
    expect(rewrapped.encryptedDek).not.toBe(encrypted.encryptedDek);
    expect(await readFile(outputPath)).toEqual(await readFile(join(directory, 'plain.bin')));
  });
});
