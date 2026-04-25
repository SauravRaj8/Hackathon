import { GoogleGenerativeAI } from '@google/generative-ai';
import { ALLOWED_DOMAINS } from '../config/domains.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const EMBEDDING_MODEL = 'gemini-embedding-001';

// Target dimension for text embeddings written to Elasticsearch.
// gemini-embedding-001 supports outputDimensionality up to 3072; we pin to 768
// so the ES index mapping stays stable. If your ES index was created with a
// different value, set TEXT_EMBEDDING_DIMS env var to match.
export const TEXT_EMBEDDING_DIMS = parseInt(process.env.TEXT_EMBEDDING_DIMS || '768', 10);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * L2-normalises a plain number[] in place and returns it.
 */
const l2normalise = (vec) => {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
};

/**
 * Resizes a vector to exactly `targetDim` dimensions by either truncating or
 * zero-padding, then L2-normalises the result.
 * Truncation preserves the most-significant (leading) dimensions — for PCA-style
 * Matryoshka embeddings (like Gemini's) this is lossless. Padding is a last
 * resort for up-sizing and produces a unit-norm vector in the padded subspace.
 */
export const resizeAndNormalise = (vec, targetDim) => {
  if (vec.length === targetDim) {
    // Already correct size — just normalise in case it isn't unit-norm.
    return l2normalise([...vec]);
  }
  if (vec.length > targetDim) {
    // Truncate (Matryoshka-safe for Gemini embeddings)
    return l2normalise(vec.slice(0, targetDim));
  }
  // Zero-pad to targetDim
  const padded = [...vec, ...new Array(targetDim - vec.length).fill(0)];
  return l2normalise(padded);
};

// ─── Text Representation Builder ───────────────────────────────────────────

// ─── Domain-aware text builders ─────────────────────────────────────────────
//
// Each builder returns an ordered array of text parts for its domain.
// Order matters — terms appearing earlier in the embedding input carry more
// weight in most transformer-based embedding models.
//
// Rule: ONLY use primaryObjects (what the product IS), never `objects`
// (incidental props). This prevents cross-contamination in search results.

const attr = (product, key) => {
  const attrs = product.attributes || {};
  return attrs[key] || null;
};

const buildFashionText = (product) => {
  const parts = [];
  // Primary identity first
  const primaryObjs = product.primaryObjects?.length ? product.primaryObjects : product.objects;
  if (primaryObjs?.length) parts.push(primaryObjs.join(' '));
  if (product.category) parts.push(product.category);
  if (product.subcategory) parts.push(product.subcategory);
  // Key fashion discriminators
  if (attr(product, 'gender')) parts.push(attr(product, 'gender'));
  if (product.colour) parts.push(product.colour);
  if (product.colours?.length > 1) parts.push(product.colours.slice(1).join(' '));
  if (attr(product, 'fabric')) parts.push(attr(product, 'fabric'));
  if (attr(product, 'size')) parts.push(attr(product, 'size'));
  if (product.brand) parts.push(product.brand);
  if (product.tags?.length) parts.push(product.tags.join(' '));
  return parts;
};

const buildBeautyText = (product) => {
  const parts = [];
  // Brand is primary for beauty (people search "Lakme lipstick" not "red lipstick")
  if (product.brand) parts.push(product.brand);
  const primaryObjs = product.primaryObjects?.length ? product.primaryObjects : product.objects;
  if (primaryObjs?.length) parts.push(primaryObjs.join(' '));
  if (product.category) parts.push(product.category);
  if (product.subcategory) parts.push(product.subcategory);
  if (product.colour) parts.push(product.colour);
  if (attr(product, 'skin_type')) parts.push(attr(product, 'skin_type'));
  if (attr(product, 'gender')) parts.push(attr(product, 'gender'));
  if (product.tags?.length) parts.push(product.tags.join(' '));
  return parts;
};

const buildElectronicsText = (product) => {
  const parts = [];
  // Brand + model are the primary identity for electronics
  if (product.brand) parts.push(product.brand);
  if (attr(product, 'model')) parts.push(attr(product, 'model'));
  if (attr(product, 'model_year')) parts.push(attr(product, 'model_year'));
  if (product.category) parts.push(product.category);
  if (product.subcategory) parts.push(product.subcategory);
  // Specs
  if (attr(product, 'ram')) parts.push(attr(product, 'ram'));
  if (attr(product, 'storage')) parts.push(attr(product, 'storage'));
  if (attr(product, 'screen_size')) parts.push(attr(product, 'screen_size'));
  if (product.colour) parts.push(product.colour);
  if (product.tags?.length) parts.push(product.tags.join(' '));
  return parts;
};

