/**
 * JSON Schema validation for WorkOrder and WorkReport
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

// Handle ESM/CJS interop for ajv and ajv-formats
// These packages have complex export structures that don't work well with NodeNext
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

interface ErrorObject {
  instancePath: string;
  message?: string;
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import workOrderSchema from './schemas/work-order.schema.json' with { type: 'json' };
import workReportSchema from './schemas/work-report.schema.json' with { type: 'json' };
import type { WorkOrder } from './types/work-order.js';
import type { WorkReport } from './types/work-report.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
});
addFormats(ajv);

// Compile validators
const validateWorkOrderSchema = ajv.compile(workOrderSchema);
const validateWorkReportSchema = ajv.compile(workReportSchema);

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

/**
 * Validate a WorkOrder against the JSON Schema
 */
export function validateWorkOrder(data: unknown): ValidationResult<WorkOrder> {
  const valid = validateWorkOrderSchema(data);

  if (valid) {
    return {
      valid: true,
      data: data as WorkOrder,
    };
  }

  return {
    valid: false,
    errors: validateWorkOrderSchema.errors?.map((err: ErrorObject) => ({
      path: err.instancePath || '/',
      message: err.message || 'Unknown validation error',
    })) ?? [],
  };
}

/**
 * Validate a WorkReport against the JSON Schema
 */
export function validateWorkReport(data: unknown): ValidationResult<WorkReport> {
  const valid = validateWorkReportSchema(data);

  if (valid) {
    return {
      valid: true,
      data: data as WorkReport,
    };
  }

  return {
    valid: false,
    errors: validateWorkReportSchema.errors?.map((err: ErrorObject) => ({
      path: err.instancePath || '/',
      message: err.message || 'Unknown validation error',
    })) ?? [],
  };
}

/**
 * Assert that data is a valid WorkOrder, throwing if invalid
 */
export function assertWorkOrder(data: unknown): asserts data is WorkOrder {
  const result = validateWorkOrder(data);
  if (!result.valid) {
    const errorMsg = result.errors?.map(e => `${e.path}: ${e.message}`).join(', ');
    throw new Error(`Invalid WorkOrder: ${errorMsg}`);
  }
}

/**
 * Assert that data is a valid WorkReport, throwing if invalid
 */
export function assertWorkReport(data: unknown): asserts data is WorkReport {
  const result = validateWorkReport(data);
  if (!result.valid) {
    const errorMsg = result.errors?.map(e => `${e.path}: ${e.message}`).join(', ');
    throw new Error(`Invalid WorkReport: ${errorMsg}`);
  }
}

// Re-export schemas for external use
export { workOrderSchema, workReportSchema };
