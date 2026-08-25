import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SideIncomeOpportunity } from './side-income-opportunity.entity';

/**
 * SideIncomeService — seeds and serves researched side-income opportunities
 * matched to the user's constraints: minimum involvement, zero-to-minimal
 * investment, property available at 11 Pound Road, Khagra, Berhampore,
 * Murshidabad, WB 742103 (space can host a hub/sorting point).
 */
const USER_PROFILE = {
	location: 'Khagra, Berhampore, Murshidabad, WB 742103',
	hasSpareSpace: true, // "huge places in my residence"
	maxInvestmentLow: 50000,
};

type Seed = Omit<SideIncomeOpportunity, 'id' | 'createdAt' | 'updatedAt'>;

const SEEDS: Seed[] = [
	{
		provider: 'Valmo (Meesho)',
		title: 'Valmo Last-Mile Delivery Partner (Berhampore)',
		model: 'individual',
		description:
			'Meesho\'s in-house logistics network (launched Feb 2024, 763M orders FY25) recruits local last-mile delivery partners per pin code. Berhampore/Murshidabad e-commerce volume is growing; partner delivers Meesho parcels in assigned local pin codes. Asset-light: bike + smartphone + small sorting corner is enough to start.',
		investmentRange: '₹50,000–₹1.5 lakh',
		expectedIncome: 'per-parcel payout; net margins ~15-25% scaling with order density',
		costBreakdownJson: JSON.stringify([
			{ item: 'Refundable security deposit', cost: '₹20k-50k' },
			{ item: 'Small sorting space (can use spare room at 11 Pound Rd)', cost: '₹0 (own premises)' },
			{ item: 'Bike (if not owned) + fuel working capital', cost: '₹30k-80k' },
		]),
		requirementsJson: JSON.stringify([
			'Age 21+', '12th pass minimum', 'Bike + smartphone',
			'Small sorting space (your residence qualifies)', 'Ability to manage 1-2 riders as volume grows',
		]),
		documentsJson: JSON.stringify(['Aadhaar', 'PAN', 'GST certificate', 'Active bank account', 'Premises proof']),
		howToApply:
			'1. Visit valmo.in → "Become a Partner". 2. Fill name, contact, pin code 742103, city, state. 3. Valmo team verifies the area and contacts you for onboarding. 4. KYC upload → training → go live in assigned pin codes.',
		applyUrl: 'https://www.valmo.in/',
		warningsJson: JSON.stringify([
			'Valmo NEVER charges application/onboarding fees — anyone asking for money is a scam (report: investigations@meesho.com)',
			'Only official emails end in @valmo.in or @meesho.com',
			'Income depends on Meesho order density in your pin codes — check local order volume first',
		]),
		involvement: 'medium',
		fitScore: 85,
		status: 'researched',
	},
	{
		provider: 'Delhivery',
		title: 'Delhivery Courier Booking Counter / Delivery Center',
		model: 'store',
		description:
			'Two franchise types: (a) courier booking counter — collect parcels from walk-in customers at a Delhivery store, earn on bookings plus packaging/insurance add-ons; (b) parcel delivery center — earn per delivery, needs min 200 sqft floor space + delivery rider(s). Your residence space covers (b)\u2019s storage requirement.',
		investmentRange: '₹50,000–₹2 lakh (counter); ₹1.5–5 lakh (delivery center)',
		expectedIncome: 'per-booking / per-delivery commissions plus packaging & insurance margin',
		costBreakdownJson: JSON.stringify([
			{ item: 'Franchise setup (officially low/affordable per Delhivery)', cost: '₹50k+ varies' },
			{ item: 'Space 200+ sqft', cost: '₹0 (own premises)' },
			{ item: 'Rider salary if delivery center', cost: '₹8k-12k/month per rider' },
		]),
		requirementsJson: JSON.stringify([
			'Min 200 sqft floor space for shipments', 'Delivery rider staff (delivery-center model)',
			'Counter model: shopfront presence in town',
		]),
		documentsJson: JSON.stringify(['ID proof', 'Address proof', 'PAN', 'Bank details', 'Premises photos']),
		howToApply: 'Visit delhivery.com/partner/courier-sales-franchise → choose counter or delivery center → sign up form → area verification by Delhivery team.',
		applyUrl: 'https://www.delhivery.com/partner/courier-sales-franchise',
		warningsJson: JSON.stringify(['Apply only on delhivery.com — avoid third-party "franchise consultants" charging fees']),
		involvement: 'medium',
		fitScore: 75,
		status: 'researched',
	},
	{
		provider: 'Amazon',
		title: 'Amazon I Have Space (IHS) Local Partner',
		model: 'store',
		description:
			'Amazon\'s lowest-involvement local program: your shop/premises becomes a neighborhood pickup-and-drop point for Amazon parcels. Amazon routes nearby customer deliveries/returns through you and pays per-parcel handling. Kirana-style partners earn steady passive per-parcel income with no fleet or staff needed. Best fit for "minimum involvement" requirement.',
		investmentRange: 'near zero (space + signage only)',
		expectedIncome: 'per-parcel handling fee; steady side income scaled to neighborhood volume',
		costBreakdownJson: JSON.stringify([
			{ item: 'Space allocation (corner of residence/garage)', cost: '₹0' },
			{ item: 'Basic racks/shelving', cost: '₹5k-15k' },
		]),
		requirementsJson: JSON.stringify([
			'Accessible ground-floor storage space', 'Long opening hours or reliable handover routine',
			'Local footfall/access for customers',
		]),
		documentsJson: JSON.stringify(['Aadhaar', 'PAN', 'Bank account', 'Property proof/electricity bill']),
		howToApply:
			'Amazon IHS partners are recruited locally — apply interest via aboutamazon.in / Amazon India local programs contact, or ask at the nearest Amazon delivery station (Berhampore). No public web form in all regions; station-level onboarding is common in district towns.',
		applyUrl: 'https://www.aboutamazon.in/news/small-business/amazon-enabled-1-lakh-local-shops-kiranas-and-neighbourhood-stores-geared-up-for-this-festive-season',
		warningsJson: JSON.stringify(['No fees ever — Amazon pays YOU', 'Confirm the parcel-volume commitment before signing']),
		involvement: 'low',
		fitScore: 88,
		status: 'researched',
	},
	{
		provider: 'Amazon',
		title: 'Amazon Easy Store (assisted e-commerce point)',
		model: 'store',
		description:
			'Amazon recruits local shopkeepers/property owners as assisted online-shopping points: help neighbors browse, order and pay (including COD) on Amazon; earn commissions on orders facilitated plus footfall-driven sales. Requires 200+ sqft and computer proficiency — you have both. Berhampore is an eligible tier-3 expansion town.',
		investmentRange: 'low — mainly tablet/setup (~₹25k-50k)',
		expectedIncome: 'commission per facilitated order + services (bill payment etc.)',
		costBreakdownJson: JSON.stringify([
			{ item: 'Tablet/computer + internet', cost: '₹15k-30k' },
			{ item: 'Signage & basic fitout of 200 sqft corner', cost: '₹10k-20k' },
		]),
		requirementsJson: JSON.stringify([
			'18-45 yrs, 10+2 qualified', '200 sqft+ space', 'Computer proficient', 'Willingness to do local marketing',
		]),
		documentsJson: JSON.stringify(['Aadhaar', 'PAN', 'Voter ID', 'Bank statements', 'Property docs', 'Electricity bill', 'GST (if applicable)']),
		howToApply: 'Register through Amazon Easy official channel (amazon.in "Amazon Easy" program page / local Amazon network partner); document verification → approval → launch.',
		applyUrl: 'https://www.amazon.in/',
		warningsJson: JSON.stringify(['Program rollout varies by district — confirm availability for Murshidabad before investing in fitout']),
		involvement: 'medium',
		fitScore: 70,
		status: 'researched',
	},
	{
		provider: 'CSC (Digital India)',
		title: 'Common Service Centre (CSC) VLE — digital services point',
		model: 'digital',
		description:
			'Become a Village Level Entrepreneur under Digital India: offer Aadhaar services, PAN card processing, insurance, bill payments, government certificate applications from your premises. Zero stock, pure service commissions. Fully matches "zero investment, minimal involvement" once set up; runs on your existing computer skills.',
		investmentRange: '₹10k-25k (biometric device + registration)',
		expectedIncome: '₹15,000-₹30,000/month in service fees (govt estimate for active VLEs)',
		costBreakdownJson: JSON.stringify([
			{ item: 'Biometric/IRIS device', cost: '₹4k-8k' },
			{ item: 'Webcam + printer (likely already owned)', cost: '₹0-6k' },
			{ item: 'Registration', cost: 'free at register.csc.gov.in' },
		]),
		requirementsJson: JSON.stringify([
			'Aadhaar-linked mobile', 'Basic computer (you have expert level)', 'Ground-floor accessible room for walk-ins',
			'Pan-card NSDL/UTI registration optional add-on',
		]),
		documentsJson: JSON.stringify(['Aadhaar', 'PAN', 'Bank account', 'Passport photo', 'Location geotag during registration']),
		howToApply: 'Register at register.csc.gov.in → choose VLE → telecentre.org TEA exam (basic digital literacy) → get CSC ID → activate services (Aadhaar requires separate UIDAI certification).',
		applyUrl: 'https://register.csc.gov.in',
		warningsJson: JSON.stringify([
			'Registration is FREE — never pay agents for "CSC franchise"',
			'Aadhaar operator status needs UIDAI exam/certification (done at local CSC academy)',
		]),
		involvement: 'low',
		fitScore: 92,
		status: 'researched',
	},
];

