import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
const SESSIONS_FILE = path.join(process.cwd(), 'sessions-backup.json');

// GAME RULES
const MIN_QUESTIONS_BEFORE_GUESS = 7;
const MAX_QUESTIONS_BEFORE_GUESS = 12;
const QUESTIONS_AFTER_REJECTED_GUESS = 2;
const CONFIDENCE_THRESHOLD = 0.65; // إذا الثقة أقل من 65%، اسأل أكثر

// ============================================================
// 🔥 SYSTEM PROMPT — نسخة 10/10 احترافية جداً
// ============================================================
function makeSystemPrompt(language = 'ar') {
  return `
أنت محرك تخمين شخصيات فائق الذكاء مع قدرة تحليل عميقة.

مهمتك:
تحديد الشخصية بأقل عدد من الأسئلة وبأقصى دقة ممكنة.

=== القواعد الذهبية ===
1. اسأل سؤالاً واحداً بنعم/لا فقط.
2. أخرج JSON صارماً فقط: {"type":"question","text":"..."} أو {"type":"guess","name":"...","confidence":0.XX,"reasoning":"..."}
3. لا تفسيرات. لا ماركداون.
4. لا تذكر أسماء أبداً في وضع السؤال.
5. كل سؤال يجب أن يلغي 30-60% من الاحتمالات.

=== استراتيجية التخمين الذكية ===
الطبقة 1 — التصنيف العام (الأسئلة 1-3)
- حقيقي vs خيالي
- الجنس (ذكر/أنثى/غير محدد)
- المجال الرئيسي: (رياضة، تمثيل، سياسة، موسيقى، علوم، إنترنت، تاريخ، أعمال، فنون)

الطبقة 2 — التخصص الدقيق (الأسئلة 4-6)
- إذا رياضي: (كرة قدم، كرة سلة، تنس، ملاكمة، مصارعة، سباحة، جولف، فورمولا 1)
- إذا ممثل: (هوليوود، بوليوود، عربي، مسرح، أفلام أكشن، كوميديا، دراما)
- إذا مغني: (بوب، راب، كلاسيكي، عربي، غربي، روك، ميتال)
- إذا سياسي: (رئيس، ملك، ثوري، ديكتاتور، رئيس وزراء، حقبة حديثة، حقبة قديمة)
- إذا عالم: (فيزياء، كيمياء، أحياء، رياضيات، حاسوب، طب، فلك)
- العصر: (قديم جداً، حديث، معاصر)
- الحالة: (حي/ميت)
- الجنسية: (عربي، أمريكي، أوروبي، آسيوي، إفريقي، لاتيني)

الطبقة 3 — التحليل العميق (الأسئلة 7-10)
- السمات المميزة: (شكل، صوت، أسلوب، شهرة عالمية، جوائز، فضائح، إنجازات)
- الإرث: (تأثير، ابتكارات، أعمال خالدة، بصمة)
- العلاقات: (شراكات شهيرة، أعداء، عائلة مشهورة)
- التفاصيل الدقيقة: (نادٍ، فريق، قناة، شركة، حدث تاريخي)

=== تحليل الثقة (Confidence) ===
عند التخمين، أضف حقل reasoning يشرح لماذا هذا التخمين:
- الثقة 0.9+ : متأكد 100% بناءً على الأدلة
- الثقة 0.75-0.89 : احتمال كبير جداً
- الثقة 0.6-0.74 : احتمال متوسط
- الثقة أقل من 0.6 : لا تخمن، اسأل المزيد

=== قواعد متقدمة ===
- إذا الثقة أقل من ${CONFIDENCE_THRESHOLD}، لا تخمن واسأل المزيد
- بعد تخمين مرفوض، حلل الخطأ: "لماذا كان تخميني خاطئاً؟ ما المعلومات الناقصة؟"
- لا تكرر تخميناً مرفوضاً أبداً
- تعلم من الأنماط: إذا تم رفض تخمين مشابه، غيّر الاستراتيجية

تنسيق المخرجات:
سؤال: {"type":"question","text":"هل هو رياضي؟"}
تخمين: {"type":"guess","name":"ليونيل ميسي","confidence":0.92,"reasoning":"لاعب كرة قدم أرجنتيني، فاز بالكرة الذهبية، لعب في برشلونة"}
`;
}

