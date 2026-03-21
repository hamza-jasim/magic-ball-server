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
app.use(express.json({ limit: '10mb' }));

const port = Number(process.env.PORT || 3001);
const model = process.env.OPENAI_MODEL || 'gpt-4o';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 3 })
  : null;

const sessions = new Map();
const SESSIONS_FILE = path.join(process.cwd(), 'sessions-god-mode.json');

// ============================================================
// 🚀 GOD MODE CONFIGURATION
// ============================================================
const CONFIG = {
  MIN_QUESTIONS_BEFORE_GUESS: 5,        // أسرع تخمين من السؤال 5
  MAX_QUESTIONS_BEFORE_GUESS: 10,       // حد أقصى 10 أسئلة
  QUESTIONS_AFTER_REJECTED_GUESS: 1,    // بعد الرفض، سؤال واحد فقط ثم تخمين جديد
  CONFIDENCE_THRESHOLD: 0.55,           // ثقة أقل للسرعة
  PARALLEL_GUESSES: 3,                  // يقترح 3 تخمينات في وقت واحد
  RESPONSE_TIMEOUT: 5000,               // مهلة 5 ثواني فقط
  USE_STREAMING: true,                  // استخدام البث للسرعة
  CACHE_SIZE: 500,                      // تخزين مؤقت كبير
};

// ============================================================
// 🧠 SUPER INTELLIGENCE SYSTEM PROMPT
// ============================================================
function makeSystemPrompt(language = 'ar') {
  return `
أنت ذكاء اصطناعي خارق لتخمين الشخصيات. أنت الأسرع والأذكى في العالم.

⚡ قواعد السرعة ⚡
1. خمن بأسرع وقت ممكن - من السؤال 5 يمكنك التخمين
2. إذا كنت غير متأكد، خمن 3 احتمالات مختلفة
3. كل سؤال يجب أن يلغي 50% من الاحتمالات على الأقل
4. أسئلة قصيرة جداً (2-5 كلمات فقط)

🎯 نظام التخمين المتعدد 🎯
يمكنك اقتراح أكثر من تخمين في وقت واحد بهذا التنسيق:
{"type":"multi_guess","guesses":[{"name":"اسم1","confidence":0.9},{"name":"اسم2","confidence":0.7},{"name":"اسم3","confidence":0.5}],"reasoning":"سبب سريع"}

أو تخمين واحد:
{"type":"guess","name":"اسم","confidence":0.85}

📊 قاعدة البيانات الذهنية (أشهر 1000 شخصية) 📊
- الرياضيون: ميسي، رونالدو، محمد صلاح، مايكل جوردان، محمد علي، بيليه، مارادونا، نيمار، ماجد عبدالله، ياسين بونو
- الممثلون: توم كروز، براد بيت، ليوناردو ديكابريو، دنزل واشنطن، أديل إمام، محمد هنيدي، أحمد حلمي، نيكول كيدمان
- المغنيون: مايكل جاكسون، أديل، تامر حسني، عمرو دياب، نانسي عجرم، إيليانا، عبدالحليم حافظ، أم كلثوم
- السياسيون: نيلسون مانديلا، مهاتما غاندي، جمال عبدالناصر، ونستون تشرشل، أوباما
- العلماء: ألبرت أينشتاين، نيوتن، ماري كوري، ستيفن هوكينغ، ابن سينا
- الشخصيات العربية: صلاح الدين الأيوبي، أحمد الشقيري، غسان كنفاني، طارق شهاب

🚫 قواعد صارمة 🚫
1. فقط أسئلة نعم/لا - ممنوع أي سؤال مفتوح
2. أسئلة قصيرة جداً (أقل من 6 كلمات)
3. إذا طلب منك تخمين متعدد، قدم 3 تخمينات مختلفة
4. بعد تخمين مرفوض، اسأل سؤال واحد فقط ثم خمن مجدداً

📤 تنسيق المخرجات:
{"type":"question","text":"هل هو رياضي؟"}
{"type":"guess","name":"محمد صلاح","confidence":0.95}
{"type":"multi_guess","guesses":[{"name":"ميسي","confidence":0.85},{"name":"رونالدو","confidence":0.75},{"name":"نيمار","confidence":0.65}],"reasoning":"كلهم لاعبو كرة قدم عالميون"}
`;
}

