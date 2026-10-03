const { CircuitBreaker } = require("../src/circuitBreaker");

test("stays closed while failures are below the threshold", () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
  expect(cb.canRequest()).toBe(true);
  cb.onFailure();
  expect(cb.canRequest()).toBe(true);
});

test("opens once the failure threshold is reached", () => {
  const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
  cb.onFailure();
  cb.onFailure();
  expect(cb.canRequest()).toBe(false);
});

test("moves to half-open and closes again after a successful probe", () => {
  jest.useFakeTimers();
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
  cb.onFailure();
  expect(cb.canRequest()).toBe(false);

  jest.advanceTimersByTime(1000);
  expect(cb.canRequest()).toBe(true);

  cb.onSuccess();
  expect(cb.canRequest()).toBe(true);
  jest.useRealTimers();
});

test("re-opens immediately if the half-open probe fails", () => {
  jest.useFakeTimers();
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
  cb.onFailure();
  jest.advanceTimersByTime(1000);
  expect(cb.canRequest()).toBe(true);

  cb.onFailure();
  expect(cb.canRequest()).toBe(false);
  jest.useRealTimers();
});
