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
