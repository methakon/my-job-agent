import { Injectable, Logger } from '@nestjs/common';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import { isSubmissionBlocked } from './sandbox-safety';

export interface FormFillPlan {
	url: string;
	/** profile-derived field values keyed by normalized field name */
	values: Record<string, string>;
	/** path of tailored CV PDF to upload into file inputs */
	cvPath?: string;
	/** submit without confirmation? default false (safety) */
	autoSubmit?: boolean;
}

export interface BrowserApplyResult {
	ok: boolean;
	status: 'filled' | 'submitted' | 'needs_info' | 'failed';
	filledFields: string[];
	unansweredQuestions: string[];
	screenshots: string[];
	errorDetail?: string;
}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOT_DIR = path.join(process.cwd(), 'generated', 'browser');

/**
 * BrowserFormService (FR-15) — drives a real headless Chromium via
 * playwright-core (system Chrome, no bundled download). Fills ATS portal
 * forms from profile data; stops before final submit unless explicitly
 * allowed. Screenshots every step to generated/browser/ for audit.
 *
 * JA-002: the autoSubmit path is guarded — when SANDBOX=true or
 * APPLY_KILL_SWITCH=true, the submit click is never performed, even if the
 * caller set autoSubmit=true. Fill-only behaviour is unaffected.
 */
@Injectable()
export class BrowserFormService {
	private readonly logger = new Logger(BrowserFormService.name);

	private async shot(page: Page, name: string): Promise<string> {
		fs.mkdirSync(SHOT_DIR, { recursive: true });
		const file = path.join(SHOT_DIR, `${Date.now()}-${name}.png`);
		await page.screenshot({ path: file, fullPage: true });
		return file;
	}

