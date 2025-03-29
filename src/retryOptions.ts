/**
 * Configuration options for the retry mechanism.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Initial delay in milliseconds before the first retry. */
  initialDelay: number;
  /** Maximum delay in milliseconds between retries. */
  maxDelay: number;
  /** Multiplier for exponential backoff (e.g., 2 means delay doubles each time). */
  factor: number;
  /** Optional callback function executed before each retry attempt. */
  onRetry?: (error: Error, attempt: number) => void;
}

/**
 * Default configuration values for the retry mechanism.
 */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelay: 100, // Start with a short delay
  maxDelay: 5000,   // Cap delay at 5 seconds
  factor: 2,        // Double delay each time
  onRetry: (error, attempt) => {
    // Default behavior is to log a warning
    console.warn(`Retry attempt ${attempt} after error: ${error.message}`);
  },
};