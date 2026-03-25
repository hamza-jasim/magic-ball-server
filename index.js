import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const sessions = new Map();

function makeSystemPrompt(language = 'ar') {
  const isArabic = language === 'ar';
  return `You are the reasoning engine for a character guessing game similar to Akinator.

Rules:
- Ask exactly one short yes/no style question at a time.
- Allowed answers from user: yes, no, maybe, dont_know.
- After enough evidence, you may guess a famous person.
- If a guess was rejected, never repeat it.
- Prefer celebrities, athletes, singers, actors, politicians, historical figures, scientists, and Arab public figures when relevant.
- Output STRICT JSON only.

JSON format:
If asking question:
{"type":"question","text":"..."}
If making guess:
{"type":"guess","name":"...","confidence":0.0}

Language:
- If language is ar, write Arabic.
- If language is en, write English.

Tone:
- Friendly, concise, game-like.
- No explanation outside JSON.`;
}

function sessionMessages(session) {
  const transcript = session.turns.map((t, index) => {
    return `Q${index + 1}: ${t.question}\nA${index + 1}: ${t.answer}`;
  }).join('\n');

  const rejected = session.rejectedGuesses.length
    ? `Rejected guesses: ${session.rejectedGuesses.join(', ')}`
    : 'Rejected guesses: none';

  return `${transcript}\n${rejected}`;
}

function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontKnow: 'dont_know',
    dont_know: 'dont_know'
  };
  return map[answer] || 'dont_know';
}

async function askEngine(session) {
  if (!openai) {
    const fallbackQuestions = session.language === 'ar'
      ? [
          'هل هذه الشخصية عربية؟',
          'هل هذه الشخصية رجل؟',
          'هل هذه الشخصية فنان؟',
          'هل هذه الشخصية رياضي؟'
        ]
      : [
          'Is this person Arab?',
          'Is this person male?',
          'Is this person an artist?',
          'Is this person an athlete?'
        ];

    if (session.turns.length < fallbackQuestions.length) {
      return { type: 'question', text: fallbackQuestions[session.turns.length] };
    }

    return {
      type: 'guess',
      name: session.language === 'ar' ? 'كاظم الساهر' : 'Kadim Al Sahir',
      confidence: 0.35
    };
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `Game state:\n${sessionMessages(session)}\n\nGenerate the next best question or a guess.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return session.language === 'ar'
      ? { type: 'question', text: 'هل هذه الشخصية مشهورة في العالم العربي؟' }
      : { type: 'question', text: 'Is this person well known in the Arab world?' };
  }
}

async function fetchWikipediaSummary(name, language = 'ar') {
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MagicBallNative/1.0' }
  });

  if (!res.ok) {
    return {
      title: name,
      extract: language === 'ar' ? 'لا توجد معلومات متاحة حالياً.' : 'No information available right now.',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }

  const json = await res.json();
  return {
    title: json.title || name,
    extract: json.extract || (language === 'ar' ? 'لا توجد نبذة.' : 'No summary.'),
    imageURL: json.thumbnail?.source || json.originalimage?.source || null,
    articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model, hasOpenAI: Boolean(openai) });
});

app.post('/api/game/start', async (req, res) => {
  const language = req.body?.language === 'en' ? 'en' : 'ar';
  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    language,
    turns: [],
    rejectedGuesses: []
  };
  sessions.set(sessionId, session);
  const result = await askEngine(session);
  res.json({ sessionId, ...result });
});

app.post('/api/game/answer', async (req, res) => {
  const { sessionId, question, answer } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.turns.push({ question, answer: normalizeAnswer(answer) });
  const result = await askEngine(session);
  res.json(result);
});

app.post('/api/game/guess-confirm', async (req, res) => {
  const { sessionId, guessName, correct } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (correct) {
    const wiki = await fetchWikipediaSummary(guessName, session.language);
    return res.json({ type: 'revealed', guessName, wiki });
  }

  session.rejectedGuesses.push(guessName);
  const result = await askEngine(session);
  return res.json(result);
});

app.get('/api/wiki', async (req, res) => {
  const name = String(req.query.name || '');
  const language = req.query.language === 'en' ? 'en' : 'ar';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const wiki = await fetchWikipediaSummary(name, language);
  res.json(wiki);
});

app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