// ============================================================
// 🔥 تحليل عميق للتخمينات المرفوضة
// ============================================================
async function analyzeFailedGuess(session, wrongGuess) {
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'أنت محلل استراتيجي. حلل لماذا فشل التخمين واقترح استراتيجية جديدة.'
        },
        {
          role: 'user',
          content: `
التخمين الخاطئ: ${wrongGuess}
الأسئلة والأجوبة السابقة:
${sessionMessages(session)}

حلل:
1. لماذا كان هذا التخمين خاطئاً؟
2. ما هي المعلومات الناقصة التي أحتاجها؟
3. ما هي أفضل 3 أسئلة قادمة لتضييق الاحتمالات؟
4. اقترح تخميناً جديداً محتملاً.

أجب بتنسيق JSON:
{
  "reason": "...",
  "missingInfo": ["...", "..."],
  "nextQuestions": ["...", "...", "..."],
  "suggestedGuess": "..."
}
`
        }
      ]
    });

    return JSON.parse(response.choices[0]?.message?.content || '{}');
  } catch {
    return null;
  }
}

// ============================================================
// 🔥 حفظ الجلسات بشكل دائم
// ============================================================
async function backupSessions() {
  try {
    const sessionsData = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      language: session.language,
      turns: session.turns,
      rejectedGuesses: session.rejectedGuesses,
      questionsSinceLastRejectedGuess: session.questionsSinceLastRejectedGuess,
      createdAt: session.createdAt,
      lastActivity: new Date().toISOString()
    }));
    
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessionsData, null, 2));
  } catch (error) {
    console.error('Failed to backup sessions:', error);
  }
}

async function loadSessions() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const sessionsData = JSON.parse(data);
    
    sessionsData.forEach(sessionData => {
      sessions.set(sessionData.id, {
        ...sessionData,
        createdAt: new Date(sessionData.createdAt),
        lastActivity: new Date(sessionData.lastActivity)
      });
    });
    
    console.log(`✅ Loaded ${sessionsData.length} sessions from backup`);
  } catch {
    console.log('No existing sessions backup found');
  }
}

// Backup sessions every 5 minutes
setInterval(backupSessions, 5 * 60 * 1000);

