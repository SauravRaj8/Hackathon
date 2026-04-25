import { esClient } from '../config/elasticsearch.js';

const INDEX_NAME = process.env.ES_INDEX_NAME || 'catalogue_products';
// These must match TEXT_EMBEDDING_DIMS / IMAGE_EMBEDDING_DIMS in the service files.
// Override via env vars to keep the index mapping in sync with what the models produce.
const EMBEDDING_DIMS = parseInt(process.env.TEXT_EMBEDDING_DIMS || '768', 10);
const IMAGE_EMBEDDING_DIMS = parseInt(process.env.IMAGE_EMBEDDING_DIMS || '512', 10);

// ─── Index Management ───────────────────────────────────────────────────────

/**
 * Creates the Elasticsearch 7.x index with dense_vector mappings for both
 * the text embedding (from text-embedding-004, 768-d) and the image embedding
 * (from CLIP ViT-B/32, 512-d).
 *
 * If the index already exists without the imageEmbedding field (e.g. the
 * catalogue was built before CLIP was added), we hot-patch the mapping via
 * put_mapping — ES 7 allows adding new fields to an existing index.
 */
export const ensureIndexExists = async () => {
  const { body: exists } = await esClient.indices.exists({ index: INDEX_NAME });
  if (exists) {
    console.log(`[Elasticsearch] Index '${INDEX_NAME}' already exists`);
    // Backfill: make sure newer fields are present on legacy indices.
    // ES 7 lets us add new fields to an existing mapping in-place.
    try {
      const { body: mapping } = await esClient.indices.getMapping({ index: INDEX_NAME });
      const indexKey = Object.keys(mapping)[0];
      const props = mapping[indexKey]?.mappings?.properties || {};
      const additions = {};
      if (!props.imageEmbedding) {
        additions.imageEmbedding = { type: 'dense_vector', dims: IMAGE_EMBEDDING_DIMS };
      }
      if (!props.imageUrls) {
        // Multi-image support: array of URLs alongside the primary `imageUrl`.
        additions.imageUrls = { type: 'keyword', index: false };
      }
      if (!props.primaryObjects) {
        additions.primaryObjects = { type: 'keyword' };
      }
      if (!props.domain) {
        additions.domain = { type: 'keyword' };
      }
      if (!props.attributes) {
        // Domain-specific key/value pairs (gender, model, ram, skin_type, etc.)
        // Stored as a flat object; individual keys are not mapped — dynamic mapping
        // handles them. Not used for vector search; available for facet filters.
        additions.attributes = { type: 'object', dynamic: true };
      }
      if (Object.keys(additions).length > 0) {
        await esClient.indices.putMapping({
          index: INDEX_NAME,
          body: { properties: additions },
        });
        console.log(
          `[Elasticsearch] Hot-patched mapping with: ${Object.keys(additions).join(', ')}`
        );
      }
    } catch (err) {
      console.warn('[Elasticsearch] Could not verify/patch mapping:', err.message);
    }
    return;
  }

  await esClient.indices.create({
    index: INDEX_NAME,
    body: {
      mappings: {
        properties: {
          id: { type: 'keyword' },
          sku: { type: 'keyword' },
          title: {
            type: 'text',
            analyzer: 'standard',
            fields: { keyword: { type: 'keyword' } },
          },
          brand: { type: 'keyword' },
          colour: { type: 'keyword' },
          colours: { type: 'keyword' },
          category: { type: 'keyword' },
          subcategory: { type: 'keyword' },
          tags: { type: 'keyword' },
          // primaryObjects: the item(s) this listing is actually selling.
          // Used in keyword filters and the text embedding.
          primaryObjects: { type: 'keyword' },
          // objects: incidental/prop items also visible in the image.
          // Stored for audit/display only — NOT used in search scoring or filters.
          objects: { type: 'keyword' },
          // domain: fashion / beauty / electronics / food / grocery
          domain: { type: 'keyword' },
          // attributes: domain-specific fields (gender, model, ram, skin_type, etc.)
          attributes: { type: 'object', dynamic: true },
          imageUrl: { type: 'keyword', index: false },
          // Multi-image: full ordered list of URLs (imageUrl is the primary
          // = imageUrls[0]). Not indexed for search — display-only.
          imageUrls: { type: 'keyword', index: false },
          qualityScore: { type: 'float' },
          // Text embedding (from product attributes text)
          embedding: {
            type: 'dense_vector',
            dims: EMBEDDING_DIMS,
          },
          // CLIP image embedding (from the product's image pixels)
          imageEmbedding: {
            type: 'dense_vector',
            dims: IMAGE_EMBEDDING_DIMS,
          },
          createdAt: { type: 'date' },
        },
      },
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
      },
    },
  });

  console.log(`[Elasticsearch] Index '${INDEX_NAME}' created with text + image vectors`);
};

