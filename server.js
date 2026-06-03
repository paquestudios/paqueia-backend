const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// =====================================================
// 🔧 CHAVES DE API (configurar no Render como env vars)
// =====================================================
const CEREBRAS_KEY_1   = process.env.CEREBRAS_KEY_1   || '';
const CEREBRAS_KEY_2   = process.env.CEREBRAS_KEY_2   || '';
const CEREBRAS_KEY_3   = process.env.CEREBRAS_KEY_3   || '';
const CEREBRAS_KEY_4   = process.env.CEREBRAS_KEY_4   || '';
const CEREBRAS_KEY_5   = process.env.CEREBRAS_KEY_5   || '';

const TAVILY_KEY_1 = process.env.TAVILY_KEY_1 || '';
const TAVILY_KEY_2 = process.env.TAVILY_KEY_2 || '';
const TAVILY_KEY_3 = process.env.TAVILY_KEY_3 || '';
const TAVILY_KEY_4 = process.env.TAVILY_KEY_4 || '';
const TAVILY_KEY_5 = process.env.TAVILY_KEY_5 || '';
const TAVILY_KEY_6 = process.env.TAVILY_KEY_6 || '';
const TAVILY_KEY_7 = process.env.TAVILY_KEY_7 || '';
// =====================================================

const MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct', // 1º: melhor (visão + texto)
  'llama-3.3-70b-versatile',                   // 2º: melhor texto
  'deepseek-r1-distill-llama-70b',             // 3º: raciocínio
  'qwen-qwq-32b',                              // 4º: bom geral
  'gemma2-9b-it',                              // 5º: leve
  'llama-3.1-8b-instant',                      // 6º: mais rápido
];

const FETCH_TIMEOUT_MS = 15000;

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
// 🔑 CEREBRAS KEYS DISPONÍVEIS
// =====================================================
function getCerebrasKeys() {
  const keys = [];
  if (CEREBRAS_KEY_1) keys.push({ key: CEREBRAS_KEY_1, nome: 'KEY_1' });
  if (CEREBRAS_KEY_2) keys.push({ key: CEREBRAS_KEY_2, nome: 'KEY_2' });
  if (CEREBRAS_KEY_3) keys.push({ key: CEREBRAS_KEY_3, nome: 'KEY_3' });
  if (CEREBRAS_KEY_4) keys.push({ key: CEREBRAS_KEY_4, nome: 'KEY_4' });
  if (CEREBRAS_KEY_5) keys.push({ key: CEREBRAS_KEY_5, nome: 'KEY_5' });
  return keys;
}

// =====================================================
// 🔑 TAVILY KEYS DISPONÍVEIS
// =====================================================
function getTavilyKeys() {
  const keys = [];
  if (TAVILY_KEY_1) keys.push(TAVILY_KEY_1);
  if (TAVILY_KEY_2) keys.push(TAVILY_KEY_2);
  if (TAVILY_KEY_3) keys.push(TAVILY_KEY_3);
  if (TAVILY_KEY_4) keys.push(TAVILY_KEY_4);
  if (TAVILY_KEY_5) keys.push(TAVILY_KEY_5);
  if (TAVILY_KEY_6) keys.push(TAVILY_KEY_6);
  if (TAVILY_KEY_7) keys.push(TAVILY_KEY_7);
  return keys;
}

let tavilyKeyIndex = 0; // looping circular do Tavily

