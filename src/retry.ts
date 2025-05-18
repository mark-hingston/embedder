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
    const config: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };

    let lastError: Error | undefined;
    let delay = config.initialDelay;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt >= config.maxRetries) {
          break;
        }

        if (config.onRetry) {
          config.onRetry(lastError, attempt);
        }

        delay = Math.min(delay * config.factor, config.maxDelay);

        const jitter = delay * 0.2 * (Math.random() - 0.5);
        const waitTime = Math.max(0, delay + jitter);

        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    throw lastError!;
  }