// ─── Indexing ───────────────────────────────────────────────────────────────

/**
 * Upserts a product document into Elasticsearch.
 *
 * Multi-image: `product.imageUrls` is an ordered list; `product.imageUrl` is
 * the primary (= imageUrls[0]). The single `imageEmbedding` argument is the
 * mean-pooled aggregate across all images (callers compute this via
 * clipService.embedImagesMeanPooled). For single-image products this is
 * just the lone vector — unchanged behaviour from before.
 *
 * @param {Object} product — product metadata (must have `imageUrl`; optional `imageUrls[]`)
 * @param {number[]} embedding — 768-dim text embedding
 * @param {number[]|null} imageEmbedding — 512-dim CLIP image embedding (mean-pooled across images, nullable)
 */
export const indexDocument = async (product, embedding, imageEmbedding = null) => {
  // Normalise imageUrls — older callers may only pass `imageUrl`.
  const imageUrls = Array.isArray(product.imageUrls) && product.imageUrls.length > 0
    ? product.imageUrls
    : (product.imageUrl ? [product.imageUrl] : []);
  const primaryImageUrl = product.imageUrl || imageUrls[0] || null;

  const doc = {
    id: product.id,
    sku: product.sku || null,
    title: product.title || null,
    brand: product.brand || null,
    colour: product.colour || null,
    colours: product.colours || [],
    category: product.category || null,
    subcategory: product.subcategory || null,
    tags: product.tags || [],
    // primaryObjects: what this product actually IS (drives search + embedding).
    // Falls back to objects[] for legacy products that pre-date the split.
    primaryObjects: product.primaryObjects && product.primaryObjects.length > 0
      ? product.primaryObjects
      : (product.objects || []),
    // objects: everything else visible in the image — stored for audit, not searched.
    objects: product.objects || [],
    // domain: fashion / beauty / electronics / food / grocery (null for legacy)
    domain: product.domain || null,
    // attributes: domain-specific fields — stored as-is for facet filtering
    attributes: product.attributes || {},
    imageUrl: primaryImageUrl,
    imageUrls,
    qualityScore: product.qualityScore,
    embedding,
    createdAt: new Date(),
  };

  // Only include imageEmbedding if we have one — otherwise the field is
  // left absent on the doc, and the hybrid query's doc['imageEmbedding'].size()
  // check will skip it gracefully.
  if (Array.isArray(imageEmbedding) && imageEmbedding.length > 0) {
    doc.imageEmbedding = imageEmbedding;
  }

  await esClient.index({
    index: INDEX_NAME,
    id: product.id,
    body: doc,
    refresh: 'wait_for',
  });
};

// ─── Vector Search (ES 7 — exact cosine via script_score) ──────────────────

/**
 * Text-only KNN search over the `embedding` field. Preserved for backward
 * compatibility and for text queries that don't need CLIP-side matching.
 */
