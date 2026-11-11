import type { ExecutionStep, StepResult, ValidationResult } from '@frontagent/shared';
import { stripLLMRequestTag } from '../llm/llm-request-error.js';
import type { AgentEvent } from '../types.js';

function cleanError(error: string | undefined): string | undefined {
  return error === undefined ? undefined : stripLLMRequestTag(error);
}

function cleanStepResult(result: StepResult): StepResult {
  return result.error === undefined ? result : { ...result, error: cleanError(result.error) };
}

export function cleanStepError(step: ExecutionStep): ExecutionStep {
  return { ...step, result: step.result ? cleanStepResult(step.result) : undefined };
}

export function cleanValidationError(validation: ValidationResult): ValidationResult {
  return {
    ...validation,
    blockedBy: validation.blockedBy?.map(stripLLMRequestTag),
    warnings: validation.warnings?.map(stripLLMRequestTag),
    results: validation.results.map((result) => ({
      ...result,
      message: cleanError(result.message),
    })),
  };
}

// Listeners consume display text; the execution state must retain provenance for runtime formatting.
export function cleanEventErrors(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'task_failed':
    case 'rollback_failed':
      return { ...event, error: stripLLMRequestTag(event.error) };
    case 'step_failed':
      return { ...event, step: cleanStepError(event.step), error: stripLLMRequestTag(event.error) };
    case 'step_started':
      return { ...event, step: cleanStepError(event.step) };
    case 'step_completed':
      return { ...event, step: cleanStepError(event.step), result: cleanStepResult(event.result) };
    case 'planning_completed':
      return { ...event, plan: { ...event.plan, steps: event.plan.steps.map(cleanStepError) } };
    case 'validation_failed':
      return { ...event, result: cleanValidationError(event.result) };
    case 'task_completed':
      return {
        ...event,
        result: {
          ...event.result,
          error: cleanError(event.result.error),
          plannerFallbackReason: cleanError(event.result.plannerFallbackReason),
          executedSteps: event.result.executedSteps.map(cleanStepError),
          validations: event.result.validations.map(cleanValidationError),
        },
      };
    default:
      return event;
  }
}