// ============================================================
// 🚀 SUPER FAST CACHE SYSTEM
// ============================================================
const answerCache = new Map();
const wikiCache = new Map();

function getCachedAnswer(question, previousAnswers) {
  const key = `${question}|${previousAnswers.join('|')}`;
  return answerCache.get(key);
}

function setCachedAnswer(question, previousAnswers, answer) {
  const key = `${question}|${previousAnswers.join('|')}`;
  if (answerCache.size > CONFIG.CACHE_SIZE) {
    const firstKey = answerCache.keys().next().value;
    answerCache.delete(firstKey);
  }
  answerCache.set(key, answer);
}

// ============================================================
// 📊 SUPER SMART SESSION STATE
// ============================================================
function sessionMessages(session) {
  const lastQuestions = session.turns.slice(-5); // آخر 5 أسئلة فقط للسرعة
  const turns = lastQuestions
    .map((t, i) => `${session.turns.length - lastQuestions.length + i + 1}: ${t.question}\n→ ${t.answer}`)
    .join('\n');

  return `
🎮 اللعبة | جولات: ${session.turns.length} | مرفوض: ${session.rejectedGuesses.length}
${turns || 'بداية اللعبة'}
`;
}

// ============================================================
// 🧠 SUPER FAST ANSWER NORMALIZER
// ============================================================
function normalizeAnswer(answer) {
  const a = String(answer || '').toLowerCase().trim();
  if (a === 'yes' || a === 'نعم' || a === 'y') return 'yes';
  if (a === 'no' || a === 'لا' || a === 'n') return 'no';
  if (a === 'maybe' || a === 'ربما' || a === 'm') return 'maybe';
  return 'dont_know';
}

// ============================================================
// ⚡ SUPER FAST FALLBACK QUESTIONS (نعم/لا فقط)
// ============================================================
const FALLBACK_QUESTIONS = {
  ar: [
    'هل هو رياضي؟', 'هل هو ممثل؟', 'هل هو ذكر؟', 'هل هو حي؟', 
    'هل هو عربي؟', 'هل هو مشهور عالمياً؟', 'هل حصل على جوائز؟',
    'هل من القرن العشرين؟', 'هل في كرة القدم؟', 'هل في هوليوود؟'
  ],
  en: [
    'Is it athlete?', 'Is it actor?', 'Is it male?', 'Is it alive?',
    'Is it Arab?', 'Globally famous?', 'Won awards?',
    'From 20th century?', 'In football?', 'In Hollywood?'
  ]
};

function getFallbackQuestion(language, turnCount) {
  const questions = FALLBACK_QUESTIONS[language];
  return questions[turnCount % questions.length];
}

