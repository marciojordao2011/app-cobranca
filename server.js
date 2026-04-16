const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const path = require("path");
const nodemailer = require("nodemailer");
const { run, get, all, initDb, seedDefaultAdmin, randomId } = require("./db");
const { generateToken, authMiddleware } = require("./auth");
const { startScheduler } = require("./scheduler");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateBR(dateValue) {
  return new Intl.DateTimeFormat("pt-BR").format(new Date(dateValue));
}

function formatCurrencyBR(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(value || 0));
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function normalizeWeeklyDay(day) {
  const safe = Math.max(1, Math.min(7, Number(day)));
  return safe % 7;
}

function normalizePhoneBR(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function escapeCsv(value) {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, '""');
  return `"${escaped}"`;
}

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

function getFirstDueDate(rule) {
  const startDate = startOfDay(new Date(rule.start_date));

  if (rule.frequency === "monthly") {
    let dueDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      Math.min(rule.due_day, daysInMonth(startDate.getFullYear(), startDate.getMonth()))
    );

    if (dueDate < startDate) {
      dueDate = new Date(
        startDate.getFullYear(),
        startDate.getMonth() + 1,
        Math.min(rule.due_day, daysInMonth(startDate.getFullYear(), startDate.getMonth() + 1))
      );
    }

    return startOfDay(dueDate);
  }

  if (rule.frequency === "weekly") {
    const weekdayTarget = normalizeWeeklyDay(rule.due_day);
    const dueDate = new Date(startDate);

    while (dueDate.getDay() !== weekdayTarget) {
      dueDate.setDate(dueDate.getDate() + 1);
    }

    return startOfDay(dueDate);
  }

  if (rule.frequency === "yearly") {
    let dueDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      Math.min(rule.due_day, daysInMonth(startDate.getFullYear(), startDate.getMonth()))
    );

    if (dueDate < startDate) {
      dueDate = new Date(
        startDate.getFullYear() + 1,
        startDate.getMonth(),
        Math.min(rule.due_day, daysInMonth(startDate.getFullYear() + 1, startDate.getMonth()))
      );
    }

    return startOfDay(dueDate);
  }

  return startOfDay(startDate);
}

function getNextDueDate(rule, currentDueDate) {
  const current = startOfDay(new Date(currentDueDate));

  if (rule.frequency === "monthly") {
    const nextMonth = current.getMonth() + 1;
    const nextYear = current.getFullYear();

    return startOfDay(new Date(
      nextYear,
      nextMonth,
      Math.min(rule.due_day, daysInMonth(nextYear, nextMonth))
    ));
  }

  if (rule.frequency === "weekly") {
    return startOfDay(addDays(current, 7));
  }

  if (rule.frequency === "yearly") {
    const nextYear = current.getFullYear() + 1;

    return startOfDay(new Date(
      nextYear,
      current.getMonth(),
      Math.min(rule.due_day, daysInMonth(nextYear, current.getMonth()))
    ));
  }

  return startOfDay(current);
}

function isPastDate(date) {
  return startOfDay(date) < startOfDay(new Date());
}

async function getOpenLedgerTotal(clientId, cutoffDate = null) {
  let query = `
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM ledger_entries
    WHERE client_id = ?
      AND billed_invoice_id IS NULL
  `;
  const params = [clientId];

  if (cutoffDate) {
    query += ` AND date(entry_date) <= date(?)`;
    params.push(cutoffDate.toISOString());
  }

  const row = await get(query, params);
  return Number(row?.total || 0);
}

