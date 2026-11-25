"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import {
  describeGeminiError,
  withGeminiModels,
} from "@/lib/gemini";
import { withCache } from "@/lib/ai-cache";

// Generation can take 25-60s for 10 questions; withGeminiModels bounds the whole
// fallback chain and moves on from a model that stalls.

// Measured: a request costs ~14s of fixed server overhead on this key, largely
// independent of prompt size, so the win is in making fewer round trips rather
// than in a cheaper model. Keeping responses bounded also cuts decode time.
const MAX_OUTPUT_TOKENS = 4096;
const quizConfig = {
  responseMimeType: "application/json",
  maxOutputTokens: MAX_OUTPUT_TOKENS,
};

// Improvement tips are plain text, not JSON.
const tipConfig = { maxOutputTokens: 256 };

export async function generateQuiz() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    select: {
      industry: true,
      skills: true,
    },
  });

  if (!user) throw new Error("User not found");

  const prompt = `
    Generate 10 technical interview questions for a ${
      user.industry
    } professional${
    user.skills?.length ? ` with expertise in ${user.skills.join(", ")}` : ""
  }.
    
    Each question should be multiple choice with 4 options.
    
    Return the response in this JSON format only, no additional text:
    {
      "questions": [
        {
          "question": "string",
          "options": ["string", "string", "string", "string"],
          "correctAnswer": "string",
          "explanation": "string"
        }
      ]
    }
  `;

  // The timeout lives in withGeminiModels so that every fallback attempt is bounded
  // too; here we only wait for that chain to finish.
  let result;
  try {
    result = await withGeminiModels({ generationConfig: quizConfig, prompt });
  } catch (error) {
    console.error("Error generating quiz:", error);
    // Return the failure as data instead of throwing: a Server Action that throws
    // surfaces as an opaque 500 and the real reason never reaches the user.
    return { error: describeGeminiError(error) };
  }

  const text = result.response.text();
  const cleanedText = text
    .replace(/```(?:json)?\n?/g, "")
    .replace(/^[\s\S]*?(?=\{)/, "")
    .replace(/\}[^}]*$/, "}")
    .trim();

  let quiz;
  try {
    quiz = JSON.parse(cleanedText);
  } catch (error) {
    console.error("Error parsing quiz response:", error, text.slice(0, 500));
    return { error: "Received an invalid quiz format. Please try again." };
  }

  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    return { error: "No quiz questions were generated. Please try again." };
  }

  return { questions: quiz.questions };
}

export async function saveQuizResult(questions, answers, score) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const questionResults = questions.map((q, index) => ({
    question: q.question,
    answer: q.correctAnswer,
    userAnswer: answers[index],
    isCorrect: q.correctAnswer === answers[index],
    explanation: q.explanation,
  }));

  // Get wrong answers
  const wrongAnswers = questionResults.filter((q) => !q.isCorrect);

  // Only generate improvement tips if there are wrong answers.
  // The tip is fetched concurrently with the DB write below instead of before it:
  // each Gemini call costs ~14s of fixed overhead, so awaiting them in series
  // made saving a result take twice as long as either step alone.
  let tipPromise = null;
  if (wrongAnswers.length > 0) {
    const wrongQuestionsText = wrongAnswers
      .map(
        (q) =>
          `Question: "${q.question}"\nCorrect Answer: "${q.answer}"\nUser Answer: "${q.userAnswer}"`
      )
      .join("\n\n");

    const improvementPrompt = `
      The user got the following ${user.industry} technical interview questions wrong:

      ${wrongQuestionsText}

      Based on these mistakes, provide a concise, specific improvement tip.
      Focus on the knowledge gaps revealed by these wrong answers.
      Keep the response under 2 sentences and make it encouraging.
      Don't explicitly mention the mistakes, instead focus on what to learn/practice.
    `;

    tipPromise = withCache(
      "gemini-3.5-flash-lite-tip",
      improvementPrompt,
      async () =>
        (
          await withGeminiModels({ generationConfig: tipConfig }, (model) =>
            model.generateContent(improvementPrompt)
          )
        )
          .response.text()
          .trim()
    )
      .catch((error) => {
        console.error("Error generating improvement tip:", error);
        // Continue without improvement tip if generation fails
        return null;
      });
  }

  try {
    const assessmentPromise = db.assessment.create({
      data: {
        userId: user.id,
        quizScore: score,
        questions: questionResults,
        category: "Technical",
        improvementTip: null,
      },
    });

    const [assessment, generatedTip] = await Promise.all([
      assessmentPromise,
      tipPromise ?? Promise.resolve(null),
    ]);

    if (!generatedTip) return assessment;

    return await db.assessment.update({
      where: { id: assessment.id },
      data: { improvementTip: generatedTip },
    });
  } catch (error) {
    console.error("Error saving quiz result:", error);
    throw new Error("Failed to save quiz result");
  }
}

export async function getAssessments() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  try {
    const assessments = await db.assessment.findMany({
      where: {
        userId: user.id,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return assessments;
  } catch (error) {
    console.error("Error fetching assessments:", error);
    throw new Error("Failed to fetch assessments");
  }
}
