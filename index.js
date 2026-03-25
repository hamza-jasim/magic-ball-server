"use strict";

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = "gpt-4o-mini";

// 🧠 prompt بسيط
const SYSTEM_PROMPT = `
You are an AI like Akinator.
Ask ONLY one yes/no question each time.

After around 7 questions, make a guess like:
My guess: [name]

No explanations.
`;

// 🟢 start
app.post("/api/start", async (req, res) => {
  res.json({
    messages: [],
    question: "Is the person you're thinking of real?"
  });
});

// 🟢 answer
app.post("/api/answer", async (req, res) => {
  try {
    const { messages } = req.body;

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ],
    });

    const text = response.choices[0]?.message?.content || "";

    const isGuess = text.includes("My guess:");

    res.json({
      text,
      isGuess
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "AI failed" });
  }
});

// 🟢 health
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
