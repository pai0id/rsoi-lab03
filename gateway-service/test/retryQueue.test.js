const { createRetryQueue } = require("../src/retryQueue");

test("retries a failing task on every tick until it succeeds", async () => {
  jest.useFakeTimers();
  const queue = createRetryQueue({ intervalMs: 10 });

  let attempts = 0;
  const task = jest.fn(() => {
    attempts += 1;
    return attempts < 3 ? Promise.reject(new Error("fail")) : Promise.resolve();
  });

  queue.enqueue(task);
  expect(queue.size()).toBe(1);

  await jest.advanceTimersByTimeAsync(10);
  await jest.advanceTimersByTimeAsync(10);
  await jest.advanceTimersByTimeAsync(10);

  expect(task).toHaveBeenCalledTimes(3);
  expect(queue.size()).toBe(0);

  jest.useRealTimers();
});

test("processes queued tasks in order", async () => {
  jest.useFakeTimers();
  const queue = createRetryQueue({ intervalMs: 10 });

  const order = [];
  queue.enqueue(() => {
    order.push("first");
    return Promise.resolve();
  });
  queue.enqueue(() => {
    order.push("second");
    return Promise.resolve();
  });

  await jest.advanceTimersByTimeAsync(10);
  await jest.advanceTimersByTimeAsync(10);

  expect(order).toEqual(["first", "second"]);
  expect(queue.size()).toBe(0);

  jest.useRealTimers();
});
