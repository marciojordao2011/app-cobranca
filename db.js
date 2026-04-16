const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
require("dotenv").config();

const dbPath = path.join(__dirname, "database.sqlite");
const db = new sqlite3.Database(dbPath);

function randomId() {
  return crypto.randomUUID();
}

function run(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      document TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS billing_rules (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      description TEXT NOT NULL,
      frequency TEXT NOT NULL,
      due_day INTEGER NOT NULL,
      daily_interest_rate REAL NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      entry_date TEXT NOT NULL,
      billed_invoice_id TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      description TEXT NOT NULL,
      base_amount REAL NOT NULL,
      interest_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL,
      due_date_key TEXT NOT NULL,
      status TEXT NOT NULL,
      paid_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      ledger_entry_id TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      method TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_rule_due
    ON invoices(rule_id, due_date_key)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_ledger_client
    ON ledger_entries(client_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_ledger_billed
    ON ledger_entries(billed_invoice_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
    ON invoice_items(invoice_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_payments_invoice
    ON payments(invoice_id)
  `);
}

async function seedDefaultAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@admin.com";
  const password = process.env.ADMIN_PASSWORD || "123456";
  const name = process.env.ADMIN_NAME || "Administrador";

  const user = await get(`SELECT * FROM users WHERE email = ?`, [email]);

  if (user) {
    console.log("Admin já existe");
    return;
  }

  const hash = bcrypt.hashSync(password, 10);

  await run(
    `INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    [randomId(), name, email, hash, new Date().toISOString()]
  );

  console.log("Admin criado:", email);
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
  seedDefaultAdmin,
  randomId
};