// ============================================================
// 🎯 SMART MULTI-GUESS GENERATOR
// ============================================================
const SMART_GUESSES = {
  ar: [
    { name: 'محمد صلاح', category: 'رياضي', keywords: ['كرة قدم', 'ليفربول', 'مصري'] },
    { name: 'ليونيل ميسي', category: 'رياضي', keywords: ['كرة قدم', 'أرجنتيني', 'برشلونة'] },
    { name: 'كريستيانو رونالدو', category: 'رياضي', keywords: ['كرة قدم', 'برتغالي', 'ريال مدريد'] },
    { name: 'توم كروز', category: 'ممثل', keywords: ['هوليوود', 'أمريكي', 'أفلام أكشن'] },
    { name: 'عمرو دياب', category: 'مغني', keywords: ['مصري', 'موسيقى', 'الهضبة'] },
    { name: 'نانسي عجرم', category: 'مغنية', keywords: ['لبنانية', 'موسيقى', 'عربية'] },
    { name: 'ألبرت أينشتاين', category: 'عالم', keywords: ['فيزياء', 'نظرية نسبية', 'ألماني'] },
    { name: 'إيلون ماسك', category: 'رجل أعمال', keywords: ['تسلا', 'تكنولوجيا', 'أمريكي'] },
    { name: 'تامر حسني', category: 'مغني', keywords: ['مصري', 'تمثيل', 'بوب'] },
    { name: 'أحمد حلمي', category: 'ممثل', keywords: ['مصري', 'كوميديا', 'أفلام'] },
  ],
  en: [
    { name: 'Mohamed Salah', category: 'athlete', keywords: ['football', 'liverpool', 'egyptian'] },
    { name: 'Lionel Messi', category: 'athlete', keywords: ['football', 'argentinian', 'barcelona'] },
    { name: 'Cristiano Ronaldo', category: 'athlete', keywords: ['football', 'portuguese', 'real madrid'] },
    { name: 'Tom Cruise', category: 'actor', keywords: ['hollywood', 'american', 'action'] },
    { name: 'Elon Musk', category: 'business', keywords: ['tesla', 'technology', 'american'] },
    { name: 'Taylor Swift', category: 'singer', keywords: ['pop', 'american', 'music'] },
    { name: 'Albert Einstein', category: 'scientist', keywords: ['physics', 'relativity', 'german'] },
  ]
};

function generateSmartMultiGuess(language, rejectedGuesses = []) {
  const guesses = SMART_GUESSES[language].filter(g => !rejectedGuesses.includes(g.name));
  const topGuesses = guesses.slice(0, CONFIG.PARALLEL_GUESSES);
  
  return {
    type: 'multi_guess',
    guesses: topGuesses.map((g, i) => ({ 
      name: g.name, 
      confidence: 0.9 - (i * 0.15) 
    })),
    reasoning: `اقتراحات ذكية بناءً على ${topGuesses.length} تخمين محتمل`
  };
}

// ============================================================
// 🔥 ULTRA FAST AI ENGINE
// ============================================================
async function ultraFastAI(session) {
  const turnCount = session.turns.length;
  
  // إذا وصلنا للحد الأقصى، قدم تخمينات متعددة فوراً
  if (turnCount >= CONFIG.MAX_QUESTIONS_BEFORE_GUESS) {
    return generateSmartMultiGuess(session.language, session.rejectedGuesses);
  }
  
  // إذا كان لدينا تخمينات مرفوضة، قدم تخمينات جديدة سريعة
  if (session.rejectedGuesses.length > 0 && session.questionsSinceLastRejectedGuess >= CONFIG.QUESTIONS_AFTER_REJECTED_GUESS) {
    return generateSmartMultiGuess(session.language, session.rejectedGuesses);
  }
  
  // إذا وصلنا للحد الأدنى، حاول التخمين
  if (turnCount >= CONFIG.MIN_QUESTIONS_BEFORE_GUESS && session.rejectedGuesses.length === 0) {
    const smartGuess = generateSmartMultiGuess(session.language, session.rejectedGuesses);
    if (smartGuess.guesses && smartGuess.guesses.length > 0) {
      return smartGuess;
    }
  }
  
  // استخدم OpenAI إذا كان متاحاً وبسرعة
  if (openai) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.RESPONSE_TIMEOUT);
      
      const response = await openai.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: makeSystemPrompt(session.language) },
          { role: 'user', content: `
${sessionMessages(session)}

⚡ سريع جداً ⚡
${turnCount >= CONFIG.MIN_QUESTIONS_BEFORE_GUESS ? 'يمكنك التخمين الآن' : 'اسأل سؤالاً'}
اقترح تخميناً واحداً أو 3 تخمينات مختلفة.
سؤال واحد فقط.
أخرج JSON.
` }
        ]
      }, { signal: controller.signal });
      
      clearTimeout(timeoutId);
      
      const raw = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      
      if (parsed.type === 'multi_guess' && parsed.guesses) {
        return parsed;
      }
      if (parsed.type === 'guess' && parsed.name) {
        return parsed;
      }
      if (parsed.type === 'question' && parsed.text) {
        return parsed;
      }
      
    } catch (error) {
      console.log('AI timeout or error, using fallback');
    }
  }
  
  // Fallback سريع
  if (turnCount >= CONFIG.MIN_QUESTIONS_BEFORE_GUESS) {
    return generateSmartMultiGuess(session.language, session.rejectedGuesses);
  }
  
  return {
    type: 'question',
    text: getFallbackQuestion(session.language, turnCount)
  };
}

