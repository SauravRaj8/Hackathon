import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
  try {
    const models = await genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // Just to see if it works
    console.log("Success getting model object");
    
    // There is no listModels in the standard SDK easily accessible like this
    // but we can try to generate a simple content
    const result = await models.generateContent("Hello");
    console.log(result.response.text());
  } catch (err) {
    console.error("Error:", err);
  }
}

listModels();
