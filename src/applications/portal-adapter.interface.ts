/**
 * PortalAdapter — every job portal plugs in through this interface.
 * Adding a new portal later = one new file implementing this, registered
 * in the ApplyEngine registry. No core changes needed.
 */
export interface ScrapedLead {
	source: string;
	externalId: string;
	title: string;
	company: string;
	location?: string | null;
	description?: string | null;
	url?: string | null;
}

export interface PortalQuestion {
	question: string;
	/** answer resolved from the answer bank, or null if unknown → needs_info */
	answer: string | null;
}

export interface ApplyResult {
	ok: boolean;
	status: 'submitted' | 'needs_info' | 'failed' | 'sandboxed';
	questions?: PortalQuestion[];
	missingInfo?: string[];
	errorDetail?: string;
}

export interface PortalAdapter {
	/** source name used in DB rows and settings toggles */
	readonly source: string;
	/** human label for dashboard */
	readonly label: string;

	/** Fetch current matching leads (public API or scraping). */
	scrape(): Promise<ScrapedLead[]>;

	/**
	 * Attempt to apply to one lead.
	 * profileData: flattened candidate profile fields.
	 * answers: question→answer map from the answer bank.
	 */
	apply(
		lead: ScrapedLead,
		profileData: Record<string, string>,
		answers: Record<string, string>,
	): Promise<ApplyResult>;
}
