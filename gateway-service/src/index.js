const express = require("express");
const clients = require("./clients");
const { computePurchaseSplit } = require("./pricing");
const { createRetryQueue } = require("./retryQueue");

const app = express();
app.use(express.json());

const bonusRetryQueue = createRetryQueue({ intervalMs: Number(process.env.RETRY_INTERVAL_MS || 2000) });

function requireUsername(req, res) {
  const username = req.header("X-User-Name");
  if (!username) {
    res.status(400).json({ message: "X-User-Name header is required" });
    return null;
  }
  return username;
}

function unavailableResponse(res, err) {
  return res.status(503).json({ message: err.message });
}

async function enrichTickets(tickets) {
  const flightCache = new Map();
  const results = [];
  for (const ticket of tickets) {
    if (!flightCache.has(ticket.flightNumber)) {
      let flight = null;
      try {
        flight = await clients.getFlight(ticket.flightNumber);
      } catch (err) {
        if (!err.unavailable) throw err;
        flight = null; // Flight Service is non-critical here: fall back below.
      }
      flightCache.set(ticket.flightNumber, flight);
    }
    const flight = flightCache.get(ticket.flightNumber) || {};
    results.push({
      ticketUid: ticket.ticketUid,
      flightNumber: ticket.flightNumber,
      fromAirport: flight.fromAirport || "",
      toAirport: flight.toAirport || "",
      date: flight.date || "",
      price: ticket.price,
      status: ticket.status,
    });
  }
  return results;
}

app.get("/manage/health", (req, res) => {
  res.sendStatus(200);
});

app.get("/api/v1/flights", async (req, res, next) => {
  try {
    const flights = await clients.listFlights(req.query.page, req.query.size);
    res.json(flights);
  } catch (err) {
    if (err.unavailable) return unavailableResponse(res, err);
    next(err);
  }
});

app.get("/api/v1/tickets", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    let tickets;
    try {
      tickets = await clients.listTickets(username);
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }

    res.json(await enrichTickets(tickets));
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/tickets/:ticketUid", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    let ticket;
    try {
      ticket = await clients.getTicket(username, req.params.ticketUid);
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }

    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }
    const [enriched] = await enrichTickets([ticket]);
    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

app.post("/api/v1/tickets", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const { flightNumber, price, paidFromBalance } = req.body || {};
    if (typeof flightNumber !== "string" || flightNumber.trim() === "" || typeof price !== "number") {
      return res.status(400).json({
        message: "Validation error",
        errors: [{ field: "flightNumber/price", error: "must be provided" }],
      });
    }

    let flight;
    try {
      flight = await clients.getFlight(flightNumber);
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }
    if (!flight) {
      return res.status(400).json({
        message: "Validation error",
        errors: [{ field: "flightNumber", error: "flight not found" }],
      });
    }

    let ticket;
    try {
      ticket = await clients.createTicket({ username, flightNumber, price });
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }

    try {
      const privilege = await clients.getPrivilege(username);
      const { paidByBonuses, paidByMoney } = computePurchaseSplit(
        privilege.balance,
        price,
        Boolean(paidFromBalance)
      );

      const updatedPrivilege =
        paidByBonuses > 0
          ? await clients.debitPrivilege(username, ticket.ticketUid, paidByBonuses)
          : await clients.fillPrivilege(username, ticket.ticketUid, Math.round(price * 0.1));

      res.json({
        ticketUid: ticket.ticketUid,
        flightNumber: flight.flightNumber,
        fromAirport: flight.fromAirport,
        toAirport: flight.toAirport,
        date: flight.date,
        price,
        paidByMoney,
        paidByBonuses,
        status: ticket.status,
        privilege: { balance: updatedPrivilege.balance, status: updatedPrivilege.status },
      });
    } catch (err) {
      if (!err.unavailable) throw err;
      // Bonus Service failed after the ticket was created: roll the purchase back.
      await clients.cancelTicket(username, ticket.ticketUid).catch(() => {});
      return unavailableResponse(res, err);
    }
  } catch (err) {
    next(err);
  }
});

app.delete("/api/v1/tickets/:ticketUid", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    let ticket;
    try {
      ticket = await clients.getTicket(username, req.params.ticketUid);
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }
    if (!ticket) {
      return res.status(404).json({ message: "Ticket not found" });
    }

    try {
      await clients.cancelTicket(username, req.params.ticketUid);
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }

    try {
      await clients.cancelPrivilege(username, req.params.ticketUid);
    } catch (err) {
      if (!err.unavailable) throw err;
      // Bonus Service is down: tell the user the cancellation succeeded (the
      // ticket already is) and retry the bonus rollback in the background.
      bonusRetryQueue.enqueue(() => clients.cancelPrivilege(username, req.params.ticketUid));
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/me", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    let tickets;
    try {
      tickets = await clients.listTickets(username);
    } catch (err) {
      if (err.unavailable) return unavailableResponse(res, err);
      throw err;
    }

    let privilege = {};
    try {
      const p = await clients.getPrivilege(username);
      privilege = { balance: p.balance, status: p.status };
    } catch (err) {
      if (!err.unavailable) throw err;
      // Bonus Service is non-critical for /me: fall back to an empty object.
    }

    res.json({
      tickets: await enrichTickets(tickets),
      privilege,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/v1/privilege", async (req, res, next) => {
  try {
    const username = requireUsername(req, res);
    if (!username) return;

    const privilege = await clients.getPrivilege(username);
    res.json(privilege);
  } catch (err) {
    if (err.unavailable) return unavailableResponse(res, err);
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Internal error" });
});

const PORT = process.env.PORT || 8080;

if (require.main === module) {
  app.listen(PORT, () => console.log(`gateway-service listening on ${PORT}`));
}

module.exports = app;
