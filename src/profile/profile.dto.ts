import { IsArray, IsEmail, IsOptional, IsString, Length } from 'class-validator';

/** DTO returned to clients — never expose raw entity. */
export class ProfileResponseDto {
	id!: string;
	name!: string;
	email!: string | null;
	phone!: string | null;
	skills!: string[] ;
	headline!: string | null;
	experienceYears!: number | null;
	noticePeriod!: string | null;
	salaryExpectation!: string | null;
	linkedinUrl!: string | null;
	githubUrl!: string | null;
	portfolioUrl!: string | null;
	currentLocation!: string | null;
	workHistory!: Array<{ company: string; role: string; from: string; to: string; summary?: string }>;
	education!: Array<{ school: string; degree: string; from: string; to: string; note?: string }>;
	projects!: Array<{ name: string; client?: string; tech: string[]; from?: string; to?: string; summary?: string }>;
	missingFields!: string[];
}

export class UpsertProfileDto {
	@IsOptional() @IsString() @Length(1, 120)
	name?: string;

	@IsOptional() @IsEmail()
	email?: string;

	@IsOptional() @IsString() @Length(5, 40)
	phone?: string;

	@IsOptional() @IsString({ each: true })
	skills?: string[];

	@IsOptional() @IsString() @Length(0, 160)
	headline?: string;

	@IsOptional() @Length(0, 2)
	experienceYears?: string;

	@IsOptional() @IsString() @Length(0, 60)
	noticePeriod?: string;

	@IsOptional() @IsString() @Length(0, 60)
	salaryExpectation?: string;

	@IsOptional() @IsString() @Length(0, 255)
	linkedinUrl?: string;

	@IsOptional() @IsString() @Length(0, 255)
	githubUrl?: string;

	@IsOptional() @IsString() @Length(0, 255)
	portfolioUrl?: string;

	@IsOptional() @IsString() @Length(0, 180)
	currentLocation?: string;

	@IsOptional() @IsArray()
	workHistory?: Array<{ company: string; role: string; from: string; to: string; summary?: string }>;

	@IsOptional() @IsArray()
	education?: Array<{ school: string; degree: string; from: string; to: string; note?: string }>;

	@IsOptional() @IsArray()
	projects?: Array<{ name: string; client?: string; tech: string[]; from?: string; to?: string; summary?: string }>;
}
