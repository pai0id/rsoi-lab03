// In-memory queue that retries a failing compensating task until it succeeds.
// Used for the ticket-cancellation flow: if Bonus Service is down, the user still
// gets a success response and the bonus rollback is queued for later retry.
function createRetryQueue({ intervalMs = 2000 } = {}) {
  const queue = [];
  let timer = null;

  function tick() {
    if (queue.length === 0) {
      clearInterval(timer);
      timer = null;
      return;
    }
    const task = queue[0];
    task()
      .then(() => {
        queue.shift();
      })
      .catch(() => {
        // keep at the head of the queue, retried on the next tick
      });
  }

  function enqueue(task) {
    queue.push(task);
    if (!timer) {
      timer = setInterval(tick, intervalMs);
    }
  }

  function size() {
    return queue.length;
  }

  return { enqueue, size };
}

module.exports = { createRetryQueue };
