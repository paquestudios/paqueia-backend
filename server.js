const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =====================================================
// 🔧 CHAVES DE API (configurar no Render como env vars)
// =====================================================
const GROQ_KEY_1     = process.env.GROQ_KEY_1     || '';
const GROQ_KEY_2     = process.env.GROQ_KEY_2     || '';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
// =====================================================

const MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct', // 1º: melhor (visão + texto)
  'llama-3.3-70b-versatile',                   // 2º: melhor texto
  'deepseek-r1-distill-llama-70b',             // 3º: raciocínio
  'qwen-qwq-32b',                              // 4º: bom geral
  'gemma2-9b-it',                              // 5º: leve
  'llama-3.1-8b-instant',                      // 6º: mais rápido
];

const FETCH_TIMEOUT_MS = 15000; // 15s timeout em todas as chamadas externas

// =====================================================
// ⏱️ HELPER: fetch com timeout
// =====================================================
async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================
// 🔑 KEYS DISPONÍVEIS (apenas as que foram configuradas)
// =====================================================
function getKeys() {
  const keys = [];
  if (GROQ_KEY_1) keys.push({ key: GROQ_KEY_1, nome: 'KEY_1' });
  if (GROQ_KEY_2) keys.push({ key: GROQ_KEY_2, nome: 'KEY_2' });
  return keys;
}

