import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FnfDecisionJournal } from './fnf-decision-journal.entity';
import { AiService } from '../ai/ai.service';
import {
  AiTradingInput,
  AiTradingAssessment,
  AiAssessmentResult,
  SchemaValidationError,
  AgreementLevel,
  RiskLevel,
  Recommendation,
  ConfidenceLevel,
  ExecutionAdvisory,
  DeterministicAction,
  AiRoutingMetadata,
} from './trading-ai.types';

/**
 * SHADOW-MODE TRADING AI SERVICE
 * 
 * Provides AI assessment of deterministic trading decisions WITHOUT
 * influencing execution in any way.
 * 
 * Key guarantees:
 * - Reads only: never writes to trading engine state
 * - Advice only: never produces BUY/SELL signals
 * - Non-blocking: AI failure never alters deterministic path
 * - Audit-ready: all routing metadata preserved in journal
 * 
 * CRITICAL FIXES:
 * - Model identity derived from routing metadata, NOT LLM response
 * - LLM-generated model identity is OVERWRITTEN from trusted source
 * - Schema validation is STRICT and fail-closed
 * - All nested required fields are enforced
 * - Unknown/malformed critical values cause fail-closed
 */
@Injectable()
export class AiTradingDecisionService {
  private readonly logger = new Logger(AiTradingDecisionService.name);

  constructor(
    @InjectRepository(FnfDecisionJournal)
    private readonly journal: Repository<FnfDecisionJournal>,
    private readonly aiService: AiService,
  ) {}

  /**
   * Generate AI assessment for a trading decision.
   * 
   * This is a SHADOW READ-ONLY operation:
   * - Does NOT modify portfolio, trades, or engine state
   * - Does NOT influence BUY/SELL/HOLD decisions
   * - Does NOT block or delay deterministic execution
   * - Returns assessment regardless of success/failure
   * 
   * @param input - Point-in-time trading snapshot
   * @param routingMetadata - Trusted routing metadata from AiRoutingService
   * @returns Assessment result (success or failure with error details)
   */
  async assessTradingDecision(
    input: AiTradingInput,
    routingMetadata: AiRoutingMetadata,
  ): Promise<AiAssessmentResult> {
    const startedAt = Date.now();

    try {
      // Build the assessment prompt from input payload
      const prompt = this.buildAssessmentPrompt(input, routingMetadata);

      // Route through existing AI service with trading_research task type
      // Note: routing metadata is passed to prompt, NOT used for AI routing
      const routingResponse = await this.aiService.generate({
        prompt,
        taskType: 'trading_research',
      });

      const latencyMs = Date.now() - startedAt;

      // Parse and validate the structured JSON output
      const parsed = this.parseAndValidateAssessment(
        routingResponse.text,
        latencyMs,
        routingResponse,
      );

      if (!parsed.success) {
        this.logger.warn(`AI assessment failed validation: ${parsed.error}`);
        return parsed;
      }

      // CRITICAL: Overwrite any LLM-provided model identity with trusted routing metadata
      // The LLM SHOULD NOT provide authoritative model identity - it comes from routing
      // Parse any model identity the LLM returned and overwrite it with trusted source
      parsed.assessment.modelIdentity = {
        routingPolicyVersion: routingMetadata.routingPolicyVersion,
        HermesModelKey: routingMetadata.HermesModelKey,
        selectedModelKey: routingMetadata.selectedModelKey,
        selectedProvider: routingMetadata.selectedProvider,
        selectedModelId: routingMetadata.selectedModelId,
        selectedModelTier: routingMetadata.selectedModelTier,
        selectedModelExperimental: routingMetadata.selectedModelExperimental,
      };

      this.logger.log(
        `AI trading assessment completed: ${input.underlying} ${input.instrument} ` +
        `→ ${parsed.assessment.summary.overallAssessment.substring(0, 50)}...`,
      );

      return parsed;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = (error as Error).message || 'Unknown error';

      this.logger.error(
        `AI trading assessment failed for ${input.instrument}: ${message}`,
        (error as Error).stack,
      );

      return {
        success: false,
        error: message,
        details: {
          latencyMs,
          inputInstrument: input.instrument,
          inputUnderlying: input.underlying,
        },
      };
    }
  }

  /**
   * Build the structured prompt for AI trading assessment.
   * Contains ONLY the data needed for assessment, no additional context.
   * Adds routing metadata to prompt for transparency.
   */
  private buildAssessmentPrompt(input: AiTradingInput, routingMetadata: AiRoutingMetadata): string {
    const lines: string[] = [];

    // System instructions
    lines.push('You are an expert option trading advisor. Your role is to ASSESS trading decisions, NOT make them.');
    lines.push('');
    lines.push('TASK: Analyze this trading candidate and produce a structured assessment.');
    lines.push('');
    lines.push('RULES:');
    lines.push('- You are SHADOW-ONLY: your assessment is advisory only, never executable');
    lines.push('- Do NOT suggest BUY/SELL actions - you assess quality of the decision');
    lines.push('- Base your assessment ONLY on the data provided below');
    lines.push('- If data is incomplete or inconsistent, note it in warnings');
    lines.push('- Provide actionable insights for improvement');
    lines.push('');

    // Model identity for transparency (from trusted routing, NOT from LLM)
    lines.push('=== MODEL IDENTITY (for transparency) ===');
    lines.push(`Routing Policy Version: ${routingMetadata.routingPolicyVersion}`);
    lines.push(`Hermes Model Key: ${routingMetadata.HermesModelKey}`);
    lines.push(`Selected Model Key: ${routingMetadata.selectedModelKey}`);
    lines.push(`Selected Provider: ${routingMetadata.selectedProvider}`);
    lines.push(`Selected Model ID: ${routingMetadata.selectedModelId}`);
    lines.push(`Selected Model Tier: ${routingMetadata.selectedModelTier}`);
    lines.push(`Selected Model Experimental: ${routingMetadata.selectedModelExperimental}`);
    lines.push('');

    // Decision context
    lines.push('=== DECISION CONTEXT ===');
    lines.push(`Timestamp: ${input.decisionTimestamp}`);
    lines.push(`Session Phase: ${input.sessionPhase}`);
    lines.push(`Underlying: ${input.underlying}`);