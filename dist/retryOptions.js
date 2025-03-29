/**
 * Default configuration values for the retry mechanism.
 */
export const DEFAULT_RETRY_OPTIONS = {
    maxRetries: 3,
    initialDelay: 100, // Start with a short delay
    maxDelay: 5000, // Cap delay at 5 seconds
    factor: 2, // Double delay each time
    onRetry: (error, attempt) => {
        // Default behavior is to log a warning
        console.warn(`Retry attempt ${attempt} after error: ${error.message}`);
    },
};
