import { IsOptional, IsString, Length } from 'class-validator';

export class AnswerDto {
	@IsString() @Length(1, 300)
	question!: string;

	@IsString() @Length(0, 2000)
	answer!: string;
}

export class QueueApplicationDto {
	@IsString()
	leadId!: string;

	@IsOptional() @IsString()
	note?: string;
}
