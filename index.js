import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import crypto from 'node:crypto';

dotenv.config();
const app = express();
app.use(cors(), express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sessions = new Map();

// إعدادات التحكم
const START_GUESSING_AFTER = 8; 
const QUESTIONS_AFTER_REJECTION = 4;

function generateSystemPrompt(session) {
    const turns = session.turns.length;
    const isAllowedToGuess = turns >= START_GUESSING_AFTER && 
                             session.questionsSinceLastRejectedGuess >= QUESTIONS_AFTER_REJECTION;
    
    // تحديد التعليمات بناءً على اللغة
    const langInstructions = session.language === 'ar' 
        ? `اللغة: العربية الفصحى. 
           القواعد: 
           1. اسأل سؤالاً قصيراً جداً (ماكس 5 كلمات).
           2. الإجابة بنعم أو لا فقط.
           3. ممنوع ذكر اسم أي شخصية في الأسئلة.
           4. لا تخمن إلا إذا كنت متأكداً جداً وبعد السؤال الثامن.`
        : `Language: English. 
           Rules: 
           1. Ask a very short question (max 5 words).
           2. Yes/No format only.
           3. NEVER mention any character names in questions.
           4. Do not guess before turn 8.`;

    return `
${langInstructions}
Current Turn: ${turns}. 
Mode: ${isAllowedToGuess ? 'GUESS_OR_QUESTION' : 'STRICT_QUESTION_ONLY'}.
Rejected Names: [${session.rejectedGuesses.join(', ')}].

Response Format (JSON):
{"type": "question", "text": "..."} OR {"type": "guess", "name": "...", "confidence": 0.95}`;
}

async function askAI(session) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: generateSystemPrompt(session) },
                { role: "user", content: `History: ${JSON.stringify(session.turns)}` }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        let result = JSON.parse(response.choices[0].message.content);

        // حماية اللغة والمنطق
        if (result.type === 'guess') {
            if (session.turns.length < START_GUESSING_AFTER || session.questionsSinceLastRejectedGuess < QUESTIONS_AFTER_REJECTION) {
                return { 
                    type: "question", 
                    text: session.language === 'ar' ? "هل الشخصية حقيقية؟" : "Is it a real person?" 
                };
            }
        }
        return result;
    } catch (e) {
        return { 
            type: "question", 
            text: session.language === 'ar' ? "هل الشخصية ذكر؟" : "Is it male?" 
        };
    }
}

// --- المسارات (Endpoints) ---

app.post('/api/game/start', async (req, res) => {
    const sessionId = crypto.randomUUID();
    // هنا نأخذ اللغة من الطلب (ar أو en)
    const language = req.body.language === 'en' ? 'en' : 'ar';
    
    const session = {
        id: sessionId,
        language: language,
        turns: [],
        rejectedGuesses: [],
        questionsSinceLastRejectedGuess: 10
    };
    sessions.set(sessionId, session);
    
    const result = await askAI(session);
    res.json({ sessionId, ...result });
});

app.post('/api/game/answer', async (req, res) => {
    const { sessionId, question, answer } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).send("Session not found");

    session.turns.push({ question, answer });
    session.questionsSinceLastRejectedGuess++;
    
    res.json(await askAI(session));
});

app.post('/api/game/guess-confirm', async (req, res) => {
    const { sessionId, correct, guessName } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).send();

    if (correct) {
        res.json({ type: 'win', name: guessName });
    } else {
        session.rejectedGuesses.push(guessName);
        session.questionsSinceLastRejectedGuess = 0; 
        res.json(await askAI(session));
    }
});

app.listen(3001, () => console.log("Bilingual AI Server Running on 3001"));
