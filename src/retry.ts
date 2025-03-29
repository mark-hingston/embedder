import { RetryOptions, DEFAULT_RETRY_OPTIONS } from "./retryOptions.js";

/**
 * Retries an asynchronous operation with exponential backoff and jitter.
 * @template T The return type of the async operation.
 * @param {() => Promise<T>} operation The asynchronous function to retry.
 * @param {Partial<RetryOptions>} [options={}] Optional retry configuration overrides.
 * @returns {Promise<T>} A promise that resolves with the result of the operation if successful.
 * @throws {Error} Throws the last error encountered if all retries fail.
 */
export async function retry<T>(
    operation: () => Promise<T>,
    options: Partial<RetryOptions> = {}
  ): Promise<T> {
    // Merge default options with provided overrides
    const config: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };

    let lastError: Error | undefined;
    let delay = config.initialDelay;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        // Attempt the operation
        return await operation();
      } catch (error) {
        // Record the error
        lastError = error instanceof Error ? error : new Error(String(error));

        // If it's the last attempt, break the loop to throw the error
        if (attempt >= config.maxRetries) {
          break;
        }

        // Execute the onRetry callback if provided
        if (config.onRetry) {
          config.onRetry(lastError, attempt);
        }

        // Calculate next delay: exponential backoff with a maximum limit
        delay = Math.min(delay * config.factor, config.maxDelay);

        // Add jitter: random fraction (e.g., +/- 10%) of the delay to prevent thundering herd
        const jitter = delay * 0.2 * (Math.random() - 0.5); // +/- 10% jitter
        const waitTime = Math.max(0, delay + jitter); // Ensure wait time is not negative

        // Wait before the next attempt
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // If loop finishes without returning, all retries failed
    throw lastError!; // Non-null assertion because lastError is guaranteed to be set if loop finishes
  }