	async fillAndSubmit(plan: FormFillPlan): Promise<BrowserApplyResult> {
		const result: BrowserApplyResult = {
			ok: false,
			status: 'failed',
			filledFields: [],
			unansweredQuestions: [],
			screenshots: [],
		};
		let browser: Browser | null = null;
		try {
			browser = await chromium.launch({
				executablePath: CHROME_PATH,
				headless: true,
				// stealth flags: SmartRecruiters et al. run a device-verification
				// interstitial that stalls default headless Chrome (2026-08-27).
				args: [
					'--no-sandbox',
					'--disable-dev-shm-usage',
					'--disable-blink-features=AutomationControlled',
				],
			});
			const ctx: BrowserContext = await browser.newContext({
				viewport: { width: 1280, height: 900 },
				userAgent:
					'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
			});
			await ctx.addInitScript(() => {
				Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
			});
			const page: Page = await ctx.newPage();

			await page.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
			// let SPA boot + render the initial view
			await page.waitForTimeout(2_000);
			result.screenshots.push(await this.shot(page, 'loaded'));

			// ATS pages often hide the form behind a CTA ("I'm interested" / "Apply now").
			// Click the first visible apply-ish button; SmartRecruiters navigates to a
			// oneclick-ui URL and may pass a device-verification interstitial first.
			const ctaClicked = await page
				.locator(
					'button:has-text("I\'m interested"), button:has-text("Apply now"), button:has-text("Apply for this job"), button:has-text("Apply"), a:has-text("Apply now"), a:has-text("Apply for this job"), a:has-text("I\'m interested")',
				)
				.first()
				.click({ timeout: 5_000 })
				.then(() => true)
				.catch(() => false);
			if (ctaClicked) {
				this.logger.log(`browser form ${plan.url}: clicked apply CTA`);
				// wait for the application view to mount (URL may change, verification may pass)
				try {
					await page.waitForURL(/oneclick-ui|apply|application/i, { timeout: 20_000 });
				} catch {
					/* not all ATS navigate */
				}
				await page
					.locator('input:not([type=hidden]), textarea, select')
					.first()
					.waitFor({ state: 'visible', timeout: 20_000 })
					.catch(() =>
						this.logger.warn(`browser form ${plan.url}: no form fields appeared after CTA`),
					);
				result.screenshots.push(await this.shot(page, 'apply-clicked'));
			}

			// collect visible form fields (text/email/tel/url/textarea/select + file).
			// locator() pierces shadow DOM (SmartRecruiters oneclick-ui renders its
			// form in shadow roots — $$eval never sees them, 2026-08-27).
			const fieldEls = page.locator(
				'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select',
			);
			const fieldCount = await fieldEls.count();
			const fields: Array<{
				index: number;
				tag: string;
				type: string | null;
				name: string | null;
				id: string | null;
				placeholder: string | null;
				label: string | null;
				aria: string | null;
				required: boolean;
			}> = [];
			for (let i = 0; i < fieldCount; i++) {
				const el = fieldEls.nth(i);
				const visible = await el.isVisible().catch(() => false);
				if (!visible) continue;
				fields.push(
					await el
						.evaluate((e) => ({
							tag: e.tagName.toLowerCase(),
							type: (e as HTMLInputElement).type || null,
							name: (e as HTMLInputElement).name || null,
							id: e.id || null,
							placeholder: (e as HTMLInputElement).placeholder || null,
							label:
								e.id &&
								document.querySelector(`label[for="${e.id}"]`)
									? (document.querySelector(`label[for="${e.id}"]`) as HTMLElement).innerText.trim()
									: null,
							aria: e.getAttribute('aria-label'),
							required: (e as HTMLInputElement).required || e.hasAttribute('aria-required'),
						}))
						.then((info) => ({ index: i, ...info })),
				);
			}

			const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
			const valueFor = (f: (typeof fields)[number]): string | null => {
				const keys = [
					norm(f.label),
					norm(f.name),
					norm(f.id),
					norm(f.placeholder),
					norm(f.aria),
				].filter(Boolean);
				for (const key of keys) {
					for (const [vk, vv] of Object.entries(plan.values)) {
						if (key.includes(norm(vk)) || norm(vk).includes(key)) return vv;
					}
				}
				return null;
			};

			let filledCount = 0;
			for (const f of fields) {
				if (f.type === 'file') continue; // handled below
				const val = valueFor(f);
				if (!val) {
					if (f.required)
						result.unansweredQuestions.push(f.label ?? f.name ?? f.id ?? 'unknown required field');
					continue;
				}
				const el = fieldEls.nth(f.index);
				try {
					if (f.tag === 'select') {
						await el.selectOption({ label: val }).catch(async () => el.selectOption({ value: val }));
					} else {
						await el.fill(val);
					}
					result.filledFields.push(f.label ?? f.name ?? f.id ?? 'field');
					filledCount++;
				} catch {
					this.logger.warn(`could not fill field ${f.label ?? f.name ?? f.id ?? f.index}`);
				}
			}

			// CV upload for any visible file input (locator pierces shadow DOM)
			if (plan.cvPath && fs.existsSync(plan.cvPath)) {
				const fileInputs = page.locator('input[type=file]');
				const n = await fileInputs.count();
				for (let i = 0; i < n; i++) {
					await fileInputs.nth(i).setInputFiles(plan.cvPath).catch((e) =>
						this.logger.warn(`cv upload failed: ${e}`),
					);
				}
			}
			result.screenshots.push(await this.shot(page, 'filled'));

			if (result.unansweredQuestions.length > 0) {
				result.status = 'needs_info';
			} else if (plan.autoSubmit) {
				// JA-002: block the real browser submit independently — even when the
				// caller set autoSubmit=true, the guard must be honored.
				if (isSubmissionBlocked()) {
					result.status = 'filled';
					result.errorDetail = 'submission-blocked-sandbox-or-kill-switch';
					this.logger.warn(`browser form ${plan.url}: submit blocked by sandbox/kill-switch`);
				} else {
					await page
						.locator(
							'button[type=submit], input[type=submit], button:has-text("Submit"), button:has-text("Apply")',
						)
						.first()
						.click();
					await page.waitForLoadState('domcontentloaded');
					result.screenshots.push(await this.shot(page, 'submitted'));
					result.status = 'submitted';
				}
			} else {
				// safety default: leave filled for human review
				result.status = 'filled';
			}
			result.ok = true;
			this.logger.log(
				`browser form ${plan.url}: ${filledCount} filled, status=${result.status}, ${result.unansweredQuestions.length} unanswered`,
			);
		} catch (err) {
			result.errorDetail = String(err).slice(0, 500);
			this.logger.warn(`browser apply failed: ${result.errorDetail}`);
		} finally {
			await browser?.close();
		}
		return result;
	}
}