export const knnSearch = async (queryEmbedding, { firstWord = null, domain = null, k = 20, minScore = 0.3 } = {}) => {
  const mustMatch = [{ match_all: {} }];
  if (firstWord) {
    mustMatch[0] = {
      multi_match: {
        query: firstWord,
        fields: ['title^3', 'category^2', 'brand^2', 'tags', 'primaryObjects'],
        type: 'best_fields',
        minimum_should_match: '1',
      },
    };
  }
  // Optional domain filter — narrows results to a specific product domain.
  if (domain) {
    mustMatch.push({ term: { domain } });
  }

  const { body: response } = await esClient.search({
    index: INDEX_NAME,
    body: {
      size: k,
      min_score: minScore,
      query: {
        script_score: {
          query: { bool: { must: mustMatch } },
          script: {
            source: "cosineSimilarity(params.query_vector, 'embedding') + 1.0",
            params: { query_vector: queryEmbedding },
          },
        },
      },
      _source: { excludes: ['embedding', 'imageEmbedding'] },
    },
  });

  return response.hits.hits
    .filter((hit) => hit._score >= minScore)
    .map((hit) => ({
      id: hit._id,
      score: parseFloat(hit._score.toFixed(4)),
      ...hit._source,
    }));
};

/**
 * Hybrid KNN combining text and image embeddings via blended cosine scores.
 * If a document is missing its imageEmbedding (legacy catalog before CLIP
 * was wired in), its image term contributes 0 and the text term decides.
 *
 * Score formula (per doc):
 *   textSim = cosineSimilarity(textVec, 'embedding') + 1.0     // in [0, 2]
 *   imgSim  = cosineSimilarity(imgVec,  'imageEmbedding') + 1.0 // in [0, 2] or 0 if missing
 *   final   = textWeight * textSim + imageWeight * imgSim
 *
 * Default blend is 50/50. Tune via options.
 */
export const hybridKnnSearch = async (
  textEmbedding,
  imageEmbedding,
  {
    firstWord = null,
    domain = null,
    k = 20,
    minScore = 0.3,
    textWeight = 0.5,
    imageWeight = 0.5,
  } = {}
) => {
  const mustMatch = [{ match_all: {} }];
  if (firstWord) {
    mustMatch[0] = {
      multi_match: {
        query: firstWord,
        fields: ['title^3', 'category^2', 'brand^2', 'tags', 'primaryObjects'],
        type: 'best_fields',
        minimum_should_match: '1',
      },
    };
  }
  // Optional domain filter — narrows results to a specific product domain.
  if (domain) {
    mustMatch.push({ term: { domain } });
  }

  const haveImageVec = Array.isArray(imageEmbedding) && imageEmbedding.length > 0;

  // When we don't have an image vector, delegate to text-only KNN
  if (!haveImageVec) {
    return knnSearch(textEmbedding, { firstWord, domain, k, minScore });
  }

  const { body: response } = await esClient.search({
    index: INDEX_NAME,
    body: {
      size: k,
      min_score: minScore,
      query: {
        script_score: {
          query: { bool: { must: mustMatch } },
          script: {
            // Guard against docs missing imageEmbedding (legacy) — skip their image term.
            source: `
              double textSim = cosineSimilarity(params.text_vec, 'embedding') + 1.0;
              double imgSim = doc['imageEmbedding'].size() == 0
                ? 0.0
                : cosineSimilarity(params.img_vec, 'imageEmbedding') + 1.0;
              return params.tw * textSim + params.iw * imgSim;
            `,
            params: {
              text_vec: textEmbedding,
              img_vec: imageEmbedding,
              tw: textWeight,
              iw: imageWeight,
            },
          },
        },
      },
      _source: { excludes: ['embedding', 'imageEmbedding'] },
    },
  });

  return response.hits.hits
    .filter((hit) => hit._score >= minScore)
    .map((hit) => ({
      id: hit._id,
      score: parseFloat(hit._score.toFixed(4)),
      ...hit._source,
    }));
};