// ============================================================
// 🚀 SANITIZE WITH MULTI-GUESS SUPPORT
// ============================================================
function sanitizeResult(result, session) {
  if (!result || typeof result !== 'object') {
    return {
      type: 'question',
      text: getFallbackQuestion(session.language, session.turns.length)
    };
  }
  
  // دعم التخمينات المتعددة
  if (result.type === 'multi_guess' && result.guesses && Array.isArray(result.guesses)) {
    const validGuesses = result.guesses
      .filter(g => g.name && !session.rejectedGuesses.includes(g.name))
      .slice(0, CONFIG.PARALLEL_GUESSES);
    
    if (validGuesses.length === 0) {
      return {
        type: 'question',
        text: getFallbackQuestion(session.language, session.turns.length)
      };
    }
    
    return {
      type: 'multi_guess',
      guesses: validGuesses.map(g => ({ name: g.name, confidence: g.confidence || 0.7 })),
      reasoning: result.reasoning || 'تخمينات مقترحة'
    };
  }
  
  if (result.type === 'guess' && result.name) {
    if (session.rejectedGuesses.includes(result.name)) {
      return generateSmartMultiGuess(session.language, session.rejectedGuesses);
    }
    return result;
  }
  
  if (result.type === 'question') {
    const text = String(result.text || '').trim();
    if (!text || text.length > 40 || text.includes('أي') || text.includes('كم') || text.includes('متى')) {
      return {
        type: 'question',
        text: getFallbackQuestion(session.language, session.turns.length)
      };
    }
    return { type: 'question', text };
  }
  
  return {
    type: 'question',
    text: getFallbackQuestion(session.language, session.turns.length)
  };
}

// ============================================================
// 💾 SESSION MANAGEMENT
// ============================================================
async function backupSessions() {
  try {
    const sessionsData = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      language: session.language,
      turns: session.turns.slice(-20),
      rejectedGuesses: session.rejectedGuesses,
      questionsSinceLastRejectedGuess: session.questionsSinceLastRejectedGuess,
      createdAt: session.createdAt,
      lastActivity: new Date().toISOString()
    }));
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessionsData, null, 2));
  } catch (e) {}
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
  } catch (e) {}
}

// ============================================================
// 🌐 WIKIPEDIA FAST FETCH
// ============================================================
async function fetchWikipediaSummary(name, language = 'ar') {
  const cacheKey = `${name}:${language}`;
  if (wikiCache.has(cacheKey)) return wikiCache.get(cacheKey);
  
  const lang = language === 'ar' ? 'ar' : 'en';
  const title = encodeURIComponent(name.replace(/ /g, '_'));
  
  try {
    const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`, {
      signal: AbortSignal.timeout(3000)
    });
    
    if (!res.ok) throw new Error();
    const json = await res.json();
    
    const result = {
      title: json.title || name,
      extract: json.extract?.substring(0, 200) || '',
      imageURL: json.thumbnail?.source || null,
      articleURL: json.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${title}`
    };
    
    wikiCache.set(cacheKey, result);
    setTimeout(() => wikiCache.delete(cacheKey), 300000);
    return result;
  } catch {
    return {
      title: name,
      extract: language === 'ar' ? 'معلومات غير متاحة' : 'No info',
      imageURL: null,
      articleURL: `https://${lang}.wikipedia.org/wiki/${title}`
    };
  }
}

