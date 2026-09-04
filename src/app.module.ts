import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { mysqlConfig } from './shared/db.config';
import { CandidateProfile } from './profile/candidate-profile.entity';
import { JobLead } from './leads/job-lead.entity';
import { Application } from './applications/application.entity';
import { LearningWeight } from './applications/learning-weight.entity';
import { QuestionAnswer } from './applications/question-answer.entity';
import { ApplySetting } from './applications/apply-setting.entity';
import { MailAccount } from './applications/mail-account.entity';
import { StatusUpdate } from './applications/status-update.entity';
import { EmailTrackerService } from './applications/email-tracker.service';
import { DirectChannelDetector } from './applications/direct-channel.detector';
import { DirectApplyMailer } from './applications/direct-apply.mailer';
import { MailService } from './applications/mail.service';
import { HumanEmailComposer } from './applications/human-email-composer.service';
import { AtsCvBuilder } from './applications/ats-cv-builder.service';
import { ProcessLearningService } from './applications/process-learning.service';
import { ProfileOptimizer } from './profile/profile-optimizer.service';
import { InterviewQuestion } from './interview/interview-question.entity';
import { InterviewPrepService } from './interview/interview-prep.service';
import { AstroMuhurtaService } from './astro/astro-muhurta.service';
import { AstroLeadScoringService } from './astro/astro-lead-scoring.service';
import { PreApplyItem } from './astro/pre-apply-item.entity';
import { PreApplyItemRepository } from './astro/pre-apply-item.repository';
import { PreApplyService } from './astro/pre-apply.service';
import { MuhurtaSendService } from './astro/muhurta-send.service';
import { AstroController } from './astro/astro.controller';
import { MuhurtaWindow } from './astro/muhurta-window.entity';
import { FnfPortfolio } from './trading/fnf-portfolio.entity';
import { FnfTrade } from './trading/fnf-trade.entity';
import { FnfMarketSnapshot } from './trading/fnf-market-snapshot.entity';
import { FnfDecayCalibration } from './trading/fnf-decay-calibration.entity';
import { FnfTradingService } from './trading/fnf-trading.service';
import { FnfTradingController } from './trading/fnf-trading.controller';
import { FnfTradingPageController } from './trading/fnf-trading-page.controller';
import { OptionTradingPageController } from './trading/option-trading-page.controller';
import { FnoMarketDataService } from './trading/fno-market-data.service';
import { FnoMarketDataController } from './trading/fno-market-data.controller';
import { MarketDataInspectionController } from './trading/market-data-inspection.controller';
import { MarketDataPageController } from './trading/market-data-page.controller';
import { MarketDataInspectionService } from './trading/market-data-inspection.service';
import { FnfOptionContract } from './trading/fnf-option-contract.entity';
import { FnfOptionQuote } from './trading/fnf-option-quote.entity';
import { FnfMarketSnapshotHistory } from './trading/fnf-market-snapshot-history.entity';
import { FnfOptionQuoteHistory } from './trading/fnf-option-quote-history.entity';
import { FnfTradeReflection } from './trading/fnf-trade-reflection.entity';
import { FnfDecisionJournal } from './trading/fnf-decision-journal.entity';
import { FnfOptionChainService } from './trading/fnf-option-chain.service';
import { FnfOptionChainController } from './trading/fnf-option-chain.controller';
import { ProjectChecklistItem } from './project-status/project-checklist-item.entity';
import { ProjectStatusService } from './project-status/project-status.service';
import { ProjectStatusPageController } from './project-status/project-status-page.controller';
import { InterviewPrepController } from './interview/interview-prep.controller';
import { InterviewPracticePageController } from './interview/interview-practice-page.controller';
import { MailController } from './applications/mail.controller';
import { InboxReaderService } from './applications/inbox-reader.service';
import { InboxController } from './applications/inbox.controller';
import { PortalCredentialService } from './applications/portal-credential.service';
import { PortalCredentialController } from './applications/portal-credential.controller';
import { HrEmailInvestigator } from './applications/hr-email-investigator.service';
import { AutoApplyLoopService } from './applications/auto-apply-loop.service';
import { AutoApplyController } from './applications/auto-apply.controller';
import { RetryBackoffService } from './applications/retry-backoff.service';
import { BrowserFormService } from './applications/browser-form.service';
import { BrowserFormController } from './applications/browser-form.controller';
import { LearningController } from './applications/learning.controller';
import { ApplicationsPageController } from './applications/applications-page.controller';
import { FailedApplicationsPageController } from './applications/failed-applications-page.controller';
import { PreApplyPageController } from './applications/pre-apply-page.controller';
import { LinkedInController } from './applications/linkedin.controller';
import { SandboxController } from './applications/sandbox.controller';
import { VisaGuidePageController } from './applications/visa-guide-page.controller';
import { LearningWeightsService } from './applications/learning-weights.service';
import { DailyDigestService } from './applications/daily-digest.service';
import { LinkedInProfileService } from './applications/linkedin-profile.service';
import { SideIncomeModule } from './side-income/side-income.module';
import { AuthModule } from './auth/auth.module';
import { AuthController } from './auth/auth.controller';
import { AppFallbackController } from './app-fallback.controller';
import { NaukriAdapter } from './scout/naukri.adapter';
import { ProfileController } from './profile/profile.controller';
import { ProfileService } from './profile/profile.service';
import { ProfileRepository } from './profile/profile.repository';
import { LeadController } from './scout/lead.controller';
import { ScoutService } from './scout/scout.service';
import { LeadRepository } from './leads/lead.repository';
import { ApplicationController } from './applications/application.controller';
import { SettingsController } from './applications/settings.controller';
import { ApplyEngineService } from './applications/apply-engine.service';
import { AnswerBankService } from './applications/answer-bank.service';
import { ApplicationRepository } from './applications/application.repository';
import { ApplySettingRepository } from './applications/apply-setting.repository';

