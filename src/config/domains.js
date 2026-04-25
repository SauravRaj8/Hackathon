/**
 * Domain Configuration
 *
 * Single source of truth for everything domain-specific:
 *   - Allowed domain values
 *   - Per-domain attribute schemas (what fields matter)
 *   - Per-domain scoring weight maps
 *   - Per-domain Gemini extraction prompt templates
 *
 * Every other file imports from here and branches on domain —
 * no domain-specific logic should live outside this module.
 */

// ─── Allowed Domains ────────────────────────────────────────────────────────

export const ALLOWED_DOMAINS = ['fashion', 'beauty', 'electronics', 'food', 'grocery'];

/**
 * Returns true if the given domain string is valid.
 */
export const isValidDomain = (domain) =>
  typeof domain === 'string' && ALLOWED_DOMAINS.includes(domain.toLowerCase().trim());

/**
 * Normalises a raw domain string to lowercase trimmed form, or returns null.
 */
export const normalizeDomain = (raw) => {
  if (!raw) return null;
  const d = String(raw).toLowerCase().trim();
  return ALLOWED_DOMAINS.includes(d) ? d : null;
};

// ─── Per-Domain Attribute Schemas ────────────────────────────────────────────
//
// Defines which attributes are relevant (and expected) for each domain.
// Used by the reviewer UI to know which fields to show, and by scoring/embedding
// to know which fields to weight.
//
// Each entry: { key, label, required }
//   required: true  → missing value triggers lower quality score
//   required: false → nice-to-have, doesn't penalise heavily if absent

export const DOMAIN_ATTRIBUTE_SCHEMAS = {
  fashion: [
    { key: 'brand',      label: 'Brand',    required: false },
    { key: 'colour',     label: 'Colour',   required: true  },
    { key: 'gender',     label: 'Gender',   required: true  },
    { key: 'fabric',     label: 'Fabric',   required: false },
    { key: 'size',       label: 'Size',     required: false },
    { key: 'category',   label: 'Category', required: true  },
    { key: 'subcategory',label: 'Subcategory', required: false },
    { key: 'tags',       label: 'Tags',     required: false },
  ],
  beauty: [
    { key: 'brand',      label: 'Brand',     required: true  },
    { key: 'colour',     label: 'Colour',    required: false },
    { key: 'gender',     label: 'Gender',    required: false },
    { key: 'skin_type',  label: 'Skin Type', required: false },
    { key: 'category',   label: 'Category',  required: true  },
    { key: 'subcategory',label: 'Subcategory', required: false },
    { key: 'tags',       label: 'Tags',      required: false },
  ],
  electronics: [
    { key: 'brand',       label: 'Brand',       required: true  },
    { key: 'model',       label: 'Model',        required: true  },
    { key: 'model_year',  label: 'Model Year',   required: false },
    { key: 'colour',      label: 'Colour',       required: false },
    { key: 'ram',         label: 'RAM',          required: false },
    { key: 'storage',     label: 'Storage',      required: false },
    { key: 'screen_size', label: 'Screen Size',  required: false },
    { key: 'category',    label: 'Category',     required: true  },
    { key: 'subcategory', label: 'Subcategory',  required: false },
    { key: 'tags',        label: 'Tags',         required: false },
  ],
  food: [
    { key: 'brand',       label: 'Brand',         required: false },
    { key: 'category',    label: 'Category',       required: true  },
    { key: 'subcategory', label: 'Subcategory',    required: false },
    { key: 'cuisine',     label: 'Cuisine',        required: false },
    { key: 'dietary',     label: 'Dietary',        required: false }, // vegan, gluten-free, etc.
    { key: 'ingredients', label: 'Ingredients',    required: false },
    { key: 'tags',        label: 'Tags',           required: false },
  ],
  grocery: [
    { key: 'brand',       label: 'Brand',          required: false },
    { key: 'category',    label: 'Category',        required: true  },
    { key: 'subcategory', label: 'Subcategory',     required: false },
    { key: 'size',        label: 'Pack Size/Weight',required: false },
    { key: 'dietary',     label: 'Dietary',         required: false },
    { key: 'ingredients', label: 'Ingredients',     required: false },
    { key: 'tags',        label: 'Tags',            required: false },
  ],
};

// ─── Per-Domain Scoring Weight Maps ─────────────────────────────────────────
//
// Weights must sum to 1.0 across the fields that are actually provided.
// Fields absent from the CSV are skipped and their weight redistributed
// (handled in scoringService.js).