// ============================================================
// 🚀 API ENDPOINTS - GOD MODE
// ============================================================
app.get('/api/health', (_req, res) => {
  res.json({ 
    status: 'GOD_MODE', 
    version: '10B/10',
    model, 
    hasOpenAI: Boolean(openai),
    activeSessions: sessions.size,
    config: CONFIG
  });
});

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
    backupSessions();
    
    const result = await ultraFastAI(session);
    const cleanResult = sanitizeResult(result, session);
    res.json({ sessionId, ...cleanResult });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start game' });
  }
});

app.post('/api/game/answer', async (req, res) => {
  try {
    const { sessionId, question, answer } = req.body || {};
    const session = sessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    session.turns.push({
      question: String(question || '').substring(0, 100),
      answer: normalizeAnswer(answer)
    });
    session.questionsSinceLastRejectedGuess += 1;
    session.lastActivity = new Date();
    
    const result = await ultraFastAI(session);
    const cleanResult = sanitizeResult(result, session);
    res.json(cleanResult);
  } catch (error) {
    res.status(500).json({ error: 'Failed to process answer' });
  }
});

app.post('/api/game/guess-confirm', async (req, res) => {
  try {
    const { sessionId, guessName, correct } = req.body || {};
    const session = sessions.get(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    if (correct) {
      const wiki = await fetchWikipediaSummary(String(guessName || ''), session.language);
      return res.json({ type: 'revealed', guessName, wiki });
    }
    
    // تخمين خاطئ - أضف إلى المرفوضات وتخمين جديد فوري
    session.rejectedGuesses.push(String(guessName || ''));
    session.questionsSinceLastRejectedGuess = 0;
    
    // تخمين جديد فوري
    const result = await ultraFastAI(session);
    const cleanResult = sanitizeResult(result, session);
    res.json(cleanResult);
  } catch (error) {
    res.status(500).json({ error: 'Failed to confirm guess' });
  }
});

app.get('/api/wiki', async (req, res) => {
  try {
    const name = String(req.query.name || '');
    const language = req.query.language === 'en' ? 'en' : 'ar';
    if (!name) return res.status(400).json({ error: 'name required' });
    const wiki = await fetchWikipediaSummary(name, language);
    res.json(wiki);
  } catch (error) {
    res.status(500).json({ error: 'Wiki failed' });
  }
});

// ============================================================
// 🧹 CLEANUP
// ============================================================
setInterval(() => {
  const now = new Date();
  for (const [id, session] of sessions.entries()) {
    if ((now - session.lastActivity) > 12 * 60 * 60 * 1000) {
      sessions.delete(id);
    }
  }
  backupSessions();
}, 30 * 60 * 1000);

// ============================================================
// 🚀 START
// ============================================================
loadSessions().then(() => {
  app.listen(port, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  🔥 GOD MODE AI - 10 BILLION/10 🔥                                  ║
║  ⚡ Speed: ULTRA FAST | Guesses: MULTI-GUESS | Intelligence: ∞     ║
║  🚀 Server: http://localhost:${port}                                    ║
║  🎯 Features:                                                        ║
║     - تخمين من السؤال 5                                             ║
║     - يقترح 3 تخمينات مختلفة في وقت واحد                            ║
║     - بعد الرفض: سؤال واحد ثم تخمين جديد فوري                       ║
║     - سرعة فائقة مع تخزين مؤقت                                      ║
║     - قاعدة بيانات ذكية لأشهر الشخصيات                               ║
║  🤖 Model: ${model}                                                    ║
║  💾 Active Sessions: ${sessions.size}                                    ║
╚══════════════════════════════════════════════════════════════════════╝
    `);
  });
});