async function closeLedgerIntoInvoice(rule, dueDate) {
  const dueDateKey = formatDateKey(dueDate);

  const existing = await get(
    `SELECT id FROM invoices WHERE rule_id = ? AND due_date_key = ?`,
    [rule.id, dueDateKey]
  );

  if (existing) {
    return false;
  }

  const openAmount = await getOpenLedgerTotal(rule.client_id, dueDate);

  if (openAmount <= 0) {
    return false;
  }

  const invoiceId = randomId();
  const status = isPastDate(dueDate) ? "late" : "pending";

  await run(
    `
      INSERT INTO invoices (
        id, rule_id, client_id, description, amount,
        due_date, due_date_key, status, paid_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      invoiceId,
      rule.id,
      rule.client_id,
      rule.description || "Fechamento de saldo",
      openAmount,
      startOfDay(dueDate).toISOString(),
      dueDateKey,
      status,
      null,
      new Date().toISOString()
    ]
  );

  await run(
    `
      UPDATE ledger_entries
      SET billed_invoice_id = ?
      WHERE client_id = ?
        AND billed_invoice_id IS NULL
        AND date(entry_date) <= date(?)
    `,
    [invoiceId, rule.client_id, dueDate.toISOString()]
  );

  return true;
}

async function generateInvoicesUpToToday() {
  const today = startOfDay(new Date());

  const rules = await all(`SELECT * FROM billing_rules WHERE active = 1`);

  for (const rule of rules) {
    let dueDate = getFirstDueDate(rule);

    while (dueDate <= today) {
      await closeLedgerIntoInvoice(rule, dueDate);
      dueDate = getNextDueDate(rule, dueDate);
    }
  }

  await normalizeInvoicesStatus();
}

async function normalizeInvoicesStatus() {
  const invoices = await all(
    `SELECT id, due_date, status FROM invoices WHERE status != 'paid'`
  );

  for (const invoice of invoices) {
    const nextStatus = isPastDate(new Date(invoice.due_date)) ? "late" : "pending";

    if (nextStatus !== invoice.status) {
      await run(`UPDATE invoices SET status = ? WHERE id = ?`, [nextStatus, invoice.id]);
    }
  }
}

function buildInvoiceFilters(query) {
  const clauses = [];
  const params = [];

  if (query.status && ["pending", "late", "paid"].includes(query.status)) {
    clauses.push("i.status = ?");
    params.push(query.status);
  }

  if (query.clientId) {
    clauses.push("i.client_id = ?");
    params.push(query.clientId);
  }

  if (query.dateFrom) {
    clauses.push("date(i.due_date) >= date(?)");
    params.push(query.dateFrom);
  }

  if (query.dateTo) {
    clauses.push("date(i.due_date) <= date(?)");
    params.push(query.dateTo);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

async function getInvoicesWithClient(filters = {}) {
  const { where, params } = buildInvoiceFilters(filters);

  return all(
    `
      SELECT
        i.*,
        c.name AS client_name,
        c.email AS client_email,
        c.phone AS client_phone,
        c.document AS client_document
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      ${where}
      ORDER BY date(i.due_date) ASC, i.created_at ASC
    `,
    params
  );
}

async function getOpenBalancesByClient() {
  return all(
    `
      SELECT
        c.id AS client_id,
        c.name AS client_name,
        COALESCE(SUM(le.amount), 0) AS open_balance
      FROM clients c
      LEFT JOIN ledger_entries le
        ON le.client_id = c.id
       AND le.billed_invoice_id IS NULL
      GROUP BY c.id, c.name
      ORDER BY c.name ASC
    `
  );
}

async function getDashboardSummary(filters = {}) {
  const invoices = await getInvoicesWithClient(filters);
  const clientCountRow = await get(`SELECT COUNT(*) AS value FROM clients`);
  const openBalances = await getOpenBalancesByClient();

  let totalToReceive = 0;
  let totalReceived = 0;
  let totalPending = 0;
  let totalLate = 0;
  let totalOpenBalance = 0;

  for (const invoice of invoices) {
    if (invoice.status === "paid") {
      totalReceived += Number(invoice.amount);
    } else {
      totalToReceive += Number(invoice.amount);
    }

    if (invoice.status === "pending") totalPending += 1;
    if (invoice.status === "late") totalLate += 1;
  }

  for (const row of openBalances) {
    totalOpenBalance += Number(row.open_balance || 0);
  }

  return {
    totalToReceive,
    totalReceived,
    totalPending,
    totalLate,
    totalClients: Number(clientCountRow?.value || 0),
    totalInvoices: invoices.length,
    totalOpenBalance
  };
}

async function sendInvoiceEmail(invoiceId) {
  const transporter = getTransporter();

  if (!transporter) {
    throw new Error("SMTP não configurado no .env.");
  }

  const invoice = await get(
    `
      SELECT
        i.*,
        c.name AS client_name,
        c.email AS client_email
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      WHERE i.id = ?
    `,
    [invoiceId]
  );

  if (!invoice) {
    throw new Error("Fatura não encontrada.");
  }

  if (!invoice.client_email) {
    throw new Error("Cliente sem email cadastrado.");
  }

  const subject = `Cobrança - ${invoice.description}`;
  const dueDate = formatDateBR(invoice.due_date);
  const amount = formatCurrencyBR(invoice.amount);

  const statusLabel =
    invoice.status === "paid"
      ? "Pago"
      : invoice.status === "late"
        ? "Atrasado"
        : "Pendente";

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: invoice.client_email,
    subject,
    text: `Olá, ${invoice.client_name}. Valor: ${amount}. Vencimento: ${dueDate}. Status: ${statusLabel}.`
  });

  return { success: true, to: invoice.client_email };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha são obrigatórios." });
    }

    const user = await get(`SELECT * FROM users WHERE email = ?`, [email]);

    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro interno no login." });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/clients", authMiddleware, async (req, res) => {
  try {
    const clients = await all(`SELECT * FROM clients ORDER BY created_at DESC`);
    res.json(clients);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao listar clientes." });
  }
});

app.post("/api/clients", authMiddleware, async (req, res) => {
  try {
    const { name, email = "", phone = "", document = "", notes = "" } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Nome é obrigatório." });
    }

    const client = {
      id: randomId(),
      name: String(name).trim(),
      email: String(email).trim(),
      phone: String(phone).trim(),
      document: String(document).trim(),
      notes: String(notes).trim(),
      created_at: new Date().toISOString()
    };

    await run(
      `
        INSERT INTO clients (id, name, email, phone, document, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [client.id, client.name, client.email, client.phone, client.document, client.notes, client.created_at]
    );

    res.status(201).json(client);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao criar cliente." });
  }
});

