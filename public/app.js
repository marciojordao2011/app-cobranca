const token = localStorage.getItem("token");

if (!token) {
  window.location.href = "/";
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`
};

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(Number(value || 0));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR").format(new Date(value));
}

function ruleLabel(value) {
  if (value === "monthly") return "Mensal";
  if (value === "weekly") return "Semanal";
  if (value === "yearly") return "Anual";
  return value;
}

function invoiceBadge(status) {
  if (status === "paid") return "badge-paid";
  if (status === "late") return "badge-late";
  return "badge-pending";
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Erro na requisição.");
  }

  return data;
}

document.getElementById("logoutBtn").onclick = () => {
  localStorage.clear();
  window.location.href = "/";
};

document.getElementById("generateBtn").onclick = async () => {
  try {
    const result = await api("/api/invoices/generate", { method: "POST" });
    await loadAll();
    alert(result.message || "Cobranças verificadas.");
  } catch (error) {
    alert(error.message);
  }
};

document.getElementById("exportCsvBtn").onclick = () => {
  window.open("/api/reports/invoices.csv", "_blank");
};

async function loadAll() {
  const [clients, invoices, rules, balances, ledger, dashboard] = await Promise.all([
    api("/api/clients"),
    api("/api/invoices"),
    api("/api/rules"),
    api("/api/open-balances"),
    api("/api/ledger"),
    api("/api/dashboard")
  ]);

  renderClientSelects(clients);
  renderInvoices(invoices);
  renderRules(rules);
  renderBalances(balances);
  renderLedger(ledger);
  renderStats(dashboard);
}

function renderStats(dashboard) {
  document.getElementById("openBalanceStat").textContent = formatCurrency(dashboard.totalOpenBalance);
  document.getElementById("toReceiveStat").textContent = formatCurrency(dashboard.totalToReceive);
  document.getElementById("receivedStat").textContent = formatCurrency(dashboard.totalReceived);
  document.getElementById("interestStat").textContent = formatCurrency(dashboard.totalInterest);
  document.getElementById("partialStat").textContent = dashboard.totalPartial;
  document.getElementById("lateStat").textContent = dashboard.totalLate;
}

function renderClientSelects(clients) {
  const options = clients.length
    ? clients.map(client => `<option value="${client.id}">${client.name}</option>`).join("")
    : `<option value="">Cadastre um cliente primeiro</option>`;

  document.getElementById("ruleClient").innerHTML = options;
  document.getElementById("ledgerClient").innerHTML = options;
}

function renderInvoices(invoices) {
  const list = document.getElementById("invoiceList");

  if (!invoices.length) {
    list.innerHTML = `<div class="empty">Nenhuma fatura gerada.</div>`;
    return;
  }

  list.innerHTML = invoices.map(invoice => `
    <div class="invoice-card ${invoice.status === "late" ? "invoice-card-late" : ""}">
      <div class="list-item">
        <div>
          <strong>${invoice.client_name}</strong>
          <div class="muted">${invoice.description}</div>
          <div class="muted">
            Vencimento: ${formatDate(invoice.due_date)}
            ${invoice.late_days > 0 ? ` · ATRASADA HÁ ${invoice.late_days} DIA(S)` : ""}
          </div>
        </div>

        <div class="item-right">
          <div class="money-group">
            <span>Original: ${formatCurrency(invoice.base_amount)}</span>
            <span>Juros: ${formatCurrency(invoice.interest_amount)}</span>
            <span>Total: ${formatCurrency(invoice.total_amount)}</span>
            <span>Pago: ${formatCurrency(invoice.paid_total)}</span>
            <strong>Saldo: ${formatCurrency(invoice.balance_due)}</strong>
          </div>

          <span class="badge ${invoiceBadge(invoice.status)}">${invoice.status}</span>

          <div class="row-actions">
            ${invoice.balance_due > 0 ? `<button class="btn btn-small btn-primary" onclick="receiveFull('${invoice.id}')">Receber total</button>` : ""}
            ${invoice.balance_due > 0 ? `<button class="btn btn-small btn-warning" onclick="receivePartial('${invoice.id}')">Receber parcial</button>` : ""}
            <button class="btn btn-small btn-secondary" onclick="toggleDetails('${invoice.id}')">Detalhes</button>
            <button class="btn btn-small btn-whatsapp" onclick="sendWhats('${invoice.id}')">WhatsApp</button>
            <button class="btn btn-small btn-secondary" onclick="sendEmail('${invoice.id}')">Email</button>
          </div>
        </div>
      </div>

      <div id="details-${invoice.id}" class="invoice-details hidden"></div>
    </div>
  `).join("");
}

function renderRules(rules) {
  const list = document.getElementById("ruleList");

  if (!rules.length) {
    list.innerHTML = `<div class="empty">Nenhuma regra cadastrada.</div>`;
    return;
  }

  list.innerHTML = rules.map(rule => `
    <div class="list-item">
      <div>
        <strong>${rule.client_name}</strong>
        <div class="muted">${rule.description}</div>
        <div class="muted">
          ${ruleLabel(rule.frequency)} · dia ${rule.due_day}
          · juros diário ${(Number(rule.daily_interest_rate) * 100).toFixed(2)}%
        </div>
        <div class="muted">Início: ${formatDate(rule.start_date)}</div>
      </div>
      <div class="item-right">
        <span class="badge ${rule.active ? "badge-active" : "badge-paused"}">
          ${rule.active ? "ativa" : "pausada"}
        </span>
        <button class="btn btn-small btn-secondary" onclick="toggleRule('${rule.id}')">
          ${rule.active ? "Pausar" : "Ativar"}
        </button>
      </div>
    </div>
  `).join("");
}

function renderBalances(balances) {
  const list = document.getElementById("balanceList");

  if (!balances.length) {
    list.innerHTML = `<div class="empty">Nenhum cliente.</div>`;
    return;
  }

  list.innerHTML = balances.map(balance => `
    <div class="list-item">
      <div><strong>${balance.client_name}</strong></div>
      <div class="item-right">
        <strong>${formatCurrency(balance.open_balance)}</strong>
        ${Number(balance.open_balance) > 0 ? `<button class="btn btn-small btn-secondary" onclick="generateNow('${balance.client_id}')">Cobrar agora</button>` : ""}
      </div>
    </div>
  `).join("");
}

function renderLedger(entries) {
  const list = document.getElementById("ledgerList");

  if (!entries.length) {
    list.innerHTML = `<div class="empty">Nenhum lançamento.</div>`;
    return;
  }

  list.innerHTML = entries.map(entry => `
    <div class="list-item">
      <div>
        <strong>${entry.client_name}</strong>
        <div class="muted">${entry.description}</div>
        <div class="muted">${formatDate(entry.entry_date)}</div>
      </div>
      <div class="item-right">
        <strong>${formatCurrency(entry.amount)}</strong>
        <span class="badge ${entry.billed_invoice_id ? "badge-billed" : "badge-open"}">
          ${entry.billed_invoice_id ? "faturado" : "aberto"}
        </span>
      </div>
    </div>
  `).join("");
}

document.getElementById("clientForm").onsubmit = async (e) => {
  e.preventDefault();

  try {
    await api("/api/clients", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("clientName").value,
        email: document.getElementById("clientEmail").value,
        phone: document.getElementById("clientPhone").value
      })
    });

    e.target.reset();
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
};

document.getElementById("ruleForm").onsubmit = async (e) => {
  e.preventDefault();

  try {
    await api("/api/rules", {
      method: "POST",
      body: JSON.stringify({
        clientId: document.getElementById("ruleClient").value,
        description: document.getElementById("ruleDescription").value,
        dueDay: Number(document.getElementById("ruleDueDay").value),
        frequency: document.getElementById("ruleFrequency").value,
        dailyInterestRate: Number(document.getElementById("ruleInterestRate").value || 0),
        startDate: document.getElementById("ruleStartDate").value || null
      })
    });

    e.target.reset();
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
};

document.getElementById("ledgerForm").onsubmit = async (e) => {
  e.preventDefault();

  try {
    await api("/api/ledger", {
      method: "POST",
      body: JSON.stringify({
        clientId: document.getElementById("ledgerClient").value,
        description: document.getElementById("ledgerDescription").value,
        amount: Number(document.getElementById("ledgerAmount").value),
        entryDate: document.getElementById("ledgerDate").value || null
      })
    });

    e.target.reset();
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
};

async function toggleDetails(invoiceId) {
  const box = document.getElementById(`details-${invoiceId}`);

  if (!box.classList.contains("hidden")) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  try {
    const details = await api(`/api/invoices/${invoiceId}/details`);

    const itemsHtml = details.items.length
      ? details.items.map(item => `
          <div class="detail-row">
            <span>${formatDate(item.entry_date)} · ${item.description}</span>
            <strong>${formatCurrency(item.amount)}</strong>
          </div>
        `).join("")
      : `<div class="empty">Sem lançamentos vinculados.</div>`;

    const paymentsHtml = details.payments.length
      ? details.payments.map(payment => `
          <div class="detail-row">
            <span>${formatDate(payment.payment_date)} · ${payment.method || "manual"}${payment.notes ? " · " + payment.notes : ""}</span>
            <strong>${formatCurrency(payment.amount)}</strong>
          </div>
        `).join("")
      : `<div class="empty">Nenhum pagamento registrado.</div>`;

    box.innerHTML = `
      <div class="details-grid">
        <div>
          <h4>Lançamentos da fatura</h4>
          ${itemsHtml}
        </div>
        <div>
          <h4>Pagamentos</h4>
          ${paymentsHtml}
        </div>
      </div>
    `;

    box.classList.remove("hidden");
  } catch (error) {
    alert(error.message);
  }
}

async function receiveFull(id) {
  try {
    await api(`/api/invoices/${id}/pay-full`, { method: "POST" });
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
}

async function receivePartial(id) {
  const amount = prompt("Digite o valor do recebimento parcial:");
  if (!amount) return;

  const notes = prompt("Observação do recebimento (opcional):") || "";

  try {
    await api(`/api/invoices/${id}/payments`, {
      method: "POST",
      body: JSON.stringify({
        amount: Number(amount),
        notes,
        method: "parcial"
      })
    });

    await loadAll();
  } catch (error) {
    alert(error.message);
  }
}

async function generateNow(clientId) {
  try {
    const result = await api(`/api/clients/${clientId}/generate-now`, {
      method: "POST"
    });
    await loadAll();
    alert(result.message);
  } catch (error) {
    alert(error.message);
  }
}

async function sendWhats(id) {
  try {
    const result = await api(`/api/invoices/${id}/whatsapp-link`);
    window.open(result.link, "_blank");
  } catch (error) {
    alert(error.message);
  }
}

async function sendEmail(id) {
  try {
    const result = await api(`/api/invoices/${id}/send-email`, { method: "POST" });
    alert(`Email enviado para ${result.to}`);
  } catch (error) {
    alert(error.message);
  }
}

async function toggleRule(id) {
  try {
    await api(`/api/rules/${id}/toggle`, { method: "PATCH" });
    await loadAll();
  } catch (error) {
    alert(error.message);
  }
}

window.toggleDetails = toggleDetails;
window.receiveFull = receiveFull;
window.receivePartial = receivePartial;
window.generateNow = generateNow;
window.sendWhats = sendWhats;
window.sendEmail = sendEmail;
window.toggleRule = toggleRule;

loadAll();