/* Live test of FinnAdapter.login() using the built dist — boots the Nest app
 * for DI services, constructs the adapter the way ApplyEngine does, runs the
 * full OTP flow: authn page → passwordless-start → OTP email (read via IMAP)
 * → passwordless-code → session cookies.
 */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module.js');
const { PortalCredentialService } = require('../dist/applications/portal-credential.service.js');
const { InboxReaderService } = require('../dist/applications/inbox-reader.service.js');
const { FinnAdapter } = require('../dist/scout/finn.adapter.js');

async function main() {
	const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
	const creds = app.get(PortalCredentialService);
	const inbox = app.get(InboxReaderService);
	const adapter = new FinnAdapter(creds, inbox);
	const email = await adapter.loginEmail();
	console.log('finn login email:', email);
	const t0 = Date.now();
	const ok = await adapter.login();
	console.log(`login result: ${ok ? 'SUCCESS' : 'FAILED'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	if (ok) {
		const cookieNames = Object.keys(adapter.session?.cookies ?? {});
		console.log('session cookies:', cookieNames.join(', '));
	}
	await app.close();
	process.exit(ok ? 0 : 1);
}
main().catch((e) => {
	console.error('TEST ERROR:', e);
	process.exit(1);
});
