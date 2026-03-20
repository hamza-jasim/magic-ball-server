import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

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
  return `You are an intelligent guessing engine similar to Akinator.

CRITICAL RULES:
- Ask ONLY ONE short yes/no question at a time.
- Allowed answers: yes, no, maybe, dont_know.

🚫 STRICTLY FORBIDDEN:
- NEVER mention ANY person's name during questions.
- NEVER guess or suggest names during questions.
- NEVER say: "Is it [name]?" or similar.

- Questions must ONLY be about traits:
  (gender, job, nationality, era, etc.)

SMART STRATEGY:
- First 3 questions: broad classification only (gender, real person, field).
- Next questions: narrow the category using traits only (actor, athlete, singer, politician, scientist, fictional, alive, nationality, etc).
- Ask only YES/NO questions about general traits and attributes.
- NEVER mention, suggest, or ask about any person's name during the question phase.
- NEVER ask questions like: "Is it Michael Jackson?" or "Is it [name]?"
- During the question phase, do not show candidate names, examples, or suggestions.
- Stay in question mode for at least 7 questions.
- Only after question 7, if confidence is high enough, make ONE guess.
- Never ask more than 8 questions without making a guess.

GUESSING CONTROL:
- Only guess after at least 7 questions.
- Only ONE guess at a time.

IF GUESS IS WRONG:
- If user says NO:
  - STOP guessing completely.
  - Do NOT guess again immediately.
  - Return to asking questions.
  - Ask at least 2 new questions before any new guess.
  - Do not repeat rejected guesses.

LANGUAGE:
- If language is 'ar', all questions and guesses must be in Arabic only.
- If language is 'en', all questions and guesses must be in English only.

IMPORTANT:
- Do not repeat questions.
- Do not ask vague or useless questions.
- Be decisive and confident.
- Output STRICT JSON only.

Question:
{"type":"question","text":"..."}

Guess:
{"type":"guess","name":"...","confidence":0.7}`;
}
function sessionMessages(session) {
  const transcript = session.turns
    .map((t, index) => {
      return `Q${index + 1}: ${t.question}\nA${index + 1}: ${t.answer}`;
    })
    .join('\n');

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
      confidence: 0.4
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
    content: `Language: ${session.language === 'ar' ? 'Arabic' : 'English'}

Game state:
${sessionMessages(session)}

INSTRUCTIONS:
- Analyze all previous answers carefully.
- Choose the most informative next question.
- Avoid repeating previous questions.
- Focus on eliminating large groups of possibilities.
- Be strategic, not random.
- Think step by step before asking.

Generate the next best question or guess in the specified language.`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    return JSON.parse(raw);
  } catch {
    return session.language === 'ar'
      ? { type: 'question', text: 'هل هذه الشخصية مشهورة؟' }
      : { type: 'question', text: 'Is this person famous?' };
  }
}

async function fetchWikipediaSummary(name, language = 'ar') {
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const res = await fetch(url);

  if (!res.ok) {
    return {
      title: name,
      extract: language === 'ar'
        ? 'لا توجد معلومات متاحة'
        : 'No information available',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }

  const json = await res.json();

  return {
    title: json.title || name,
    extract: json.extract || '',
    imageURL: json.thumbnail?.source || null,
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

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.turns.push({
    question,
    answer: normalizeAnswer(answer)
  });

  const result = await askEngine(session);

  res.json(result);
});

app.post('/api/game/guess-confirm', async (req, res) => {
  const { sessionId, guessName, correct } = req.body || {};
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (correct) {
    const wiki = await fetchWikipediaSummary(guessName, session.language);

    return res.json({
      type: 'revealed',
      guessName,
      wiki
    });
  }

  session.rejectedGuesses.push(guessName);

  const result = await askEngine(session);

  return res.json(result);
});

app.get('/api/wiki', async (req, res) => {
  const name = String(req.query.name || '');
  const language = req.query.language === 'en' ? 'en' : 'ar';

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const wiki = await fetchWikipediaSummary(name, language);

  res.json(wiki);
});

app.listen(port, () => {
  console.log(`Magic Ball server running on http://localhost:${port}`);
});
