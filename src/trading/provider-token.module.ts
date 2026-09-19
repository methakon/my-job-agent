import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EncryptionService } from '../auth/encryption.service';
import { ProviderToken } from './provider-token.entity';
import { ProviderTokenService } from './provider-token.service';

@Module({
  imports: [TypeOrmModule.forFeature([ProviderToken])],
  providers: [ProviderTokenService, EncryptionService],
  exports: [ProviderTokenService, TypeOrmModule],
})
export class ProviderTokenModule {}
