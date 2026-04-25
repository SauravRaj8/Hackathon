import 'dotenv/config';
import { listAvailableModels } from './src/services/geminiService.js';

async function main() {
  console.log('Fetching available Gemini models...');
  const models = await listAvailableModels();
  
  if (models && models.length > 0) {
    console.log('\nAvailable Models:');
    models.forEach(m => {
      console.log(`- ${m.name.replace('models/', '')} (${m.displayName})`);
      console.log(`  Description: ${m.description}`);
      console.log(`  Features: ${m.supportedGenerationMethods.join(', ')}`);
      console.log('');
    });
  } else {
    console.log('No models found or error occurred.');
  }
}

main();