// =====================================================
// 🔍 PESQUISA TAVILY
// =====================================================
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) {
    console.log('[Tavily] Chave não configurada — pesquisa desativada.');
    return null;
  }
  try {
    console.log(`[Tavily] Buscando: "${query}"`);
    const res = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query,
          search_depth: 'basic',
          max_results: 5,
          include_answer: true
        })
      },
      10000 // 10s para Tavily
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[Tavily] Erro HTTP ${res.status}:`, errText);
      return null;
    }

    const data = await res.json();

    if (!data.results || !data.results.length) {
      console.log('[Tavily] Nenhum resultado encontrado.');
      return null;
    }

    console.log(`[Tavily] ${data.results.length} resultado(s) encontrado(s).`);

    let contexto = '';
    if (data.answer) {
      contexto += `Resumo: ${data.answer}\n\n`;
    }
    contexto += data.results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
      .join('\n\n');

    return contexto;
  } catch (e) {
    if (e.name === 'AbortError') {
      console.error('[Tavily] Timeout — pesquisa demorou demais.');
    } else {
      console.error('[Tavily] Exceção:', e.message);
    }
    return null;
  }
}

// Detecta se a mensagem precisa de informações da web
function precisaPesquisar(messages) {
  const ultima = messages[messages.length - 1];
  const texto = (typeof ultima.content === 'string'
    ? ultima.content
    : Array.isArray(ultima.content)
      ? ultima.content.map(c => c.text || '').join(' ')
      : ''
  ).toLowerCase();

  const palavrasChave = [
    'hoje', 'agora', 'atual', 'atualmente', 'recente', 'recentes',
    'notícia', 'noticia', 'notícias', 'noticias', 'últimas', 'ultimas',
    'último', 'ultima', 'novidade', 'novidades',
    '2024', '2025', '2026',
    'preço', 'preco', 'valor', 'cotação', 'cotacao', 'câmbio', 'cambio',
    'clima', 'tempo', 'previsão', 'previsao',
    'quem ganhou', 'resultado', 'placar', 'jogo', 'partida', 'campeonato',
    'lançamento', 'lancamento', 'estreia', 'saiu',
    'quem é', 'quem e', 'o que é', 'o que e', 'como está', 'como esta',
    'o que está', 'o que esta', 'o que aconteceu', 'acontecendo',
    'agência', 'agencia', 'governo', 'eleição', 'eleicao', 'presidente',
    'pesquisa', 'busca', 'procura', 'encontra', 'latest', 'news'
  ];

  const precisar = palavrasChave.some(p => texto.includes(p));
  if (precisar) console.log('[Pesquisa] Detectada necessidade de pesquisa web.');
  return precisar;
}

// =====================================================
// 💬 ROTA PRINCIPAL DE CHAT
// =====================================================
app.post('/chat', async (req, res) => {
  const { messages, uid } = req.body;

  if (!messages || !uid) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  const keys = getKeys();
  if (!keys.length) {
    return res.status(500).json({ error: 'Nenhuma chave de API configurada.' });
  }

  console.log(`[Chat] uid=${uid} keys disponíveis=${keys.map(k => k.nome).join(', ')}`);

  // Pesquisa Tavily se necessário
  let mensagensFinais = messages;
  let usouTavily = false;

  if (precisaPesquisar(messages)) {
    const ultima = messages[messages.length - 1];
    const query = typeof ultima.content === 'string'
      ? ultima.content
      : Array.isArray(ultima.content)
        ? ultima.content.map(c => c.text || '').join(' ')
        : '';

    const resultado = await tavilySearch(query);

    if (resultado) {
      usouTavily = true;
      const extras = `\n\n[INFORMAÇÕES ATUAIS DA WEB — use esses dados para responder com precisão]\n${resultado}\n[FIM DAS INFORMAÇÕES DA WEB]`;

      const systemMsg = mensagensFinais.find(m => m.role === 'system');
      if (systemMsg) {
        mensagensFinais = mensagensFinais.map(m =>
          m.role === 'system' ? { ...m, content: m.content + extras } : m
        );
      } else {
        mensagensFinais = [{ role: 'system', content: extras.trim() }, ...mensagensFinais];
      }
      console.log('[Chat] Contexto Tavily injetado no system.');
    }
  }

  // =====================================================
  // 🔄 LOOPING CIRCULAR: KEY_1 (6 modelos) → KEY_2 (6 modelos) → KEY_1 ...
  // Tenta todos os modelos da KEY_1; se todos falharem, vai pra KEY_2.
  // Se KEY_2 também falhar toda, volta pra KEY_1 — e assim por diante.
  // Total de tentativas: keys.length * MODELS.length * MAX_ROUNDS
  // =====================================================
  const MAX_ROUNDS = 2; // quantas voltas completas no ciclo antes de desistir
  let keyIndex = 0;
  let tentativas = 0;
  const totalMax = keys.length * MODELS.length * MAX_ROUNDS;

  while (tentativas < totalMax) {
    const { key, nome } = keys[keyIndex % keys.length];

    for (const model of MODELS) {
      tentativas++;
      try {
        console.log(`[Chat] [${nome}] Tentando ${model} (tentativa ${tentativas})`);

        const response = await fetchWithTimeout(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
              model,
              messages: mensagensFinais,
              max_tokens: 1024,
              temperature: 0.7
            })
          }
        );

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          const errMsg = err?.error?.message || `Erro HTTP ${response.status}`;
          console.warn(`[Chat] [${nome}] ${model} falhou (${response.status}): ${errMsg}`);
          continue; // próximo modelo
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '…';

        console.log(`[Chat] ✅ Sucesso com [${nome}] ${model}. usouTavily=${usouTavily}`);

        return res.json({ reply, model, keyUsada: nome, usouTavily });

      } catch (e) {
        if (e.name === 'AbortError') {
          console.error(`[Chat] [${nome}] Timeout no modelo ${model}`);
        } else {
          console.error(`[Chat] [${nome}] Erro no modelo ${model}:`, e.message);
        }
        // continua pro próximo modelo
      }
    }

    // Todos os 6 modelos desta key falharam → troca de key
    keyIndex++;
    console.warn(`[Chat] Todos os modelos de [${nome}] falharam. Trocando para próxima key...`);
  }

  console.error('[Chat] Todas as keys e modelos falharam.');
  return res.status(500).json({
    error: 'Todos os modelos atingiram o limite. Tente novamente em alguns minutos!'
  });
});

// =====================================================
// 🩺 ROTA DE SAÚDE / DIAGNÓSTICO
// =====================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PaqueIA Backend',
    tavily: !!TAVILY_API_KEY,
    groqKey1: !!GROQ_KEY_1,
    groqKey2: !!GROQ_KEY_2,
    models: MODELS,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// Rota de diagnóstico de Tavily (para testar manualmente)
app.get('/test-tavily', async (req, res) => {
  const query = req.query.q || 'notícias do Brasil hoje';
  const resultado = await tavilySearch(query);
  res.json({
    query,
    tavilyKey: !!TAVILY_API_KEY,
    resultado: resultado ? resultado.substring(0, 800) + '…' : null,
    tavilyOk: !!resultado
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ PaqueIA Backend rodando na porta ${PORT}`));
