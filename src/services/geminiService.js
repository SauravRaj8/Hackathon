import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { getExtractionPrompt } from '../config/domains.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const VISION_MODEL = 'gemini-flash-lite-latest';

/**
 * Lists all available Gemini models by calling the REST API.
 */
export const listAvailableModels = async () => {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
    const response = await axios.get(url);
    return response.data.models;
  } catch (err) {
    console.error('Failed to list models:', err.message);
    return [];
  }
};

// ─── Helper ────────────────────────────────────────────────────────────────

/**
 * Downloads an image from a URL and converts it to base64.
 */
const downloadImageAsBase64 = async (imageUrl) => {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'CatalogueBot/1.0' },
  });
  const contentType = (response.headers['content-type'] || 'image/jpeg').split(';')[0];
  const base64 = Buffer.from(response.data).toString('base64');
  return { base64, mimeType: contentType };
};

/**
 * Strips markdown code fences from Gemini's response and parses JSON.
 */
const parseGeminiJson = (text) => {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
};

// ─── System 1: Product Image Analysis ─────────────────────────────────────

/**
 * Analyzes a product image from a URL using Gemini Vision.
 *
 * Uses the domain-specific extraction prompt from domains.js when a valid
 * domain is provided; falls back to the generic prompt otherwise.
 *
 * Returns structured attributes including:
 *   primaryObjects, objects, brand, colour, colours,
 *   category, subcategory, tags, attributes (domain-specific), confidence
 *
 * @param {string} imageUrl - URL of the product image
 * @param {string|null} domain  - product domain (fashion/beauty/electronics/food/grocery)
 */
export const analyzeProductImage = async (imageUrl, domain = null) => {
  const { base64, mimeType } = await downloadImageAsBase64(imageUrl);
  const model = genAI.getGenerativeModel({ model: VISION_MODEL });
  const prompt = getExtractionPrompt(domain);

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64 } },
    prompt,
  ]);

  const parsed = parseGeminiJson(result.response.text());

  // Normalise: ensure primaryObjects, objects, and attributes are always present
  // so downstream code never needs to null-check them.
  parsed.primaryObjects = parsed.primaryObjects || [];
  parsed.objects = parsed.objects || [];
  parsed.attributes = parsed.attributes || {};

  return parsed;
};

// ─── System 2: Search Image Analysis ──────────────────────────────────────

const SEARCH_IMAGE_PROMPT = `You are a visual search AI. Analyze this image that a user is searching with.

The image may contain ONE product, MULTIPLE distinct products, or a group of
people wearing/carrying products. For each distinct PRODUCT detected, emit one
entry in "elements". Each element must include a bounding box in Gemini's
standard [ymin, xmin, ymax, xmax] format with values from 0 to 1000, relative
to the normalised image dimensions.

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "elements": [
    {
      "name": "short product-type label, e.g. 'sneakers', 'handbag', 'sunglasses'",
      "bbox": [ymin, xmin, ymax, xmax],
      "attributes": {
        "colour": "dominant colour or null",
        "brand": "visible brand name or null",
        "material": "material if visible or null",
        "style": "style descriptor or null",
        "gender": "men/women/unisex/kids or null",
        "pattern": "pattern or null"
      },
      "searchText": "natural language query for THIS element only, e.g. 'red nike running shoes'",
      "firstWord": "single most important keyword (the product type)"
    }
  ],
  "primaryObject": "same as elements[0].name",
  "objects": ["all detected products as a flat list (backwards compat)"],
  "attributes": "shorthand: same as elements[0].attributes",
  "searchText": "shorthand: same as elements[0].searchText",
  "firstWord": "shorthand: same as elements[0].firstWord"
}

Hard rules:
- PEOPLE ARE NOT PRODUCTS. If the image has people, detect the clothing,
  footwear, bags, accessories, jewellery, eyewear, and watches they are
  wearing or carrying — but never emit "person", "man", "woman", "face",
  "hair", "skin", or similar as an element.
- Ignore incidental background/scene items (tables, floors, walls, plants,
  food props etc). Only emit shoppable products.
- Always include a bbox for every element. If you cannot localise it
  precisely, estimate a conservative box that covers the product.
- If the image has only one clear product, still emit an "elements" array of
  length 1 with its bbox.
- If no products are detected at all (e.g. a pure face close-up or empty
  scene), return "elements": [].
- Return AT MOST 10 elements, ordered by prominence (largest / most central
  first). If more than 10 are visible, drop the smallest.`;

/**
 * Analyzes an image uploaded by a user for search purposes.
 * Accepts a Buffer and mimeType (from multer's req.file).
 */
export const analyzeSearchImage = async (imageBuffer, mimeType = 'image/jpeg') => {
  const base64 = imageBuffer.toString('base64');
  const model = genAI.getGenerativeModel({ model: VISION_MODEL });

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64 } },
    SEARCH_IMAGE_PROMPT,
  ]);

  const parsed = parseGeminiJson(result.response.text());

  // ── Normalise the response ────────────────────────────────────────────────
  // Legacy shape (no elements[], just searchText/firstWord at root): upgrade
  // into a single-entry elements array. An empty elements array is legit
  // ("no products found") — we preserve it and let the controller 422.
  if (!Array.isArray(parsed.elements)) {
    if (parsed.searchText || parsed.firstWord || parsed.primaryObject) {
      parsed.elements = [{
        name: parsed.primaryObject || parsed.firstWord || 'product',
        attributes: parsed.attributes || {},
        searchText: parsed.searchText || parsed.primaryObject || '',
        firstWord: parsed.firstWord || parsed.primaryObject || '',
        bbox: null, // legacy — no bbox available, caller will fall back to whole image
      }];
    } else {
      parsed.elements = [];
    }
  }

  // Enforce 10-element cap as a safety net (prompt asks for <=10 already)
  if (parsed.elements.length > 10) parsed.elements = parsed.elements.slice(0, 10);

  // Populate shorthand from elements[0] if we have at least one element
  if (parsed.elements.length > 0) {
    const first = parsed.elements[0];
    parsed.searchText = parsed.searchText || first.searchText;
    parsed.firstWord = parsed.firstWord || first.firstWord;
    parsed.attributes = parsed.attributes || first.attributes || {};
    parsed.primaryObject = parsed.primaryObject || first.name;
  }

  return parsed;
};

// ─── System 2: Text Query Processing ──────────────────────────────────────

/**
 * Processes a user text query:
 *  - Detects language
 *  - Translates to English if needed
 *  - Extracts search elements and attributes
 */
export const processTextQuery = async (queryText) => {
  const prompt = `You are a multilingual product search AI.
Given the following search query: "${queryText}"

1. Detect the language.
2. Translate to English if it is not already English.
3. Extract structured search attributes.

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "originalText": "${queryText}",
  "detectedLanguage": "ISO 639-1 code, e.g. en, hi, ta, es, fr",
  "translatedText": "English translation (same as original if already English)",
  "elements": ["extracted search elements/nouns"],
  "attributes": {
    "colour": "colour mentioned or null",
    "brand": "brand mentioned or null",
    "category": "product category implied or null",
    "material": "material mentioned or null",
    "gender": "men/women/kids/unisex or null",
    "priceRange": "price if mentioned or null"
  },
  "firstWord": "the primary product-type keyword (most important search term)"
}`;

  const model = genAI.getGenerativeModel({ model: VISION_MODEL });
  const result = await model.generateContent(prompt);
  return parseGeminiJson(result.response.text());
};
