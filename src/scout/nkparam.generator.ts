import { Injectable } from '@nestjs/common';
// node-rsa import quirk: package exports a callable with .default in some TS modes
const NodeRSA: any = require('node-rsa');

/**
 * NkparamGenerator — generates Naukri's request-signature token.
 * Algorithm (verified working 2026-08-25, HTTP 200):
 *   plaintext = "v0|<ms-timestamp>|121_<pageType>"
 *   RSA PKCS1-v1.5 encrypt with Naukri's public key → base64
 */
const NAUKRI_PUBLIC_KEY = [
	'-----BEGIN PUBLIC KEY-----',
	'MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALrlQ+djR0RjJwBF1xuisHmdFv334MIm',
	'K6LgzJhmLhN7B5yuEyaKoasgXQk3+OQglsOaBxEJ0j5PcTL3nbOvt80CAwEAAQ==',
	'-----END PUBLIC KEY-----',
].join('\n');

@Injectable()
export class NkparamGenerator {
	private rsa: any;

	constructor() {
		this.rsa = new NodeRSA(NAUKRI_PUBLIC_KEY);
		this.rsa.setOptions({ encryptionScheme: 'pkcs1' });
	}

	generate(pageType = 'srp'): string {
		const timestamp = Date.now();
		return this.rsa.encrypt(Buffer.from(`v0|${timestamp}|121_${pageType}`), 'base64');
	}
}
