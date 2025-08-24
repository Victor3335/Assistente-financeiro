const express = require("express");
const { Pool } = require("pg");

const app = express();
// Twilio manda x-www-form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== DB ======
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: { rejectUnauthorized: false }
});

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      wa_number TEXT UNIQUE,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT CHECK (type IN ('expense','income')) NOT NULL DEFAULT 'expense',
      value_cents INTEGER NOT NULL,
      category TEXT,
      note TEXT,
      occurred_at DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, occurred_at);
  `);
  console.log("Tabelas prontas ✅");
}

async function upsertUser(waNumber) {
  const { rows } = await pool.query(
    `INSERT INTO users (wa_number) VALUES ($1)
     ON CONFLICT (wa_number) DO UPDATE SET wa_number = EXCLUDED.wa_number
     RETURNING *;`,
    [waNumber]
  );
  return rows[0];
}

async function insertTx(userId, { type, value_cents, category, note }) {
  await pool.query(
    `INSERT INTO transactions (user_id, type, value_cents, category, note, occurred_at)
     VALUES ($1,$2,$3,$4,$5, CURRENT_DATE);`,
    [userId, type, value_cents, category, note || null]
  );
}

async function getSummaryMTD(userId) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const pad = (n) => n.toString().padStart(2, "0");
  const f = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-${pad(first.getDate())}`;
  const n = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;

  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income' THEN value_cents END),0) as income,
       COALESCE(SUM(CASE WHEN type='expense' THEN value_cents END),0) as spent
     FROM transactions
     WHERE user_id=$1 AND occurred_at >= $2 AND occurred_at < $3;`,
    [userId, f, n]
  );
  const income = Number(rows[0].income || 0);
  const spent = Number(rows[0].spent || 0);
  return { income, spent, balance: income - spent };
}

// ====== NLU simples ======
function parseMoneyBR(text) {
  const m = (text || "").match(/(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const raw = m[1].replace(/\./g, "").replace(",", ".");
  const v = Number(raw);
  return isNaN(v) ? null : v;
}
function inferCategory(s) {
  const t = (s || "").toLowerCase();
  if (/mercado|supermercado|ifood|comida|restaurante|lanche/.test(t)) return "alimentação";
  if (/gasolina|combust/i.test(t)) return "combustível";
  if (/aluguel/.test(t)) return "moradia";
  if (/luz|energia/.test(t)) return "energia";
  if (/internet|claro|vivo|tim|net/.test(t)) return "internet";
  return "outros";
}

// ====== HEALTH ======
app.get("/health", (_, res) => res.json({ ok: true }));

// ====== TWILIO WEBHOOK (WhatsApp Sandbox) ======
app.post("/twilio/webhook", async (req, res) => {
  try {
    console.log("TWILIO IN:", { From: req.body.From, Body: req.body.Body });

    const body = req.body.Body || "";
    const from = (req.body.From || "").replace("whatsapp:", "");
    if (!from) {
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Sem remetente</Message></Response>`);
    }

    const user = await upsertUser(from);
    const text = body.trim().toLowerCase();

    const isDespesa   = /(gastei|paguei|compra|despesa)/.test(text);
    const isSaldo     = /\b(saldo|quanto gastei|resumo|extrato)\b/.test(text);
    const isRelatorio = /relat[óo]rio/.test(text);
    const isPix       = /\bpix\b/.test(text);

    let reply = 'Comandos: "gastei 35 no mercado", "saldo", "relatório", "pix 120 barbeiro"';

    if (isDespesa) {
      const v = parseMoneyBR(text);
      if (!v) {
        reply = 'Não entendi o valor. Ex.: "gastei 47,90 no mercado"';
      } else {
        const cat = inferCategory(text);
        await insertTx(user.id, { type: "expense", value_cents: Math.round(v * 100), category: cat, note: body });
        reply = `Anotado ✅ Despesa de R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} em ${cat}.`;
      }
    } else if (isSaldo || isRelatorio) {
      const s = await getSummaryMTD(user.id);
      const income = (s.income / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const spent  = (s.spent  / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const bal    = (s.balance/ 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      reply = `Resumo do mês:\nReceitas: ${income}\nDespesas: ${spent}\nSaldo: ${bal}`;
    } else if (isPix) {
      const v = parseMoneyBR(text);
      reply = v
        ? `Pronto! Link de cobrança (simulada): https://pix.local/charge/${Math.random().toString(36).slice(2,8)}?v=${v}`
        : 'Informe o valor. Ex.: "pix 120 barbeiro"';
    }

    // >>> Respondendo DIRETO ao Twilio via TwiML (sem chamar outra API)
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (e) {
    console.error("twilio webhook error", e);
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>Erro temporário. Tente novamente.</Message></Response>`);
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Servidor rodando na porta", PORT);
  try { await ensureTables(); } catch (e) { console.error(e); }
});
