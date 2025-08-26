const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio usa form-encoded

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

    CREATE TABLE IF NOT EXISTS manutencoes (
      id SERIAL PRIMARY KEY,
      equipamento TEXT NOT NULL,
      operacao TEXT NOT NULL,
      descricao TEXT,
      fotos TEXT[],
      criado_por TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_manut_enc ON manutencoes (equipamento, operacao);
  `);
  console.log("Tabelas prontas ✅");
}

// ====== helpers manutenção ======
function normalize(s) { return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

function extractIntent(text) {
  // Heurística simples para MVP: pega uma operação conhecida e tenta detectar o equipamento (modelo + marca)
  const t = normalize(text);
  // operações comuns
  const OPS = [
    "troca de rolamento","troca do rolamento","rolamento",
    "troca de correia","correia",
    "troca de oleo","oleo","troca de óleo",
    "troca de filtro","filtro",
    "bateria","pastilha","sapata","corrente","mastro"
  ];
  let operacao = OPS.find(op => t.includes(op)) || "";
  if (!operacao && t.startsWith("troca de ")) {
    // pega as 2-3 palavras após "troca de"
    const after = t.replace(/^troca de\s+/, "");
    operacao = "troca de " + after.split(/\s+/).slice(0, 2).join(" ");
  }

  // equipamento: tenta capturar MODELO + MARCA (últimas 2-3 palavras)
  // exemplo: "rre160hcc toyota"
  const tokens = t.split(/\s+/).filter(Boolean);
  let equipamento = "";
  const knownBrands = ["toyota","hyster","yale","jungheinrich","crown","linde","still","komatsu","mitsubishi","tcm","doosan"];
  const brand = tokens.find(w => knownBrands.includes(w));
  if (brand) {
    // pega algo que pareça modelo antes da marca (letras/números/traço)
    const idx = tokens.lastIndexOf(brand);
    const maybeModel = tokens.slice(Math.max(0, idx-1), idx).join(" ").toUpperCase();
    equipamento = ((maybeModel || "").trim() + " " + brand).trim();
  } else {
    // fallback: as últimas 2-3 palavras
    equipamento = tokens.slice(-2).join(" ");
  }

  // saneamento
  operacao = operacao.trim();
  equipamento = equipamento.trim();
  return { operacao, equipamento };
}

async function searchManutencoes({ operacao, equipamento }) {
  // busca flexível com ILIKE
  const op = operacao ? `%${operacao}%` : "%";
  const eq = equipamento ? `%${equipamento}%` : "%";
  const { rows } = await pool.query(
    `SELECT * FROM manutencoes
     WHERE operacao ILIKE $1 AND equipamento ILIKE $2
     ORDER BY created_at DESC
     LIMIT 5;`,
    [op, eq]
  );
  return rows;
}

async function insertManutencao({ operacao, equipamento, descricao, fotos, criado_por }) {
  const { rows } = await pool.query(
    `INSERT INTO manutencoes (operacao, equipamento, descricao, fotos, criado_por)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *;`,
    [operacao, equipamento, descricao || null, fotos || [], criado_por || null]
  );
  return rows[0];
}

// ====== HEALTH ======
app.get("/health", (_, res) => res.json({ ok: true }));

// ====== TWILIO WEBHOOK (texto + mídia) ======
app.post("/twilio/webhook", async (req, res) => {
  try {
    const body = req.body.Body || "";
    const from = (req.body.From || "").replace("whatsapp:", "");
    const numMedia = Number(req.body.NumMedia || 0);
    console.log("TWILIO IN:", { From: from, Body: body, NumMedia: numMedia });

    // Se vier MÍDIA: tratamos como CADASTRO/ATUALIZAÇÃO
    if (numMedia > 0) {
      // colete as URLs das mídias (Twilio envia MediaUrl0..MediaUrlN)
      const fotos = [];
      for (let i = 0; i < Math.min(numMedia, 10); i++) {
        const url = req.body[`MediaUrl${i}`];
        const ctype = req.body[`MediaContentType${i}`] || "";
        if (url && ctype.startsWith("image/")) fotos.push(url);
      }

      const { operacao, equipamento } = extractIntent(body);
      if (!operacao || !equipamento) {
        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>Para cadastrar, envie *foto(s)* junto com um texto contendo a operação e o equipamento. Ex.: "troca de rolamento RRE160HCC Toyota"</Message></Response>`);
      }

      const saved = await insertManutencao({
        operacao, equipamento,
        descricao: body,
        fotos,
        criado_por: from
      });

      res.set("Content-Type", "text/xml");
      return res.send(
        `<Response><Message>✅ Procedimento salvo:
Operação: ${saved.operacao}
Equipamento: ${saved.equipamento}
Fotos: ${saved.fotos.length}</Message></Response>`
      );
    }

    // Sem mídia → CONSULTA
    const q = extractIntent(body);
    if (!q.operacao && !q.equipamento) {
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>Me diga o que precisa. Ex.: "troca de rolamento RRE160HCC Toyota".
Se quiser *cadastrar* um procedimento novo, envie *foto(s)* + a frase acima.</Message></Response>`);
    }

    const results = await searchManutencoes(q);
    if (results.length === 0) {
      res.set("Content-Type", "text/xml");
      return res.send(
        `<Response><Message>Não encontrei "${q.operacao || "operação"}" para "${q.equipamento || "equipamento"}".
Você pode *cadastrar* enviando foto(s) + o texto da operação/equipamento.</Message></Response>`
      );
    }

    // Monta resposta: envia 1º registro como texto + até 3 fotos
    const r = results[0];
    const descricao = r.descricao || "(sem descrição)";
    const header = `🔧 Procedimento encontrado
Operação: ${r.operacao}
Equipamento: ${r.equipamento}
Descrição: ${descricao}`;

    // TwiML: podemos mandar texto + imagens (uma mensagem por vez; enviamos uma com texto e outra com mídias)
    let twiml = `<Response><Message>${header}</Message>`;
    if (Array.isArray(r.fotos)) {
      const fotos = r.fotos.slice(0, 5); // limite por segurança
      if (fotos.length > 0) {
        // Uma nova mensagem só com mídias (Twilio aceita múltiplos <Media>)
        twiml += `<Message>`;
        for (const f of fotos) twiml += `<Media>${f}</Media>`;
        twiml += `</Message>`;
      }
    }
    twiml += `</Response>`;

    res.set("Content-Type", "text/xml");
    return res.send(twiml);

  } catch (e) {
    console.error("twilio webhook error", e);
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>Erro temporário no assistente. Tente novamente em instantes.</Message></Response>`);
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Servidor rodando na porta", PORT);
  try { await ensureTables(); } catch (e) { console.error(e); }
});
