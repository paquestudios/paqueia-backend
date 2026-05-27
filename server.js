const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =====================================================
// 🔧 SUAS CHAVES (só visíveis aqui no servidor)
// =====================================================
const GROQ_KEY_PRO  = process.env.GROQ_KEY_PRO  || 'COLOQUE_SUA_CHAVE_PRO_AQUI';
const GROQ_KEY_FREE = process.env.GROQ_KEY_FREE || 'COLOQUE_SUA_CHAVE_FREE_AQUI';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
// =====================================================

const MODELS_PRO = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'llama-3.3-70b-versatile',
];
const MODELS_FREE = [
  'llama-3.1-8b-instant',
  'gemma2-9b-it',
];

// Contagem diária por usuário (em memória — reseta quando servidor reinicia)
const dailyCounts = {};

function getTodayKey(uid) {
  const today = new Date().toDateString();
  return `${uid}_${today}`;
}

function getCount(uid) {
  return dailyCounts[getTodayKey(uid)] || 0;
}

function incrementCount(uid) {
  const key = getTodayKey(uid);
  dailyCounts[key] = (dailyCounts[key] || 0) + 1;
}

// =====================================================
// 🔍 PESQUISA TAVILY
// =====================================================
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || !data.results.length) return null;
    return data.results.map(r => `- ${r.title}: ${r.content}`).join('\n');
  } catch (e) {
    console.error('Erro Tavily:', e.message);
    return null;
  }
}

// Detecta se a pergunta precisa de pesquisa na web
function precisaPesquisar(messages) {
  const ultima = messages[messages.length - 1];
  const texto = (typeof ultima.content === 'string' ? ultima.content : '').toLowerCase();
  const palavras = [
    'hoje', 'agora', 'atual', 'atualmente', 'recente', 'notícia', 'noticia',
    'último', 'ultima', 'novidade', '2024', '2025', '2026',
    'preço', 'preco', 'valor', 'cotação', 'cotacao', 'clima', 'tempo',
    'quem ganhou', 'resultado', 'jogo', 'partida', 'placar'
  ];
  return palavras.some(p => texto.includes(p));
}
// =====================================================

// Rota principal do chat
app.post('/chat', async (req, res) => {
  const { messages, uid, plano } = req.body;

  if (!messages || !uid) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  const PRO_DAILY_LIMIT = 50;
  const count = getCount(uid);
  const usePro = plano === 'pro' && count < PRO_DAILY_LIMIT;

  const apiKey = usePro ? GROQ_KEY_PRO : GROQ_KEY_FREE;
  const models = usePro ? MODELS_PRO : MODELS_FREE;
  const droppedToFree = plano === 'pro' && !usePro;

  // Verifica se precisa pesquisar e injeta resultado no contexto
  let mensagensFinais = messages;
  if (precisaPesquisar(messages)) {
    const ultima = messages[messages.length - 1];
    const query = typeof ultima.content === 'string' ? ultima.content : '';
    const resultado = await tavilySearch(query);
    if (resultado) {
      // Injeta os resultados como contexto extra no system
      const system = mensagensFinais.find(m => m.role === 'system');
      const extras = `\n\n[Resultados de pesquisa atuais para ajudar na resposta]\n${resultado}\n[Fim dos resultados]`;
      if (system) {
        mensagensFinais = mensagensFinais.map(m =>
          m.role === 'system' ? { ...m, content: m.content + extras } : m
        );
      } else {
        mensagensFinais = [{ role: 'system', content: extras }, ...mensagensFinais];
      }
    }
  }

  for (const model of models) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: mensagensFinais,
          max_tokens: 1024,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 429) continue;
        throw new Error(err?.error?.message || `Erro ${response.status}`);
      }

      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || '…';

      if (usePro) incrementCount(uid);

      return res.json({
        reply,
        model,
        droppedToFree,
        proCount: getCount(uid),
        proLimit: PRO_DAILY_LIMIT
      });

    } catch (e) {
      console.error(`Erro no modelo ${model}:`, e.message);
    }
  }

  res.status(500).json({ error: 'Limite atingido em todos os modelos. Tente mais tarde!' });
});

// Rota de saúde
app.get('/', (req, res) => res.send('PaqueIA Backend rodando ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
