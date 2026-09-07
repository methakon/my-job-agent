import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EncryptionService } from '../auth/encryption.service';
import { FyersToken } from './fyers-token.entity';
import { FyersTokenService } from './fyers-token.service';

@Module({
  imports: [TypeOrmModule.forFeature([FyersToken])],
  providers: [FyersTokenService, EncryptionService],
  exports: [FyersTokenService, TypeOrmModule],
})
export class FyersTokenModule {}
