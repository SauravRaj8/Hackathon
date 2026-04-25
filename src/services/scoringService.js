import { getScoringWeights } from '../config/domains.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const normalize = (s) => (s || '').toLowerCase().trim();

/**
 * Category match score.
 * Returns null if the CSV didn't provide a category (field skipped).
 */
const scoreCategoryMatch = (aiCategory, providedCategory) => {
  if (!providedCategory) return null;
  const ai = normalize(aiCategory);
  const provided = normalize(providedCategory);
  if (ai === provided) return 1.0;
  if (ai.includes(provided) || provided.includes(ai)) return 0.7;
  return 0.0;
};

/**
 * Brand match score.
 * If brand not detected by AI, give partial credit (0.3) instead of 0.
 */
const scoreBrandMatch = (aiBrand, providedBrand) => {
  if (!providedBrand) return null;
  if (!aiBrand) return 0.3; // AI couldn't detect brand — not penalised heavily
  const ai = normalize(aiBrand);
  const provided = normalize(providedBrand);
  if (ai === provided) return 1.0;
  if (ai.includes(provided) || provided.includes(ai)) return 0.8;
  return 0.0;
};

/**
 * Colour match score against all AI-detected colours.
 */
const scoreColourMatch = (aiColour, aiColours, providedColour) => {
  if (!providedColour) return null;
  const provided = normalize(providedColour);
  const allAiColours = [normalize(aiColour), ...(aiColours || []).map(normalize)].filter(Boolean);
  if (allAiColours.includes(provided)) return 1.0;
  const partialMatch = allAiColours.some((c) => c.includes(provided) || provided.includes(c));
  return partialMatch ? 0.6 : 0.0;
};

/**
 * Tag overlap using Jaccard similarity.
 */
const scoreTagsJaccard = (aiTags, providedTags) => {
  if (!providedTags || providedTags.length === 0) return null;
  if (!aiTags || aiTags.length === 0) return 0.1;

  const aiSet = new Set(aiTags.map(normalize));
  const providedSet = new Set(providedTags.map(normalize));

  const intersection = [...aiSet].filter((t) => providedSet.has(t)).length;
  const union = new Set([...aiSet, ...providedSet]).size;

  return intersection / union;
};

// ─── Domain-attribute scorer ────────────────────────────────────────────────

/**
 * Generic string match scorer for domain-specific attributes like
 * gender, model, skin_type, fabric etc.
 * Returns null if the CSV didn't provide a value for this field.
 */
const scoreAttributeMatch = (aiValue, providedValue) => {
  if (!providedValue) return null;
  if (!aiValue) return 0.2; // AI couldn't detect it — mild penalty
  const ai = normalize(String(aiValue));
  const provided = normalize(String(providedValue));
  if (ai === provided) return 1.0;
  if (ai.includes(provided) || provided.includes(ai)) return 0.7;
  return 0.0;
};

// ─── Main Scoring Function ──────────────────────────────────────────────────

/**
 * Calculates a quality score [0, 1] by comparing AI-extracted attributes
 * to the metadata provided in the CSV row.
 *
 * Fields not provided in the CSV are skipped and their weights redistributed.
 * Domain-specific weight maps are sourced from domains.js.
 *
 * @param {Object} aiExtracted  - Output from geminiService.analyzeProductImage()
 * @param {Object} csvMetadata  - { brand, colour, category, tags, ...domain fields }
 * @param {string|null} domain  - product domain (fashion/beauty/electronics/food/grocery)
 * @returns {{ score: number, failedFields: string[], fieldScores: Object }}
 */
export const calculateQualityScore = (aiExtracted, csvMetadata, domain = null) => {
  const { brand, colour, category, tags } = csvMetadata;
  const WEIGHTS = getScoringWeights(domain);

  // Base scores that apply across all domains
  const rawScores = {
    category: scoreCategoryMatch(aiExtracted.category, category),
    brand: scoreBrandMatch(aiExtracted.brand, brand),
    colour: scoreColourMatch(aiExtracted.colour, aiExtracted.colours, colour),
    tags: scoreTagsJaccard(aiExtracted.tags, tags),
  };

  // Domain-specific attribute scores — sourced from aiExtracted.attributes
  // vs csvMetadata fields of the same name.
  const aiAttrs = aiExtracted.attributes || {};
  const domainFields = {
    fashion:     ['gender', 'fabric'],
    beauty:      ['gender', 'skin_type'],
    electronics: ['model', 'model_year', 'ram', 'storage', 'screen_size'],
    food:        ['cuisine'],
    grocery:     [],
  };
  const fieldsForDomain = (domain && domainFields[domain]) || [];
  for (const field of fieldsForDomain) {
    if (field in WEIGHTS) {
      rawScores[field] = scoreAttributeMatch(aiAttrs[field], csvMetadata[field] || null);
    }
  }

  // If no metadata fields were provided at all, rely on AI's own confidence
  const activeFields = Object.values(rawScores).filter((s) => s !== null);
  if (activeFields.length === 0) {
    return {
      score: aiExtracted.confidence || 0.5,
      failedFields: [],
      fieldScores: {},
    };
  }

  // Weighted average over only the fields that are both present in CSV
  // and have a weight defined for this domain.
  let totalWeight = 0;
  let weightedSum = 0;
  const fieldScores = {};
  const failedFields = [];

  for (const [key, score] of Object.entries(rawScores)) {
    if (score !== null && key in WEIGHTS) {
      totalWeight += WEIGHTS[key];
      weightedSum += score * WEIGHTS[key];
      fieldScores[key] = parseFloat(score.toFixed(3));
      if (score < 0.5) failedFields.push(key);
    }
  }

  // Guard: if none of the present CSV fields have a weight in this domain's
  // map (e.g. only "colour" provided for an electronics item), fall back to
  // AI confidence so we don't produce NaN.
  if (totalWeight === 0) {
    return {
      score: aiExtracted.confidence || 0.5,
      failedFields: [],
      fieldScores,
    };
  }

  const finalScore = parseFloat((weightedSum / totalWeight).toFixed(4));

  return { score: finalScore, failedFields, fieldScores };
};