@Injectable()
export class SideIncomeService implements OnModuleInit {
	private readonly logger = new Logger(SideIncomeService.name);

	constructor(
		@InjectRepository(SideIncomeOpportunity)
		private readonly repo: Repository<SideIncomeOpportunity>,
	) {}

	/** Seed researched opportunities once (idempotent by provider+title). */
	async onModuleInit(): Promise<void> {
		const existing = await this.repo.count();
		if (existing > 0) return;
		for (const seed of SEEDS) {
			await this.repo.save(this.repo.create(seed));
		}
		this.logger.log(`seeded ${SEEDS.length} side-income opportunities`);
	}

	async list(): Promise<SideIncomeOpportunity[]> {
		return this.repo.find({ order: { fitScore: 'DESC' } });
	}

	async detail(id: string): Promise<SideIncomeOpportunity | null> {
		return this.repo.findOne({ where: { id } });
	}

	/** Parse the stored JSON fields into a dashboard-friendly object. */
	toDashboard(o: SideIncomeOpportunity) {
		const j = (s: string | null) => (s ? JSON.parse(s) : []);
		return {
			id: o.id,
			provider: o.provider,
			title: o.title,
			model: o.model,
			description: o.description,
			investmentRange: o.investmentRange,
			expectedIncome: o.expectedIncome,
			costBreakdown: j(o.costBreakdownJson),
			requirements: j(o.requirementsJson),
			documents: j(o.documentsJson),
			howToApply: o.howToApply,
			applyUrl: o.applyUrl,
			warnings: j(o.warningsJson),
			involvement: o.involvement,
			fitScore: o.fitScore,
			status: o.status,
		};
	}

	/** Mark that the user has started applying to one (with provided info). */
	async markStatus(id: string, status: string): Promise<void> {
		await this.repo.update(id, { status });
	}
}