// ============================================================
// 🔥 تحسين الـ HISTORY
// ============================================================
function sessionMessages(session) {
  const turns = session.turns
    .map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`)
    .join('\n');

  return `
=== حالة اللعبة ===
اللغة: ${session.language}
عدد الجولات: ${session.turns.length}

${turns}

التخمينات المرفوضة: ${session.rejectedGuesses.join(', ') || 'لا شيء'}
الأسئلة منذ آخر تخمين مرفوض: ${session.questionsSinceLastRejectedGuess}
===================
`;
}

// ============================================================
// 🔥 normalizeAnswer مع دعم إجابات متقدمة
// ============================================================
function normalizeAnswer(answer) {
  const map = {
    yes: 'yes',
    no: 'no',
    maybe: 'maybe',
    dontKnow: 'dont_know',
    dont_know: 'dont_know',
    partially: 'partially',
    sometimes: 'sometimes'
  };
  return map[answer] || 'dont_know';
}

// ============================================================
// 🔥 fallback questions ذكية
// ============================================================
function shortFallbackQuestion(language = 'ar', turnCount = 0, rejectedGuesses = []) {
  // إذا كان فيه تخمينات مرفوضة، اسأل أسئلة مختلفة
  if (rejectedGuesses.length > 0) {
    const arAdvanced = [
      'ما هي الجنسية؟',
      'هل لا يزال على قيد الحياة؟',
      'في أي عصر اشتهر؟',
      'هل حصل على جوائز عالمية؟',
      'ما هو المجال الدقيق؟'
    ];
    
    const enAdvanced = [
      'What is the nationality?',
      'Are they still alive?',
      'In which era did they become famous?',
      'Did they win global awards?',
      'What is the specific field?'
    ];
    
    const list = language === 'ar' ? arAdvanced : enAdvanced;
    return list[Math.min(turnCount % list.length, list.length - 1)];
  }
  
  const ar = [
    'هل هو رجل؟',
    'هل هو حقيقي؟',
    'هل هو ممثل؟',
    'هل هو عربي؟',
    'هل هو حي؟',
    'هل هو مغني؟',
    'هل هو رياضي؟',
    'هل هو سياسي؟'
  ];

  const en = [
    'Is it male?',
    'Is it real?',
    'Is it an actor?',
    'Is it Arab?',
    'Is it alive?',
    'Is it a singer?',
    'Is it an athlete?',
    'Is it a politician?'
  ];

  const list = language === 'ar' ? ar : en;
  return list[Math.min(turnCount, list.length - 1)];
}

// ============================================================
// 🔥 fallback guess ذكي
// ============================================================
function fallbackGuess(language = 'ar', rejectedGuesses = []) {
  const commonGuesses = {
    ar: ['محمد صلاح', 'أحمد الشقيري', 'نانسي عجرم', 'عبدالحليم حافظ', 'صلاح الدين'],
    en: ['Mohamed Salah', 'Elon Musk', 'Taylor Swift', 'Cristiano Ronaldo', 'Albert Einstein']
  };
  
  const available = commonGuesses[language].filter(g => !rejectedGuesses.includes(g));
  const name = available[0] || (language === 'ar' ? 'محمد صلاح' : 'Mohamed Salah');
  
  return { 
    type: 'guess', 
    name, 
    confidence: 0.45,
    reasoning: 'تخمين احتياطي بناءً على الأنماط الشائعة'
  };
}

// ============================================================
// 🔥 فلاتر الأسئلة المتقدمة
// ============================================================
function isQuestionTooLong(text = '', language = 'ar') {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return language === 'ar' ? words.length > 6 : words.length > 8;
}

function looksLikeNameQuestion(text = '') {
  const lower = String(text).toLowerCase().trim();
  if (!lower) return false;

  const namePatterns = [
    'is it ', 'could it be ', 'هل هو', 'هل اسمه',
    'مايكل', 'michael', 'محمد', 'tom', 'أحمد', 'علي'
  ];
  
  return namePatterns.some(pattern => lower.includes(pattern)) && 
         lower.split(/\s+/).length > 3;
}

function isQuestionIrrelevant(text = '', turnCount = 0) {
  const irrelevant = ['الطقس', 'اللون', 'الطعام', 'weather', 'color', 'food'];
  const lower = text.toLowerCase();
  return irrelevant.some(word => lower.includes(word));
}

// ============================================================
// 🔥 sanitizeEngineResult المحسن
// ============================================================
function sanitizeEngineResult(result, session) {
  const turnCount = session.turns.length;

  if (!result || typeof result !== 'object') {
    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
    };
  }

  if (result.type === 'question') {
    const text = String(result.text || '').trim();

    if (!text || isQuestionTooLong(text, session.language) || 
        looksLikeNameQuestion(text) || isQuestionIrrelevant(text, turnCount)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }

    return { type: 'question', text };
  }

  if (result.type === 'guess') {
    const name = String(result.name || '').trim();
    const confidence = typeof result.confidence === 'number' ? result.confidence : 0.5;
    const reasoning = result.reasoning || '';

    if (!name || session.rejectedGuesses.includes(name)) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }

    return {
      type: 'guess',
      name,
      confidence,
      reasoning
    };
  }

  return {
    type: 'question',
    text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
  };
}

// ============================================================
// 🔥 forceGuess مع تحليل الثقة
// ============================================================
async function forceGuess(session) {
  if (!openai) {
    return fallbackGuess(session.language, session.rejectedGuesses);
  }

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `
قم بتقديم أفضل تخمين لديك الآن بناءً على المعلومات المتاحة.
حلل الثقة بدقة واستخدم حقل reasoning.

التنسيق:
{"type":"guess","name":"...","confidence":0.XX,"reasoning":"تحليل مختصر"}
`
      },
      {
        role: 'user',
        content: `
اللغة: ${session.language === 'ar' ? 'Arabic' : 'English'}

حالة اللعبة:
${sessionMessages(session)}

التخمينات المرفوضة سابقاً: ${session.rejectedGuesses.join(', ') || 'لا شيء'}

قم بتقديم أفضل تخمين واحد الآن مع تحليل الثقة.
`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEngineResult(parsed, session);
  } catch {
    return fallbackGuess(session.language, session.rejectedGuesses);
  }
}

// ============================================================
// 🔥 askEngine — قلب الذكاء (نسخة 10/10)
// ============================================================
async function askEngine(session) {
  const turnCount = session.turns.length;

  // تحليل متقدم لمعرفة إذا كان مسموح بالتخمين
  let canGuessNow = false;
  let shouldAskMore = false;
  
  if (turnCount >= MIN_QUESTIONS_BEFORE_GUESS) {
    if (session.rejectedGuesses.length === 0) {
      canGuessNow = true;
    } else if (session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTED_GUESS) {
      canGuessNow = true;
    }
  }
  
  // إذا كان عندنا تخمينات مرفوضة، حاول تحليل الخطأ أولاً
  let errorAnalysis = null;
  if (session.rejectedGuesses.length > 0 && session.questionsSinceLastRejectedGuess === 0) {
    const lastWrongGuess = session.rejectedGuesses[session.rejectedGuesses.length - 1];
    errorAnalysis = await analyzeFailedGuess(session, lastWrongGuess);
  }

  // ============================================================
  // إذا ماكو OpenAI — fallback ذكي
  // ============================================================
  if (!openai) {
    if (turnCount < MIN_QUESTIONS_BEFORE_GUESS || !canGuessNow) {
      return {
        type: 'question',
        text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
      };
    }
    return fallbackGuess(session.language, session.rejectedGuesses);
  }

  // ============================================================
  // 🔥 الذكاء الحقيقي — OpenAI مع تحليل متقدم
  // ============================================================
  const response = await openai.chat.completions.create({
    model,
    temperature: 0.12,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: makeSystemPrompt(session.language) },
      {
        role: 'user',
        content: `
اللغة: ${session.language === 'ar' ? 'Arabic' : 'English'}

حالة اللعبة:
${sessionMessages(session)}

${errorAnalysis ? `=== تحليل الخطأ السابق ===\n${JSON.stringify(errorAnalysis, null, 2)}\n========================\n` : ''}

التخمينات المرفوضة: ${session.rejectedGuesses.join(', ') || 'لا شيء'}

=== قرارات مهمة ===
- عدد الأسئلة المتبقية قبل الحد الأقصى: ${Math.max(0, MAX_QUESTIONS_BEFORE_GUESS - turnCount)}
- ${canGuessNow ? '✅ مسموح لك بالتخمين الآن إذا كانت الثقة عالية' : '❌ لا تخمن الآن، استمر في طرح الأسئلة'}
- ${CONFIDENCE_THRESHOLD > 0 ? `⚠️ لا تخمن除非 الثقة أعلى من ${CONFIDENCE_THRESHOLD * 100}%` : ''}

${errorAnalysis ? `
استراتيجية مقترحة بناءً على تحليل الخطأ:
- تجنب التخمين: ${errorAnalysis.suggestedGuess || 'غير محدد'}
- ركز على: ${errorAnalysis.missingInfo?.join(', ') || 'جمع معلومات إضافية'}
` : ''}

اتخذ القرار الآن:
- إذا كنت واثقاً (ثقة > ${CONFIDENCE_THRESHOLD * 100}%) وقد حان وقت التخمين → خمن
- وإلا → اسأل سؤالاً قوياً ومحدداً

تذكر: الجودة أهم من السرعة!
`
      }
    ]
  });

  const raw = response.choices[0]?.message?.content || '{}';

  try {
    const parsed = JSON.parse(raw);
    const result = sanitizeEngineResult(parsed, session);

    // إذا AI حاول يخمّن قبل الوقت أو الثقة منخفضة
    if (result.type === 'guess') {
      if (!canGuessNow) {
        return {
          type: 'question',
          text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
        };
      }
      
      // التحقق من الثقة
      if (result.confidence < CONFIDENCE_THRESHOLD && turnCount < MAX_QUESTIONS_BEFORE_GUESS) {
        return {
          type: 'question',
          text: `هل يمكنك توضيح ${session.language === 'ar' ? 'المجال الدقيق' : 'the specific field'}؟`
        };
      }
    }

    // إذا وصلنا الحد الأقصى للأسئلة — لازم نخمن
    if (result.type === 'question' && turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return result;
  } catch (error) {
    console.error('Error parsing AI response:', error);
    if (turnCount >= MAX_QUESTIONS_BEFORE_GUESS) {
      return await forceGuess(session);
    }

    return {
      type: 'question',
      text: shortFallbackQuestion(session.language, turnCount, session.rejectedGuesses)
    };
  }
}

// ============================================================
// 🔥 Wikipedia Fetch مع Cache
// ============================================================
const wikiCache = new Map();

async function fetchWikipediaSummary(name, language = 'ar') {
  const cacheKey = `${name}:${language}`;
  if (wikiCache.has(cacheKey)) {
    return wikiCache.get(cacheKey);
  }

  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;

  const res = await fetch(url);

  let result;
  if (!res.ok) {
    result = {
      title: name,
      extract: language === 'ar' ? 'لا توجد معلومات متاحة' : 'No information available',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  } else {
    const json = await res.json();
    result = {
      title: json.title || name,
      extract: json.extract || '',
      imageURL: json.thumbnail?.source || null,
      articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }
  
  wikiCache.set(cacheKey, result);
  setTimeout(() => wikiCache.delete(cacheKey), 3600000); // Cache for 1 hour
  
  return result;
}

// ============================================================
// 🔥 API: /api/health
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({ 
    ok: true, 
    model, 
    hasOpenAI: Boolean(openai),
    activeSessions: sessions.size,
    version: '10/10 Ultimate Edition'
  });
});

// ============================================================
// 🔥 API: Start Game
// ============================================================
app.post('/api/game/start', async (req, res) => {
  try {
    const language = req.body?.language === 'en' ? 'en' : 'ar';
    const sessionId = crypto.randomUUID();

    const session = {
      id: sessionId,
      language,
      turns: [],
      rejectedGuesses: [],
      questionsSinceLastRejectedGuess: 0,
      createdAt: new Date(),
      lastActivity: new Date()
    };

    sessions.set(sessionId, session);
    await backupSessions();

    const result = await askEngine(session);
    res.json({ sessionId, ...result });
  } catch (error) {
    console.error('/api/game/start error:', error);
    res.status(500).json({ error: 'Failed to start game' });
  }
});

// ============================================================
// 🔥 API: Answer Question
// ============================================================
app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.turns.push({
      question: String(question || ''),
      answer: normalizeAnswer(answer)
    });
    session.questionsSinceLastRejectedGuess += 1;
    session.lastActivity = new Date();

    const result = await askEngine(session);
    res.json(result);
  } catch (error) {
    console.error('/api/game/answer error:', error);
    res.status(500).json({ error: 'Failed to process answer' });
  }
});

// ============================================================
// 🔥 API: Confirm Guess
// ============================================================
app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body || {};
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (correct) {
      const wiki = await fetchWikipediaSummary(
        String(guessName || ''),
        session.language
      );

      return res.json({
        type: 'revealed',
        guessName,
        wiki
      });
    }

    // تخمين خاطئ - تحليل عميق وتعلم من الخطأ
    session.rejectedGuesses.push(String(guessName || ''));
    session.questionsSinceLastRejectedGuess = 0;
    
    // تحليل الخطأ لتحسين التخمينات المستقبلية
    const analysis = await analyzeFailedGuess(session, guessName);
    if (analysis) {
      console.log(`📊 Analysis for ${guessName}:`, analysis.reason);
    }

    const result = await askEngine(session);
    return res.json(result);
  } catch (error) {
    console.error('/api/game/guess-confirm error:', error);
    res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

// ============================================================
// 🔥 API: Wikipedia Search
// ============================================================
app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const wiki = await fetchWikipediaSummary(name, language);
    res.json(wiki);
  } catch (error) {
    console.error('/api/wiki error:', error);
    res.status(500).json({ error: 'Failed to fetch wiki' });
  }
});

// ============================================================
// 🔥 API: Session Stats
// ============================================================
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    id: session.id,
    language: session.language,
    turnsCount: session.turns.length,
    rejectedGuesses: session.rejectedGuesses,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity
  });
});

// ============================================================
// 🔥 Cleanup old sessions (every hour)
// ============================================================
setInterval(() => {
  const now = new Date();
  for (const [id, session] of sessions.entries()) {
    const hoursSinceLastActivity = (now - session.lastActivity) / (1000 * 60 * 60);
    if (hoursSinceLastActivity > 24) {
      sessions.delete(id);
      console.log(`🧹 Cleaned up old session: ${id}`);
    }
  }
  backupSessions();
}, 60 * 60 * 1000);

// ============================================================
// 🔥 Load sessions on startup
// ============================================================
loadSessions().then(() => {
  console.log(`🚀 Server ready with ${sessions.size} sessions loaded`);
});

// ============================================================
// 🔥 تشغيل السيرفر
// ============================================================
app.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🎯 AI Character Guessing Engine - 10/10 Ultimate      ║
║  🔥 Running on: http://localhost:${port}                    ║
║  🤖 Model: ${model}                                         ║
║  💾 Sessions: Active with persistence                   ║
║  🧠 Confidence Threshold: ${CONFIDENCE_THRESHOLD * 100}%                     ║
╚══════════════════════════════════════════════════════════╝
  `);
});
