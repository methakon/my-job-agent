import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { mysqlConfig } from './shared/db.config';
import { CandidateProfile } from './profile/candidate-profile.entity';
import { JobLead } from './leads/job-lead.entity';
import { Application } from './applications/application.entity';
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
import { InterviewPrepController } from './interview/interview-prep.controller';
import { MailController } from './applications/mail.controller';
import { InboxReaderService } from './applications/inbox-reader.service';
import { InboxController } from './applications/inbox.controller';
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
		TypeOrmModule.forFeature([CandidateProfile, JobLead, Application, QuestionAnswer, ApplySetting, StatusUpdate, InterviewQuestion, MailAccount]),
	],
	controllers: [ProfileController, LeadController, ApplicationController, SettingsController, InterviewPrepController, MailController, InboxController],
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
		EmailTrackerService,
		InterviewPrepService,
	],
})
export class AppModule {}