@Module({
	imports: [
		ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
		ScheduleModule.forRoot(),
		TypeOrmModule.forRootAsync({
			inject: [ConfigService],
			useFactory: (config: ConfigService) => mysqlConfig(config.get<string>('DATABASE_NAME', 'myjob_agent')),
		}),
		TypeOrmModule.forFeature([CandidateProfile, JobLead, Application, QuestionAnswer, ApplySetting, StatusUpdate, InterviewQuestion, MailAccount, LearningWeight, MuhurtaWindow, PreApplyItem, FnfPortfolio, FnfTrade, FnfMarketSnapshot, FnfDecayCalibration, FnfOptionContract, FnfOptionQuote, FnfMarketSnapshotHistory, FnfOptionQuoteHistory, FnfTradeReflection, FnfDecisionJournal, ProjectChecklistItem]),
		SideIncomeModule,
		AuthModule,
	],
	controllers: [ProfileController, LeadController, ApplicationController, SettingsController, InterviewPrepController, InterviewPracticePageController, MailController, InboxController, PortalCredentialController, AutoApplyController, BrowserFormController, LearningController, ApplicationsPageController, LinkedInController, SandboxController, VisaGuidePageController, AstroController, PreApplyPageController, FnfTradingController, FnfTradingPageController, OptionTradingPageController, FnoMarketDataController, MarketDataInspectionController, MarketDataPageController, FnfOptionChainController, FailedApplicationsPageController, ProjectStatusPageController,
		AuthController, // auth endpoints must register BEFORE the fallback (root-module controllers register first)
		AppFallbackController], // MUST stay last: serves dashboard.html for unmatched GETs
	providers: [
		ProfileService,
		ProfileRepository,
		ProfileOptimizer,
		ScoutService,
		LeadRepository,
		ApplyEngineService,
		AnswerBankService,
		DirectChannelDetector,
		DirectApplyMailer,
		MailService,
		HumanEmailComposer,
		AtsCvBuilder,
		ProcessLearningService,
		InboxReaderService,
		ApplicationRepository,
		ApplySettingRepository,
		PortalCredentialService,
		HrEmailInvestigator,
		AutoApplyLoopService,
		RetryBackoffService,
		BrowserFormService,
		LearningWeightsService,
		DailyDigestService,
		LinkedInProfileService,
		EmailTrackerService,
		InterviewPrepService,
		AstroMuhurtaService,
		AstroLeadScoringService,
		PreApplyItemRepository,
		PreApplyService,
		MuhurtaSendService,
		FnfTradingService,
		FnoMarketDataService,
		FnfOptionChainService,
		MarketDataInspectionService,
		ProjectStatusService,
	],
})
export class AppModule {}
