import 'dotenv/config';
import { analyzeProductImage } from './src/services/geminiService.js';

async function test() {
  const testImageUrl = 'https://picsum.photos/200/300'; // Random image
  console.log(`Testing Gemini with model: ${process.env.GEMINI_API_KEY ? 'Key present' : 'Key MISSING'}`);
  
  try {
    const result = await analyzeProductImage(testImageUrl);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error caught during analysis:', err.message);
    if (err.stack) console.error(err.stack);
  }
}

test();
