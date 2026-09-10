import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobApplicationRoadmapItem } from './job-application-roadmap-item.entity';
import { JobApplicationRoadmapService } from './job-application-roadmap.service';
import { JobApplicationRoadmapPageController } from './job-application-roadmap-page.controller';

@Module({
  imports: [TypeOrmModule.forFeature([JobApplicationRoadmapItem])],
  controllers: [JobApplicationRoadmapPageController],
  providers: [JobApplicationRoadmapService],
  exports: [JobApplicationRoadmapService],
})
export class JobApplicationRoadmapModule {}