// =====================================================
// 🔍 PESQUISA TAVILY COM LOOPING
// =====================================================
async function tavilySearch(query) {
  const keys = getTavilyKeys();
  if (!keys.length) {
    console.log('[Tavily] Nenhuma chave configurada — pesquisa desativada.');
    return null;
  }

  // Tenta cada key em sequência, começando da atual
  for (let i = 0; i < keys.length; i++) {
    const idx = (tavilyKeyIndex + i) % keys.length;
    const apiKey = keys[idx];

    try {
      console.log(`[Tavily] Buscando com KEY_${idx + 1}: "${query}"`);
      const res = await fetchWithTimeout(
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            search_depth: 'basic',
            max_results: 5,
            include_answer: true
          })
        },
        10000
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[Tavily] KEY_${idx + 1} falhou (${res.status}): ${errText}`);
        tavilyKeyIndex = (idx + 1) % keys.length; // avança pra próxima
        continue;
      }

      const data = await res.json();
      if (!data.results || !data.results.length) {
        console.log('[Tavily] Nenhum resultado encontrado.');
        return null;
      }

      console.log(`[Tavily] ✅ Sucesso com KEY_${idx + 1}. ${data.results.length} resultado(s).`);

      let contexto = '';
      if (data.answer) contexto += `Resumo: ${data.answer}\n\n`;
      contexto += data.results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
        .join('\n\n');

      return contexto;

    } catch (e) {
      if (e.name === 'AbortError') {
        console.error(`[Tavily] KEY_${idx + 1} timeout.`);
      } else {
        console.error(`[Tavily] KEY_${idx + 1} erro:`, e.message);
      }
      tavilyKeyIndex = (idx + 1) % keys.length;
    }
  }

  console.error('[Tavily] Todas as keys falharam.');
  return null;
}

// =====================================================
// 🧠 DETECTA SE PRECISA PESQUISAR NA WEB
// =====================================================
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
    'governo', 'eleição', 'eleicao', 'presidente',
    'pesquisa', 'busca', 'latest', 'news'
  ];

  const precisar = palavrasChave.some(p => texto.includes(p));
  if (precisar) console.log('[Pesquisa] Necessidade de pesquisa web detectada.');
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

  const cerebrasKeys = getCerebrasKeys();
  if (!cerebrasKeys.length) {
    return res.status(500).json({ error: 'Nenhuma chave Cerebras configurada.' });
  }

  console.log(`[Chat] uid=${uid} cerebrasKeys=${cerebrasKeys.map(k => k.nome).join(', ')}`);

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
      console.log('[Chat] Contexto Tavily injetado.');
    }
  }

  // =====================================================
  // 🔄 LOOPING CIRCULAR CEREBRAS: KEY_1→KEY_2→...→KEY_8→KEY_1...
  // Tenta todos os 6 modelos de cada key antes de trocar.
  // =====================================================
  const MAX_ROUNDS = 999;
  let keyIndex = 0;
  let tentativas = 0;
  const totalMax = cerebrasKeys.length * MODELS.length * MAX_ROUNDS;

  while (tentativas < totalMax) {
    const { key, nome } = cerebrasKeys[keyIndex % cerebrasKeys.length];

    for (const model of MODELS) {
      tentativas++;
      try {
        console.log(`[Chat] [${nome}] Tentando ${model} (tentativa ${tentativas})`);

        const response = await fetchWithTimeout(
          'https://api.cerebras.ai/v1/chat/completions',
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
          continue;
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
      }
    }

    keyIndex++;
    console.warn(`[Chat] Todos os modelos de [${nome}] falharam. Trocando key...`);
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
    cerebrasKey1: !!CEREBRAS_KEY_1,
    cerebrasKey2: !!CEREBRAS_KEY_2,
    cerebrasKey3: !!CEREBRAS_KEY_3,
    cerebrasKey4: !!CEREBRAS_KEY_4,
    cerebrasKey5: !!CEREBRAS_KEY_5,
    tavilyKey1: !!TAVILY_KEY_1,
    tavilyKey2: !!TAVILY_KEY_2,
    tavilyKey3: !!TAVILY_KEY_3,
    tavilyKey4: !!TAVILY_KEY_4,
    tavilyKey5: !!TAVILY_KEY_5,
    tavilyKey6: !!TAVILY_KEY_6,
    tavilyKey7: !!TAVILY_KEY_7,
    models: MODELS,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// Rota de teste Tavily
app.get('/test-tavily', async (req, res) => {
  const query = req.query.q || 'notícias do Brasil hoje';
  const resultado = await tavilySearch(query);
  res.json({
    query,
    tavilyKeys: getTavilyKeys().length,
    resultado: resultado ? resultado.substring(0, 800) + '…' : null,
    tavilyOk: !!resultado
  });
});


// =====================================================
// 🎵 ROTA DE MÚSICA — proxy para Pollinations
// =====================================================
app.post('/musica', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt obrigatório.' });

  try {
    console.log('[Música] Gerando:', prompt.substring(0, 80));
    const encoded = encodeURIComponent(prompt.substring(0, 300));
    const url = `https://audio.pollinations.ai/${encoded}`;

    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) throw new Error(`Pollinations retornou ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength < 1000) throw new Error('Áudio vazio ou inválido.');

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', buffer.byteLength);
    res.send(Buffer.from(buffer));
    console.log('[Música] ✅ Enviado', buffer.byteLength, 'bytes');
  } catch(e) {
    console.error('[Música] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// =====================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ PaqueIA Backend rodando na porta ${PORT}`));
