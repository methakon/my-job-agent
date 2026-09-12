/**
 * Shared IMAP safety helpers — queue item 76 ("IMAP Credential Storage Fix &
 * Exponential Backoff").
 *
 * Two real defects are closed here, both observed in production on 2026-09-12:
 *
 * 1. CRASH: `imapflow` emits `'error'` ASYNCHRONOUSLY (e.g. "Socket timeout" when a
 *    TLS socket stalls). A client created without an `'error'` listener makes Node
 *    re-throw it as an unhandled error event and EXIT THE PROCESS. `try/catch` around
 *    `connect()`/`fetch()` cannot catch it — it is an emitter event, not a rejected
 *    promise. This killed the whole service 62 times between 2026-09-07 and
 *    2026-09-12 (`Error: Socket timeout ... throw er; // Unhandled 'error' event`),
 *    taking the trading desks' HTTP routes and the project-status control plane down
 *    with it each time. Evidence that the failure path was unreachable: every
 *    `mail_accounts` row still had `imapFailureCount = 0` and `lastImapSuccess = NULL`
 *    — the process died before any failure handler could record anything.
 *
 * 2. POLICY: the backoff / auto-disable rule was implemented only inside
 *    `InboxReaderService`, so `EmailTrackerService` re-polled failing mailboxes every
 *    30 minutes with no backoff and no way to stop — re-triggering (1) forever.
 *
 * One implementation, used by both services.
 */
import { ImapFlow } from 'imapflow';

/** Consecutive failures after which an account stops being polled automatically. */
export const IMAP_AUTO_DISABLE_AFTER = 5;

/** Backoff for n consecutive failures: 2^(n-1) hours (1, 2, 4, 8, 16, ...). */
export function imapBackoffHours(failureCount: number): number {
	return Math.pow(2, Math.max(failureCount, 1) - 1);
}

export interface ImapAccountState {
	useImap?: boolean | number | null;
	imapFailureCount?: number | null;
	lastImapSuccess?: Date | string | null;
}

/**
 * Why this account must NOT be polled right now, or null when it may connect.
 * `useImap === false` is the only hard disable. The backoff window is measured from
 * the last SUCCESS, so an account that has never succeeded has no window to sit in
 * and is still probed — that is deliberate: it is bounded by the auto-disable rule
 * (IMAP_AUTO_DISABLE_AFTER consecutive failures stop it for good and hand it back to
 * the operator), instead of being skipped forever on a failure it can never clear.
 */
export function imapSkipReason(account: ImapAccountState, now: number = Date.now()): string | null {
	if (account.useImap === false) return 'IMAP disabled for this account';
	const failures = account.imapFailureCount ?? 0;
	if (failures <= 0) return null;
	const waitHours = imapBackoffHours(failures);
	const lastSuccess = account.lastImapSuccess ? new Date(account.lastImapSuccess).getTime() : null;
	const hoursSinceSuccess = lastSuccess === null
		? Number.POSITIVE_INFINITY
		: (now - lastSuccess) / 3_600_000;
	if (hoursSinceSuccess < waitHours) {
		return `IMAP backoff: ${failures} consecutive failure(s), wait ${waitHours}h after last success`;
	}
	return null;
}

export interface ImapErrorTrap {
	/** The most recent asynchronous socket/protocol error, or null. */
	lastError(): Error | null;
}

/**
 * Attach the mandatory `'error'` listener BEFORE `connect()` is called.
 * Returns a trap so the caller's catch block can report the real socket cause.
 */
export function guardImapClient(
	client: Pick<ImapFlow, 'on'>,
	onError?: (err: Error) => void,
): ImapErrorTrap {
	let last: Error | null = null;
	client.on('error', (err: unknown) => {
		last = err instanceof Error ? err : new Error(String(err));
		if (onError) onError(last);
	});
	return { lastError: () => last };
}

/** Create a client that can never kill the process on an async socket error. */
export function createGuardedImapClient(
	options: ConstructorParameters<typeof ImapFlow>[0],
	onError?: (err: Error) => void,
): { client: ImapFlow; trap: ImapErrorTrap } {
	const client = new ImapFlow(options);
	return { client, trap: guardImapClient(client, onError) };
}

export interface MailAccountRepoLike {
	update(id: unknown, patch: Record<string, unknown>): Promise<unknown>;
}

export interface ImapOutcomeOptions {
	/** When false the account is never auto-disabled (counting only). */
	allowAutoDisable?: boolean;
	onAutoDisable?: (email: string) => void;
}

/**
 * Record one poll outcome against the shared counter.
 * Success clears the counter and stamps `lastImapSuccess` (which the backoff window
 * is measured from). Failure increments it, and — when `allowAutoDisable` is not
 * false — flips `useImap` off at IMAP_AUTO_DISABLE_AFTER.
 */
export async function recordImapOutcome(
	repo: MailAccountRepoLike,
	account: { id: unknown; email: string; imapFailureCount?: number | null },
	success: boolean,
	options: ImapOutcomeOptions = {},
): Promise<{ failureCount: number; autoDisabled: boolean }> {
	if (success) {
		await repo.update(account.id, { lastImapSuccess: new Date(), imapFailureCount: 0 });
		return { failureCount: 0, autoDisabled: false };
	}
	const failureCount = (account.imapFailureCount ?? 0) + 1;
	await repo.update(account.id, { imapFailureCount: failureCount });
	if (options.allowAutoDisable === false || failureCount < IMAP_AUTO_DISABLE_AFTER) {
		return { failureCount, autoDisabled: false };
	}
	await repo.update(account.id, { useImap: false });
	if (options.onAutoDisable) options.onAutoDisable(account.email);
	return { failureCount, autoDisabled: true };
}