export const DOMAIN_SCORING_WEIGHTS = {
  fashion: {
    category: 0.30,
    brand:    0.15,
    colour:   0.25,
    gender:   0.20,
    tags:     0.10,
  },
  beauty: {
    category:  0.30,
    brand:     0.35,
    colour:    0.10,
    skin_type: 0.15,
    tags:      0.10,
  },
  electronics: {
    category:  0.20,
    brand:     0.25,
    model:     0.30,
    colour:    0.05,
    tags:      0.20, // covers ram/storage/screen_size when supplied as tags
  },
  food: {
    category:  0.40,
    brand:     0.20,
    cuisine:   0.20,
    tags:      0.20,
  },
  grocery: {
    category:  0.45,
    brand:     0.30,
    tags:      0.25,
  },
};

// ─── Per-Domain Gemini Extraction Prompts ────────────────────────────────────
//
// Each prompt instructs Gemini to extract domain-relevant attributes.
// All prompts share the same output contract:
//   {
//     primaryObjects: string[]     — what the product actually IS
//     objects:        string[]     — incidental items also visible, NOT the product
//     brand:          string|null
//     colour:         string|null
//     colours:        string[]
//     category:       string|null
//     subcategory:    string|null
//     tags:           string[]     — generic descriptive tags
//     attributes:     object       — domain-specific key/value pairs (see per-domain schema)
//     confidence:     number       — 0..1
//   }
//
// The `attributes` map carries domain-specific fields (gender, fabric, model, ram, etc.)
// so downstream code can access them via product.attributes.gender etc.

export const DOMAIN_PROMPTS = {
  fashion: `You are a fashion product catalog AI. Analyze this fashion product image.

Distinguish carefully:
- "primaryObjects": the clothing/accessory item(s) this listing is ACTUALLY SELLING
- "objects": props, accessories, or background items that are incidental (e.g. a handbag next to a shirt being sold — handbag goes in objects, not primaryObjects)

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "primaryObjects": ["e.g. ['kurta'], ['sneakers'], ['handbag']"],
  "objects": ["any other incidental items visible but NOT the main product"],
  "brand": "visible brand name or null",
  "colour": "single dominant colour of the product",
  "colours": ["all colours present"],
  "category": "broad category: clothing, footwear, accessories, jewellery, bags",
  "subcategory": "specific type: e.g. t-shirt, running shoes, tote bag",
  "tags": ["style, pattern, occasion, age group tags"],
  "attributes": {
    "gender": "men / women / unisex / kids or null",
    "fabric": "fabric/material if visible or null",
    "size": "size if visible on label/tag or null"
  },
  "confidence": 0.95
}`,

  beauty: `You are a beauty product catalog AI. Analyze this beauty/personal care product image.

Focus on the product packaging and label. Extract text from the label where possible.

Distinguish:
- "primaryObjects": the beauty product(s) this listing is ACTUALLY SELLING
- "objects": props or background items that are incidental

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "primaryObjects": ["e.g. ['lipstick'], ['moisturizer'], ['foundation']"],
  "objects": ["any other incidental items visible but NOT the main product"],
  "brand": "brand name from label or null",
  "colour": "shade/colour if applicable (e.g. for lipstick, eyeshadow) or null",
  "colours": ["all shades/colours present"],
  "category": "broad category: skincare, haircare, makeup, fragrance, personal care",
  "subcategory": "specific type: e.g. lipstick, serum, shampoo",
  "tags": ["finish, texture, benefit, formulation tags"],
  "attributes": {
    "gender": "men / women / unisex or null",
    "skin_type": "oily / dry / combination / sensitive / all or null"
  },
  "confidence": 0.95
}`,

  electronics: `You are an electronics product catalog AI. Analyze this electronics product image.

Read any text, labels, or spec stickers visible on the product or packaging.
Focus on extracting model identifiers and specifications precisely.

Distinguish:
- "primaryObjects": the electronic product(s) this listing is ACTUALLY SELLING
- "objects": props, cables, or accessories that are incidental and not the main product

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "primaryObjects": ["e.g. ['smartphone'], ['laptop'], ['headphones']"],
  "objects": ["any other incidental items visible but NOT the main product"],
  "brand": "brand name from product or label or null",
  "colour": "product colour/finish or null",
  "colours": ["all colour variants visible"],
  "category": "broad category: smartphones, laptops, audio, cameras, appliances, accessories",
  "subcategory": "specific type: e.g. gaming laptop, true wireless earbuds",
  "tags": ["key feature tags: 5G, OLED, wireless, foldable etc."],
  "attributes": {
    "model": "model name/number if visible or null",
    "model_year": "year if visible or null",
    "ram": "RAM spec if visible e.g. '8GB' or null",
    "storage": "storage spec if visible e.g. '256GB' or null",
    "screen_size": "screen size if visible e.g. '6.7 inch' or null"
  },
  "confidence": 0.95
}`,

  food: `You are a food product catalog AI. Analyze this food product image.

The image may show packaged food, a prepared dish, or raw ingredients.
For packaged food: read brand and product name from the label.
For prepared dishes: identify the dish type and cuisine.
For raw ingredients: identify the ingredient.

Distinguish:
- "primaryObjects": the food item(s) this listing is ACTUALLY SELLING
- "objects": props, plates, cutlery, or garnishes that are incidental

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "primaryObjects": ["e.g. ['pasta'], ['chocolate cake'], ['basmati rice']"],
  "objects": ["any other incidental items visible but NOT the main product"],
  "brand": "brand name if packaged product, otherwise null",
  "colour": null,
  "colours": [],
  "category": "broad category: snacks, beverages, dairy, grains, bakery, ready-to-eat, fresh produce",
  "subcategory": "specific type: e.g. instant noodles, fruit juice, whole wheat bread",
  "tags": ["flavour, occasion, preparation-method tags"],
  "attributes": {
    "cuisine": "cuisine type if applicable e.g. Indian, Italian or null",
    "dietary": ["dietary flags: vegan, vegetarian, gluten-free, halal etc."] ,
    "ingredients": ["key visible ingredients if identifiable"]
  },
  "confidence": 0.95
}`,

  grocery: `You are a grocery product catalog AI. Analyze this grocery product image.

The image may show packaged grocery items (branded) or raw produce (unbranded).
For packaged items: read the label for brand, product name, and pack size.
For raw produce: identify the item and estimate quantity/weight if visible.

Distinguish:
- "primaryObjects": the grocery item(s) this listing is ACTUALLY SELLING
- "objects": props, bags, or background items that are incidental

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "primaryObjects": ["e.g. ['tomatoes'], ['Amul butter'], ['atta flour']"],
  "objects": ["any other incidental items visible but NOT the main product"],
  "brand": "brand name from label or null if unbranded produce",
  "colour": null,
  "colours": [],
  "category": "broad category: produce, dairy, staples, beverages, packaged foods, cleaning",
  "subcategory": "specific type: e.g. leafy vegetables, cooking oil, breakfast cereal",
  "tags": ["organic, fresh, imported, seasonal tags if applicable"],
  "attributes": {
    "size": "pack size or weight if visible e.g. '500g', '1kg', '6 pack' or null",
    "dietary": ["vegan, gluten-free, organic etc. if visible"],
    "ingredients": ["key ingredients if visible on label"]
  },
  "confidence": 0.95
}`,
};

