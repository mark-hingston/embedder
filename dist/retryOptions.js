/**
 * Default configuration values for the retry mechanism.
 */
export const DEFAULT_RETRY_OPTIONS = {
    maxRetries: 3,
    initialDelay: 100,
    maxDelay: 5000,
    factor: 2,
    onRetry: (error, attempt) => {
        console.warn(`Retry attempt ${attempt} after error: ${error.message}`);
    },
};
