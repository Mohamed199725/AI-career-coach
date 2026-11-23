"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { revalidatePath } from "next/cache";
import { withCache } from "@/lib/ai-cache";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// gemini-1.5-flash is retired and returns 404; flash-lite is fast and has its own quota.
// maxOutputTokens bounds decode time: the result is a single short paragraph, so
// there is no reason to let generation run to the default ceiling.
const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash-lite",
  generationConfig: { maxOutputTokens: 512 },
});

export async function saveResume(content) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  try {
    const resume = await db.resume.upsert({
      where: {
        userId: user.id,
      },
      update: {
        content,
      },
      create: {
        userId: user.id,
        content,
      },
    });

    revalidatePath("/resume");
    return resume;
  } catch (error) {
    console.error("Error saving resume:", error);
    throw new Error("Failed to save resume");
  }
}

export async function getResume() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  return await db.resume.findUnique({
    where: {
      userId: user.id,
    },
  });
}

export async function improveWithAI({ current, type }) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    include: {
      industryInsight: true,
    },
  });

  if (!user) throw new Error("User not found");

  const prompt = `
    As an expert resume writer, improve the following ${type} description for a ${user.industry} professional.
    Make it more impactful, quantifiable, and aligned with industry standards.
    Current content: "${current}"

    Requirements:
    1. Use action verbs
    2. Include metrics and results where possible
    3. Highlight relevant technical skills
    4. Keep it concise but detailed
    5. Focus on achievements over responsibilities
    6. Use industry-specific keywords
    
    Format the response as a single paragraph without any additional text or explanations.
  `;

  try {
    // Re-running "improve" on unchanged text is the common case; the cache makes
    // that instant instead of another ~15s round trip.
    const improvedContent = await withCache(
      "gemini-3.5-flash-lite-improve",
      prompt,
      async () => (await model.generateContent(prompt)).response.text().trim()
    );

    if (!improvedContent) {
      return { error: "The AI returned an empty response. Please try again." };
    }

    return { content: improvedContent };
  } catch (error) {
    console.error("Error improving content:", error);
    const status = error?.message?.match(/\[(\d{3})[^\]]*\]/)?.[1];

    if (status === "429") {
      return { error: "Daily AI limit reached. Please try again tomorrow." };
    }
    if (status === "503" || status === "500") {
      return { error: "The AI service is busy right now. Please try again." };
    }
    // Return instead of throw: an uncaught Server Action error is an opaque 500
    return { error: "Failed to improve content. Please try again." };
  }
}
