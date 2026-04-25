import { generateEmbedding } from '../services/embeddingService.js';
import { knnSearch, hybridKnnSearch } from '../services/elasticsearchService.js';
import { analyzeSearchImage, processTextQuery } from '../services/geminiService.js';
import { preprocessSearchImage, cropByBbox } from '../services/imagePreprocessService.js';
import { embedImage } from '../services/clipService.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * First-word re-rank — exact keyword matches float to the top of the set.
 * Applied after ES returns results; preserves relative ordering within each
 * (matches / doesn't match) bucket by ES score.
 */
const rerankByFirstWord = (results, firstWord) => {
  const keyword = (firstWord || '').toLowerCase();
  if (!keyword) return results;
  return results.sort((a, b) => {
    const aFields = [a.title, a.category, a.brand, ...(a.tags || []), ...(a.objects || [])]
      .join(' ')
      .toLowerCase();
    const bFields = [b.title, b.category, b.brand, ...(b.tags || []), ...(b.objects || [])]
      .join(' ')
      .toLowerCase();
    const aMatch = aFields.includes(keyword);
    const bMatch = bFields.includes(keyword);
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return b.score - a.score;
  });
};

// ─── POST /search ───────────────────────────────────────────────────────────

/**
 * Unified search endpoint.
 *
 * Body (multipart/form-data):
 *   query    — text search string (any language)      [optional]
 *   image    — product image file                     [optional]
 *   element  — zero-based element index (form field OR query param)
 *              Only meaningful if `image` is provided.
 *
 * Pipeline (image):
 *   multer buffer
 *     → sharp preprocess (blur detect, sharpen/denoise, resize, strip EXIF)
 *     → Gemini Vision → { elements: [{name, bbox, attributes, searchText, firstWord}, ...] }
 *     → Crop each element by its bbox (tiny crops get padded + upscaled)
 *     → CLIP-embed each crop → per-element image vectors
 *     → Text-embed each element's searchText → per-element text vectors
 *     → Hybrid KNN (text + image, blended) for the selected element
 *
 * Pipeline (text):
 *   Gemini language detect + translate → searchText + firstWord → text embedding → KNN
 */
export const search = async (req, res) => {
  const { query } = req.body;
  const imageFile = req.file;

  const rawElementIndex =
    (req.body && req.body.element) !== undefined ? req.body.element : req.query.element;
  const selectedIndex = rawElementIndex !== undefined ? parseInt(rawElementIndex, 10) : 0;

  if (!query && !imageFile) {
    return res.status(400).json({
      error: 'Provide at least one of: "query" (text) or "image" (file).',
      example: {
        text: 'POST /search with form field: query="red nike running shoes"',
        image: 'POST /search with form field: image=<file>',
        multiElement: 'POST /search?element=1 with form field: image=<file>',
      },
    });
  }

  // ── Branch A: Image Search ────────────────────────────────────────────────
  if (imageFile) {
    // 1. Preprocess the whole image — EXIF fix, resize, conditional sharpen
    let processed;
    try {
      processed = await preprocessSearchImage(imageFile.buffer);
    } catch (err) {
      return res.status(422).json({ error: `Image preprocessing failed: ${err.message}` });
    }

    // 2. Gemini Vision → structured elements (with bboxes, no people)
    let imageAnalysis;
    try {
      imageAnalysis = await analyzeSearchImage(processed.buffer, processed.mimeType);
    } catch (err) {
      return res.status(422).json({ error: `Image analysis failed: ${err.message}` });
    }

    const elements = imageAnalysis.elements || [];
    if (elements.length === 0) {
      return res.status(422).json({
        error: 'No searchable products detected in image',
        preprocessing: processed.metrics,
        hint: 'Try a photo focused on a product. Faces or empty scenes are skipped.',
      });
    }

    // Enforce 10-element cap (defence in depth — analyzeSearchImage already caps)
    const capped = elements.slice(0, 10);
    const safeIndex = Math.min(Math.max(selectedIndex, 0), capped.length - 1);
    const selected = capped[safeIndex];

    // 3. Crop + CLIP-embed each element. We embed ALL elements so a client
    //    re-query with ?element=N doesn't need another upload — the vectors
    //    are already computed in this single request.
    //
    //    Failure is per-element and non-fatal: if CLIP blows up for one
    //    element we fall back to text-only for that element's search.
    const elementVectors = await Promise.all(
      capped.map(async (el) => {
        let imageVector = null;
        let cropInfo = null;
        try {
          const cropped = await cropByBbox(processed.buffer, el.bbox);
          cropInfo = { width: cropped.width, height: cropped.height, upscaled: cropped.upscaled };
          imageVector = await embedImage(cropped.buffer);
        } catch (err) {
          cropInfo = { error: err.message };
        }
        return { imageVector, cropInfo };
      })
    );

    // 4. Build the query text (merge user's optional text with Gemini's searchText)
    let searchText = selected.searchText;
    if (query) searchText = `${searchText} ${query}`.trim();

    // 5. Text embedding for the selected element
    let textEmbedding;
    try {
      textEmbedding = await generateEmbedding(searchText);
    } catch (err) {
      return res.status(500).json({ error: `Text embedding failed: ${err.message}` });
    }

    // 6. Hybrid KNN: blended text + image cosine (falls back to text-only
    //    automatically if the selected element had no image vector).
    let searchResults;
    try {
      searchResults = await hybridKnnSearch(
        textEmbedding,
        elementVectors[safeIndex].imageVector,
        {
          firstWord: selected.firstWord,
          k: 20,
          minScore: 0.25,
          textWeight: 0.5,
          imageWeight: 0.5,
        }
      );
    } catch (err) {
      return res.status(500).json({ error: `Search failed: ${err.message}` });
    }

    searchResults = rerankByFirstWord(searchResults, selected.firstWord);

    return res.json({
      searchSource: 'image',
      multiElement: capped.length > 1,
      elements: capped.map((e, i) => ({
        index: i,
        name: e.name,
        firstWord: e.firstWord,
        searchText: e.searchText,
        attributes: e.attributes || {},
        bbox: e.bbox || null,
        cropInfo: elementVectors[i].cropInfo,
        hasImageVector: !!elementVectors[i].imageVector,
      })),
      selectedElement: {
        index: safeIndex,
        name: selected.name,
        hasImageVector: !!elementVectors[safeIndex].imageVector,
      },
      preprocessing: processed.metrics,
      query: {
        original: query || null,
        searchText,
        primaryTerm: selected.firstWord,
        detectedLanguage: 'en',
        translationApplied: false,
      },
      extractedAttributes: selected.attributes || {},
      scoring: { mode: elementVectors[safeIndex].imageVector ? 'hybrid' : 'text-only' },
      totalResults: searchResults.length,
      results: searchResults.slice(0, 10),
      note: capped.length > 1
        ? `Image contained ${capped.length} products. Showing results for "${selected.name}". ` +
          `Re-query with ?element=<index> to search for a different element.`
        : undefined,
    });
  }

  // ── Branch B: Text Search ─────────────────────────────────────────────────
  let textAnalysis;
  try {
    textAnalysis = await processTextQuery(query);
  } catch (err) {
    return res.status(422).json({ error: `Text analysis failed: ${err.message}` });
  }

  const searchText = textAnalysis.translatedText;
  const firstWord = textAnalysis.firstWord;
  const extractedAttributes = textAnalysis.attributes || {};
  const detectedLanguage = textAnalysis.detectedLanguage || 'en';
  const translationApplied = detectedLanguage !== 'en';

  let textEmbedding;
  try {
    textEmbedding = await generateEmbedding(searchText);
  } catch (err) {
    return res.status(500).json({ error: `Embedding generation failed: ${err.message}` });
  }

  let searchResults;
  try {
    searchResults = await knnSearch(textEmbedding, { firstWord, k: 20, minScore: 0.25 });
  } catch (err) {
    return res.status(500).json({ error: `Search failed: ${err.message}` });
  }

  searchResults = rerankByFirstWord(searchResults, firstWord);

  return res.json({
    searchSource: 'text',
    multiElement: false,
    query: {
      original: query,
      searchText,
      primaryTerm: firstWord,
      detectedLanguage,
      translationApplied,
    },
    extractedAttributes,
    scoring: { mode: 'text-only' },
    totalResults: searchResults.length,
    results: searchResults.slice(0, 10),
  });
};