const buildFoodText = (product) => {
  const parts = [];
  const primaryObjs = product.primaryObjects?.length ? product.primaryObjects : product.objects;
  if (primaryObjs?.length) parts.push(primaryObjs.join(' '));
  if (product.category) parts.push(product.category);
  if (product.subcategory) parts.push(product.subcategory);
  if (attr(product, 'cuisine')) parts.push(attr(product, 'cuisine'));
  if (product.brand) parts.push(product.brand);
  const dietary = attr(product, 'dietary');
  if (Array.isArray(dietary) && dietary.length) parts.push(dietary.join(' '));
  else if (dietary) parts.push(dietary);
  if (product.tags?.length) parts.push(product.tags.join(' '));
  return parts;
};

const buildGroceryText = (product) => {
  const parts = [];
  const primaryObjs = product.primaryObjects?.length ? product.primaryObjects : product.objects;
  if (primaryObjs?.length) parts.push(primaryObjs.join(' '));
  if (product.category) parts.push(product.category);
  if (product.subcategory) parts.push(product.subcategory);
  if (product.brand) parts.push(product.brand);
  if (attr(product, 'size')) parts.push(attr(product, 'size'));
  const dietary = attr(product, 'dietary');
  if (Array.isArray(dietary) && dietary.length) parts.push(dietary.join(' '));
  else if (dietary) parts.push(dietary);
  if (product.tags?.length) parts.push(product.tags.join(' '));
  return parts;
};

// Generic fallback — used for unknown domains and legacy products.
const buildGenericText = (product) => {
  const parts = [];
  if (product.title) parts.push(product.title);
  if (product.category) parts.push(product.category);
  if (product.subcategory) parts.push(product.subcategory);
  if (product.brand) parts.push(product.brand);
  if (product.colour) parts.push(product.colour);
  if (product.colours?.length) parts.push(product.colours.join(' '));
  if (product.tags?.length) parts.push(product.tags.join(' '));
  const primaryObjs = product.primaryObjects?.length ? product.primaryObjects : product.objects;
  if (primaryObjs?.length) parts.push(primaryObjs.join(' '));
  return parts;
};

const DOMAIN_BUILDERS = {
  fashion:     buildFashionText,
  beauty:      buildBeautyText,
  electronics: buildElectronicsText,
  food:        buildFoodText,
  grocery:     buildGroceryText,
};

/**
 * Builds a rich, search-optimised text string from a product's attributes.
 * Branches on product.domain to use the most relevant field ordering.
 *
 * IMPORTANT: Only `primaryObjects` (what the product IS) is embedded.
 * `objects` (incidental props visible in the image) is never included —
 * doing so causes false positives, e.g. a shirt matching "handbag" searches
 * because a handbag prop appeared in its photo.
 *
 * @param {Object} product - must include `domain` for domain-specific ordering
 * @returns {string} - space-separated text ready to embed
 */
export const buildProductText = (product) => {
  const domain = product.domain || null;
  const builder = (domain && DOMAIN_BUILDERS[domain]) || buildGenericText;
  const parts = builder(product).filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};

// ─── Embedding Generation ───────────────────────────────────────────────────

/**
 * Generates a text embedding using Google's gemini-embedding-001.
 *
 * The API is asked for exactly TEXT_EMBEDDING_DIMS dimensions via
 * outputDimensionality (Matryoshka truncation on Gemini's side — lossless).
 * If the API ignores the hint and returns a different size anyway, we
 * resize + L2-normalise client-side so Elasticsearch always gets the right
 * number of floats.
 *
 * @param {string} text - The input text to embed
 * @returns {number[]} - Array of exactly TEXT_EMBEDDING_DIMS normalised floats
 */
export const generateEmbedding = async (text) => {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent({
    content: { parts: [{ text }] },
    // Ask Gemini to truncate server-side to our target dimension.
    // Supported range for gemini-embedding-001: 1–3072.
    outputDimensionality: TEXT_EMBEDDING_DIMS,
  });
  const raw = result.embedding.values;
  if (raw.length === TEXT_EMBEDDING_DIMS) return raw; // fast path
  console.warn(
    `[embeddingService] Expected ${TEXT_EMBEDDING_DIMS}-dim text embedding, ` +
    `got ${raw.length} — resizing client-side.`
  );
  return resizeAndNormalise(raw, TEXT_EMBEDDING_DIMS);
};

/**
 * Generates an embedding for a product by first building its text representation.
 *
 * @param {Object} product - Product object with title, brand, category, colour, tags, objects
 * @returns {number[]} - 768-dimensional embedding vector
 */
export const generateProductEmbedding = async (product) => {
  const text = buildProductText(product);
  return generateEmbedding(text);
};