/**
 * Returns the Gemini extraction prompt for a given domain.
 * Falls back to a generic prompt if the domain is unknown.
 */
export const getExtractionPrompt = (domain) => {
  if (domain && DOMAIN_PROMPTS[domain]) return DOMAIN_PROMPTS[domain];

  // Generic fallback — same as the old PRODUCT_ANALYSIS_PROMPT but with
  // primaryObjects/objects split and an empty attributes map.
  return `You are a product catalog AI. Carefully analyze this product image.

Distinguish carefully:
- "primaryObjects": the product(s) this listing is ACTUALLY SELLING (most prominent/central item)
- "objects": props or background items that are incidental and NOT the main product

Return ONLY a raw JSON object (no markdown, no code fences):
{
  "primaryObjects": ["the product(s) this item is actually selling"],
  "objects": ["all OTHER incidental/prop objects visible but NOT the main product"],
  "brand": "brand name if visible, otherwise null",
  "colour": "single dominant colour",
  "colours": ["all colours present in the product"],
  "category": "broad category (e.g. footwear, clothing, electronics, furniture, food)",
  "subcategory": "specific subcategory or null",
  "tags": ["descriptive search tags like material, style, pattern, gender, age group"],
  "attributes": {},
  "confidence": 0.95
}`;
};

/**
 * Returns the scoring weight map for a given domain.
 * Falls back to generic equal weights if domain is unknown.
 */
export const getScoringWeights = (domain) => {
  if (domain && DOMAIN_SCORING_WEIGHTS[domain]) return DOMAIN_SCORING_WEIGHTS[domain];
  // Generic fallback — original hardcoded weights
  return { category: 0.35, brand: 0.25, colour: 0.20, tags: 0.20 };
};