app.delete("/api/clients/:id", authMiddleware, async (req, res) => {
  try {
    const clientId = req.params.id;
    await run(`DELETE FROM ledger_entries WHERE client_id = ?`, [clientId]);
    await run(`DELETE FROM invoices WHERE client_id = ?`, [clientId]);
    await run(`DELETE FROM billing_rules WHERE client_id = ?`, [clientId]);
    await run(`DELETE FROM clients WHERE id = ?`, [clientId]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao excluir cliente." });
  }
});

app.get("/api/rules", authMiddleware, async (req, res) => {
  try {
    const rules = await all(
      `
        SELECT r.*, c.name AS client_name
        FROM billing_rules r
        JOIN clients c ON c.id = r.client_id
        ORDER BY r.created_at DESC
      `
    );
    res.json(rules);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao listar recorrências." });
  }
});

app.post("/api/rules", authMiddleware, async (req, res) => {
  try {
    const { clientId, description, frequency, dueDay } = req.body || {};

    if (!clientId || !description || !frequency || !dueDay) {
      return res.status(400).json({ error: "Campos obrigatórios não preenchidos." });
    }

    const client = await get(`SELECT id FROM clients WHERE id = ?`, [clientId]);

    if (!client) {
      return res.status(404).json({ error: "Cliente não encontrado." });
    }

    const rule = {
      id: randomId(),
      client_id: clientId,
      description: String(description).trim(),
      frequency,
      due_day: Number(dueDay),
      start_date: new Date().toISOString(),
      active: 1,
      created_at: new Date().toISOString()
    };

    await run(
      `
        INSERT INTO billing_rules (
          id, client_id, description, frequency, due_day, start_date, active, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [rule.id, rule.client_id, rule.description, rule.frequency, rule.due_day, rule.start_date, rule.active, rule.created_at]
    );

    await generateInvoicesUpToToday();
    res.status(201).json(rule);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao criar regra." });
  }
});

app.patch("/api/rules/:id/toggle", authMiddleware, async (req, res) => {
  try {
    const rule = await get(`SELECT * FROM billing_rules WHERE id = ?`, [req.params.id]);

    if (!rule) {
      return res.status(404).json({ error: "Regra não encontrada." });
    }

    const nextValue = rule.active ? 0 : 1;
    await run(`UPDATE billing_rules SET active = ? WHERE id = ?`, [nextValue, req.params.id]);

    res.json({ success: true, active: nextValue === 1 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao alterar regra." });
  }
});

app.delete("/api/rules/:id", authMiddleware, async (req, res) => {
  try {
    await run(`DELETE FROM invoices WHERE rule_id = ?`, [req.params.id]);
    await run(`DELETE FROM billing_rules WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao excluir regra." });
  }
});

app.get("/api/ledger", authMiddleware, async (req, res) => {
  try {
    const rows = await all(
      `
        SELECT
          le.*,
          c.name AS client_name
        FROM ledger_entries le
        JOIN clients c ON c.id = le.client_id
        ORDER BY datetime(le.entry_date) DESC, le.created_at DESC
      `
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao listar lançamentos." });
  }
});

app.post("/api/ledger", authMiddleware, async (req, res) => {
  try {
    const { clientId, description, amount, entryDate } = req.body || {};

    if (!clientId || !description || !amount) {
      return res.status(400).json({ error: "Campos obrigatórios não preenchidos." });
    }

    const client = await get(`SELECT id FROM clients WHERE id = ?`, [clientId]);
    if (!client) {
      return res.status(404).json({ error: "Cliente não encontrado." });
    }

    const ledger = {
      id: randomId(),
      client_id: clientId,
      description: String(description).trim(),
      amount: Number(amount),
      entry_date: entryDate ? new Date(entryDate).toISOString() : new Date().toISOString(),
      billed_invoice_id: null,
      created_at: new Date().toISOString()
    };

    await run(
      `
        INSERT INTO ledger_entries (
          id, client_id, description, amount, entry_date, billed_invoice_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        ledger.id,
        ledger.client_id,
        ledger.description,
        ledger.amount,
        ledger.entry_date,
        ledger.billed_invoice_id,
        ledger.created_at
      ]
    );

    res.status(201).json(ledger);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao lançar saldo." });
  }
});

app.get("/api/open-balances", authMiddleware, async (req, res) => {
  try {
    const rows = await getOpenBalancesByClient();
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao buscar saldos." });
  }
});

app.get("/api/invoices", authMiddleware, async (req, res) => {
  try {
    await normalizeInvoicesStatus();
    const invoices = await getInvoicesWithClient(req.query);
    res.json(invoices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao listar faturas." });
  }
});

app.post("/api/invoices/generate", authMiddleware, async (req, res) => {
  try {
    await generateInvoicesUpToToday();
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao gerar cobranças." });
  }
});

app.patch("/api/invoices/:id/pay", authMiddleware, async (req, res) => {
  try {
    const invoice = await get(`SELECT * FROM invoices WHERE id = ?`, [req.params.id]);

    if (!invoice) {
      return res.status(404).json({ error: "Fatura não encontrada." });
    }

    await run(
      `UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`,
      [new Date().toISOString(), req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao pagar fatura." });
  }
});

app.get("/api/invoices/:id/whatsapp-link", authMiddleware, async (req, res) => {
  try {
    const invoice = await get(
      `
        SELECT i.*, c.name AS client_name, c.phone AS client_phone
        FROM invoices i
        JOIN clients c ON c.id = i.client_id
        WHERE i.id = ?
      `,
      [req.params.id]
    );

    if (!invoice) {
      return res.status(404).json({ error: "Fatura não encontrada." });
    }

    if (!invoice.client_phone) {
      return res.status(400).json({ error: "Cliente sem telefone." });
    }

    const phone = normalizePhoneBR(invoice.client_phone);
    const text = [
      `Olá, ${invoice.client_name}!`,
      `Cobrança: ${invoice.description}`,
      `Valor: ${formatCurrencyBR(invoice.amount)}`,
      `Vencimento: ${formatDateBR(invoice.due_date)}`
    ].join("\n");

    res.json({
      link: `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao gerar link do WhatsApp." });
  }
});

app.post("/api/invoices/:id/send-email", authMiddleware, async (req, res) => {
  try {
    const result = await sendInvoiceEmail(req.params.id);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message || "Falha ao enviar email." });
  }
});

app.get("/api/dashboard", authMiddleware, async (req, res) => {
  try {
    await normalizeInvoicesStatus();
    const summary = await getDashboardSummary(req.query);
    res.json(summary);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao carregar dashboard." });
  }
});

app.get("/api/reports/invoices.csv", authMiddleware, async (req, res) => {
  try {
    const invoices = await getInvoicesWithClient(req.query);

    const lines = [
      ["Cliente", "Descricao", "Valor", "Vencimento", "Status"].map(escapeCsv).join(",")
    ];

    for (const invoice of invoices) {
      lines.push(
        [
          invoice.client_name,
          invoice.description,
          Number(invoice.amount).toFixed(2),
          formatDateBR(invoice.due_date),
          invoice.status
        ].map(escapeCsv).join(",")
      );
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=relatorio-cobrancas.csv");
    res.send("\uFEFF" + lines.join("\n"));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao exportar CSV." });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    const users = await get(`SELECT COUNT(*) AS total FROM users`);
    res.json({
      ok: true,
      users: Number(users?.total || 0),
      now: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function boot() {
  try {
    await initDb();
    await seedDefaultAdmin();
    await generateInvoicesUpToToday();
    startScheduler(generateInvoicesUpToToday);

    app.listen(PORT, () => {
      console.log(`Servidor rodando em http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Erro ao iniciar aplicação:", error);
    process.exit(1);
  }
}

boot();