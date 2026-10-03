const { CircuitBreaker } = require("./circuitBreaker");

const FAILURE_THRESHOLD = Number(process.env.CB_FAILURE_THRESHOLD || 3);
const RESET_TIMEOUT_MS = Number(process.env.CB_RESET_TIMEOUT_MS || 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.CB_REQUEST_TIMEOUT_MS || 3000);

class ServiceUnavailableError extends Error {
  constructor(label) {
    super(`${label} unavailable`);
    this.unavailable = true;
    this.label = label;
  }
}

const SERVICES = {
  flight: {
    url: process.env.FLIGHT_SERVICE_URL || "http://flight-service:8060",
    label: "Flight Service",
    breaker: new CircuitBreaker({ failureThreshold: FAILURE_THRESHOLD, resetTimeoutMs: RESET_TIMEOUT_MS }),
  },
  ticket: {
    url: process.env.TICKET_SERVICE_URL || "http://ticket-service:8070",
    label: "Ticket Service",
    breaker: new CircuitBreaker({ failureThreshold: FAILURE_THRESHOLD, resetTimeoutMs: RESET_TIMEOUT_MS }),
  },
  bonus: {
    url: process.env.BONUS_SERVICE_URL || "http://bonus-service:8050",
    label: "Bonus Service",
    breaker: new CircuitBreaker({ failureThreshold: FAILURE_THRESHOLD, resetTimeoutMs: RESET_TIMEOUT_MS }),
  },
};

async function performFetch(service, path, options) {
  try {
    const res = await fetch(`${service.url}${path}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status >= 500) {
      throw new ServiceUnavailableError(service.label);
    }
    if (res.status === 404) return { status: 404, body: null };
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError(service.label);
  }
}

// Read (GET) calls go through the Circuit Breaker: once a service accumulates
// enough failures, further reads short-circuit straight to the fallback instead
// of waiting on a doomed request, and get re-tried after a cooldown.
async function readRequest(serviceKey, path) {
  const service = SERVICES[serviceKey];
  if (!service.breaker.canRequest()) {
    throw new ServiceUnavailableError(service.label);
  }
  try {
    const result = await performFetch(service, path);
    service.breaker.onSuccess();
    return result;
  } catch (err) {
    service.breaker.onFailure();
    throw err;
  }
}

// Write (POST/DELETE) calls are mutating, one-shot operations driven by the
// requirements around rollback/retry-queue, so they always attempt the real
// request rather than being gated by the read breaker's state.
async function writeRequest(serviceKey, path, options) {
  const service = SERVICES[serviceKey];
  return performFetch(service, path, options);
}

function jsonPost(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function listFlights(page, size) {
  const params = new URLSearchParams();
  if (page !== undefined) params.set("page", page);
  if (size !== undefined) params.set("size", size);
  const { body } = await readRequest("flight", `/api/v1/flights?${params}`);
  return body;
}

async function getFlight(flightNumber) {
  const { status, body } = await readRequest("flight", `/api/v1/flights/${encodeURIComponent(flightNumber)}`);
  return status === 404 ? null : body;
}

async function listTickets(username) {
  const { body } = await readRequest("ticket", `/api/v1/tickets?username=${encodeURIComponent(username)}`);
  return body || [];
}

async function getTicket(username, ticketUid) {
  const { status, body } = await readRequest(
    "ticket",
    `/api/v1/tickets/${encodeURIComponent(ticketUid)}?username=${encodeURIComponent(username)}`
  );
  return status === 404 ? null : body;
}

async function createTicket(payload) {
  const { body } = await writeRequest("ticket", "/api/v1/tickets", jsonPost(payload));
  return body;
}

async function cancelTicket(username, ticketUid) {
  const { status, body } = await writeRequest(
    "ticket",
    `/api/v1/tickets/${encodeURIComponent(ticketUid)}?username=${encodeURIComponent(username)}`,
    { method: "DELETE" }
  );
  return status === 404 ? null : body;
}

async function getPrivilege(username) {
  const { body } = await readRequest("bonus", `/api/v1/privilege?username=${encodeURIComponent(username)}`);
  return body;
}

async function fillPrivilege(username, ticketUid, amount) {
  const { body } = await writeRequest(
    "bonus",
    "/api/v1/privilege/fill",
    jsonPost({ username, ticketUid, amount })
  );
  return body;
}

async function debitPrivilege(username, ticketUid, amount) {
  const { body } = await writeRequest(
    "bonus",
    "/api/v1/privilege/debit",
    jsonPost({ username, ticketUid, amount })
  );
  return body;
}

async function cancelPrivilege(username, ticketUid) {
  const { body } = await writeRequest(
    "bonus",
    `/api/v1/privilege/tickets/${encodeURIComponent(ticketUid)}/cancel`,
    jsonPost({ username })
  );
  return body;
}

module.exports = {
  ServiceUnavailableError,
  listFlights,
  getFlight,
  listTickets,
  getTicket,
  createTicket,
  cancelTicket,
  getPrivilege,
  fillPrivilege,
  debitPrivilege,
  cancelPrivilege,
};
