import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/** AES-256-CBC encryption helper keyed on ENCRYPTION_KEY (same scheme as
 *  PortalCredentialService/APP_SECRET, so credentials stored before/after
 *  share one convention). Format: `ivHex:cipherHex`. */
@Injectable()
export class EncryptionService {
	constructor(private readonly config: ConfigService) {}

	private key(): Buffer {
		// SHA-256 of the configured secret → 32-byte AES-256 key.
		return crypto.createHash('sha256').update(this.config.get<string>('ENCRYPTION_KEY') ?? '').digest();
	}

	/** Encrypt a UTF-8 string. Returns `iv:cipher` hex. Empty input → empty output. */
	encrypt(plain: string): string {
		if (!plain) return '';
		const iv = crypto.randomBytes(16);
		const c = crypto.createCipheriv('aes-256-cbc', this.key(), iv);
		return `${iv.toString('hex')}:${Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex')}`;
	}

	/** Decrypt `iv:cipher` hex back to UTF-8. Returns '' on empty/garbage input. */
	decrypt(enc: string | null | undefined): string {
		if (!enc) return '';
		try {
			const [ivHex, dataHex] = enc.split(':');
			if (!ivHex || !dataHex) return '';
			const d = crypto.createDecipheriv('aes-256-cbc', this.key(), Buffer.from(ivHex, 'hex'));
			return Buffer.concat([d.update(Buffer.from(dataHex, 'hex')), d.final()]).toString('utf8');
		} catch {
			return '';
		}
	}
}
