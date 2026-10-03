const STATE = Object.freeze({ CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" });

// Classic Circuit Breaker for read operations: after `failureThreshold` consecutive
// failures the breaker opens and short-circuits calls with a fallback. After
// `resetTimeoutMs` it lets a single probe call through (half-open) to check recovery.
class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 1000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.openedAt = 0;
  }

  canRequest() {
    if (this.state !== STATE.OPEN) return true;
    if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = STATE.HALF_OPEN;
      return true;
    }
    return false;
  }

  onSuccess() {
    this.state = STATE.CLOSED;
    this.failureCount = 0;
  }

  onFailure() {
    this.failureCount += 1;
    if (this.state === STATE.HALF_OPEN || this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.openedAt = Date.now();
    }
  }
}

module.exports = { CircuitBreaker, STATE };
