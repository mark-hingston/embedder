/**
 * Simple rate limiter to enforce a cooldown period after a rate limit error.
 * This ensures that subsequent requests wait for the specified duration.
 */
export class RateLimiter {
    coolDownUntil = 0; // Timestamp (ms) until which requests should pause
    /**
     * Waits if currently in a cooldown period due to a rate limit.
     * @returns A promise that resolves when it's okay to proceed.
     */
    async waitForPermit() {
        const now = Date.now();
        if (now < this.coolDownUntil) {
            const waitTime = this.coolDownUntil - now;
            console.log(`RateLimiter: Cooling down for ${waitTime}ms.`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
    /**
     * Notifies the limiter that a rate limit was hit and a cooldown is required.
     * @param retryAfterSeconds The duration (in seconds) to wait before the next attempt.
     */
    notifyRateLimit(retryAfterSeconds) {
        const now = Date.now();
        // Add a small buffer (e.g., 500ms) to the wait time just in case
        const newCoolDownUntil = now + (retryAfterSeconds * 1000) + 500;
        // Update only if the new cooldown extends further than the current one
        if (newCoolDownUntil > this.coolDownUntil) {
            this.coolDownUntil = newCoolDownUntil;
            console.log(`RateLimiter: Rate limit hit. Cooling down until ${new Date(this.coolDownUntil).toISOString()}.`);
        }
    }
}
