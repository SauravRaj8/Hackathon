/**
 * Catalogue Ingest Worker
 *
 * Run independently from the API server:
 *   node src/workers/ingestWorker.js
 *
 * Per CSV row (each row may have one OR many image URLs):
 *   1. Analyze image(s) with Gemini Vision
 *      - Default: only the primary (first) image
 *      - Set ANALYZE_ALL_IMAGES=true to analyse every image and merge results
 *   2. CLIP-embed every image (always — CLIP is local and cheap)
 *   3. Score AI attributes vs CSV metadata
 *   4. Below threshold → save to MongoDB as pending (with per-image data)
 *   5. Above threshold → generate text embedding → index in Elasticsearch
 *      (with imageUrls[] and the mean-pooled image vector)
 */

import 'dotenv/config';
import { Worker } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';

import { redisConnection } from '../config/queue.js';
import { connectDB } from '../config/db.js';
import { ensureIndexExists } from '../services/elasticsearchService.js';
import { analyzeProductImage } from '../services/geminiService.js';
import { calculateQualityScore } from '../services/scoringService.js';
import { generateProductEmbedding } from '../services/embeddingService.js';
import { indexDocument } from '../services/elasticsearchService.js';
import { PendingCatalogue } from '../models/PendingCatalogue.js';
import { embedImagesMeanPooled, downloadImageBuffer, warmupClip } from '../services/clipService.js';

const QUALITY_THRESHOLD = parseFloat(process.env.QUALITY_THRESHOLD || '0.75');
const ANALYZE_ALL_IMAGES = /^(true|1|yes)$/i.test(process.env.ANALYZE_ALL_IMAGES || '');

// ─── Per-image AI merge ────────────────────────────────────────────────────

/**
 * Merges N per-image AI extractions into one aggregate the scoring + approval
 * code can consume. Strategy:
 *   - tags / colours / objects   → union (deduped, preserves first-seen order)
 *   - brand / colour / category /
 *     subcategory                → first non-null across images (primary wins)
 *   - confidence                 → max
 */
const mergeAiExtractions = (extractions) => {
  if (!extractions || extractions.length === 0) {
    return { objects: [], colours: [], tags: [], confidence: 0 };
  }
  if (extractions.length === 1) {
    // Defensive copy with array fallbacks so downstream code never sees undefined.
    const e = extractions[0];
    return {
      primaryObjects: e.primaryObjects || [],
      objects: e.objects || [],
      brand: e.brand || null,
      colour: e.colour || null,
      colours: e.colours || [],
      category: e.category || null,
      subcategory: e.subcategory || null,
      tags: e.tags || [],
      confidence: e.confidence || 0,
    };
  }

  const unionPreserveOrder = (key) => {
    const seen = new Set();
    const out = [];
    for (const e of extractions) {
      for (const v of (e[key] || [])) {
        const norm = String(v).trim();
        if (!norm) continue;
        const lower = norm.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        out.push(norm);
      }
    }
    return out;
  };

  const firstNonNull = (key) => {
    for (const e of extractions) {
      const v = e[key];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  };

  return {
    primaryObjects: unionPreserveOrder('primaryObjects'),
    objects: unionPreserveOrder('objects'),
    brand: firstNonNull('brand'),
    colour: firstNonNull('colour'),
    colours: unionPreserveOrder('colours'),
    category: firstNonNull('category'),
    subcategory: firstNonNull('subcategory'),
    tags: unionPreserveOrder('tags'),
    confidence: Math.max(...extractions.map((e) => e.confidence || 0)),
  };
};

// ─── Job Processor ──────────────────────────────────────────────────────────

const processIngestJob = async (job) => {
  const { rowIndex, mongoId, title, imageUrls, imageUrl, domain, brand, colour, category, tags, sku } = job.data;

  // Backwards compat with any in-flight legacy jobs that only have `imageUrl`.
  const urls = Array.isArray(imageUrls) && imageUrls.length > 0
    ? imageUrls
    : (imageUrl ? [imageUrl] : []);
  if (urls.length === 0) {
    throw new Error(`Row ${rowIndex} has no image URLs`);
  }

  // Retrieve the draft document
  const pendingDoc = await PendingCatalogue.findById(mongoId);
  if (!pendingDoc) {
    throw new Error(`Draft document not found for mongoId: ${mongoId}`);
  }

  // ── Step 1: Gemini Vision Analysis ────────────────────────────────────────
  await job.updateProgress(10);
  job.log(
    `[Row ${rowIndex}] Analyzing ${urls.length} image(s); ` +
    `mode=${ANALYZE_ALL_IMAGES ? 'all' : 'primary-only'}`
  );

  const targets = ANALYZE_ALL_IMAGES ? urls : [urls[0]];
  const aiExtractedPerImage = [];

  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    try {
      // Pass domain so Gemini uses the correct domain-specific extraction prompt.
      const ai = await analyzeProductImage(url, domain);
      aiExtractedPerImage.push({ imageUrl: url, ...ai });
    } catch (err) {
      job.log(`[Row ${rowIndex}] AI analysis failed for image ${i + 1}/${targets.length}: ${err.message}`);
      aiExtractedPerImage.push({ imageUrl: url, error: err.message });
    }
  }

  const successfulExtractions = aiExtractedPerImage.filter((e) => !e.error);
  if (successfulExtractions.length === 0) {
    pendingDoc.status = 'rejected';
    pendingDoc.rejectionReason = `AI analysis failed for all ${targets.length} image(s)`;
    pendingDoc.aiExtractedPerImage = aiExtractedPerImage;
    await pendingDoc.save();
    throw new Error(`All image analyses failed for row ${rowIndex}`);
  }

  const aiExtracted = mergeAiExtractions(successfulExtractions);

  job.log(
    `[Row ${rowIndex}] Merged AI result — category: ${aiExtracted.category}, ` +
    `brand: ${aiExtracted.brand}, colour: ${aiExtracted.colour}, ` +
    `tags: ${aiExtracted.tags.length}, sources: ${successfulExtractions.length}/${targets.length}`
  );

  // ── Step 2: Quality Score Calculation ────────────────────────────────────
  await job.updateProgress(35);
  const csvMetadata = { brand, colour, category, tags };
  const { score, failedFields, fieldScores } = calculateQualityScore(aiExtracted, csvMetadata, domain);

  job.log(
    `[Row ${rowIndex}] Quality score: ${score.toFixed(3)} | threshold: ${QUALITY_THRESHOLD} | failed: [${failedFields.join(', ')}]`
  );

  // ── Step 3: CLIP-embed every image (run regardless of threshold so the
  //          approve flow doesn't have to re-download anything later) ────────
  await job.updateProgress(55);
  let perImageVectors = [];
  let meanImageVector = null;
  try {
    const buffers = [];
    for (const url of urls) {
      try {
        buffers.push(await downloadImageBuffer(url));
      } catch (dlErr) {
        job.log(`[Row ${rowIndex}] CLIP: download failed for ${url}: ${dlErr.message}`);
        buffers.push(null);
      }
    }
    const validBuffers = buffers.filter(Boolean);
    if (validBuffers.length > 0) {
      const result = await embedImagesMeanPooled(validBuffers);
      perImageVectors = result.perImage;
      meanImageVector = result.mean;
      job.log(
        `[Row ${rowIndex}] CLIP: ${perImageVectors.length}/${urls.length} image vectors ` +
        `(${meanImageVector.length}-d mean-pooled)`
      );
    }
  } catch (err) {
    job.log(`[Row ${rowIndex}] CLIP embedding failed (continuing with text-only): ${err.message}`);
  }

  // Persist worker output on the draft regardless of which branch we take.
  pendingDoc.aiExtracted = aiExtracted;
  pendingDoc.aiExtractedPerImage = aiExtractedPerImage;
  pendingDoc.qualityScore = score;
  pendingDoc.fieldScores = fieldScores;
  pendingDoc.failedFields = failedFields;
  pendingDoc.imageEmbeddings = perImageVectors;

  // ── Step 4a: Below threshold OR missing domain → Pending ─────────────────
  const domainMissing = !domain;
  if (score < QUALITY_THRESHOLD || domainMissing) {
    await job.updateProgress(75);
    pendingDoc.status = 'pending';
    if (domainMissing) {
      pendingDoc.pendingReason = pendingDoc.pendingReason || 'Domain missing or invalid';
    } else {
      pendingDoc.pendingReason = `Quality score ${score.toFixed(3)} below threshold ${QUALITY_THRESHOLD}`;
    }
    await pendingDoc.save();

    await job.updateProgress(100);
    job.log(
      `[Row ${rowIndex}] Moved to pending queue. Reason: ${pendingDoc.pendingReason}. ` +
      `MongoDB ID: ${pendingDoc._id}`
    );

    return {
      status: 'pending',
      mongoId: pendingDoc._id.toString(),
      score,
      failedFields,
      pendingReason: pendingDoc.pendingReason,
      rowIndex,
      imageCount: urls.length,
    };
  }

  // ── Step 4b: Above threshold → Approved + Index ─────────────────────────
  await job.updateProgress(80);

  const product = {
    id: uuidv4(),
    sku: sku || null,
    title: title || null,
    imageUrl: urls[0],     // primary (legacy field consumers still read this)
    imageUrls: urls,       // full list
    domain: domain || null,
    brand: aiExtracted.brand || brand || null,
    colour: aiExtracted.colour || colour || null,
    colours: aiExtracted.colours || [],
    category: aiExtracted.category || category || null,
    subcategory: aiExtracted.subcategory || null,
    tags: [...new Set([...(aiExtracted.tags || []), ...(tags || [])])],
    // primaryObjects: what this listing is actually selling (drives embedding + search).
    // Falls back to objects[] if Gemini didn't return the split (old prompt / error).
    primaryObjects: aiExtracted.primaryObjects && aiExtracted.primaryObjects.length > 0
      ? aiExtracted.primaryObjects
      : (aiExtracted.objects || []),
    // objects: incidental/prop items in the image — stored for audit, not searched.
    objects: aiExtracted.objects || [],
    // attributes: domain-specific fields (gender, fabric, model, ram, skin_type, etc.)
    attributes: aiExtracted.attributes || {},
    qualityScore: score,
  };

  job.log(`[Row ${rowIndex}] Generating text embedding for product: ${product.id}`);
  const embedding = await generateProductEmbedding(product);

  await job.updateProgress(90);

  job.log(`[Row ${rowIndex}] Indexing in Elasticsearch (images=${urls.length})...`);
  await indexDocument(product, embedding, meanImageVector);

  // Mark as approved in MongoDB
  pendingDoc.status = 'approved';
  await pendingDoc.save();

  await job.updateProgress(100);
  job.log(`[Row ${rowIndex}] Successfully indexed and approved. ES ID: ${product.id}`);

  return {
    status: 'approved',
    productId: product.id,
    score,
    rowIndex,
    imageCount: urls.length,
  };
};

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const bootstrap = async () => {
  await connectDB();
  await ensureIndexExists();

  // Warm up CLIP so the first job doesn't pay the ~5-10s model init cost.
  // Fire-and-forget — if the model download fails the worker still runs
  // and individual jobs will gracefully skip the image embedding.
  warmupClip().catch(() => {});

  // Drop concurrency a touch when ANALYZE_ALL_IMAGES is on, since each job
  // now fans out to N Gemini calls instead of 1.
  const concurrency = ANALYZE_ALL_IMAGES ? 2 : 3;

  const worker = new Worker('catalogue-ingest', processIngestJob, {
    connection: redisConnection,
    concurrency,
    limiter: {
      max: 10,         // Max 10 jobs
      duration: 60000, // Per 60 seconds (Gemini rate limit protection)
    },
  });

  worker.on('completed', (job, result) => {
    const badge = result.status === 'approved' ? '✅' : '⏳';
    const reasonStr = result.pendingReason ? ` | reason: ${result.pendingReason}` : '';
    console.log(
      `${badge} [Worker] Job ${job.id} | Row ${result.rowIndex} | ${result.status} | ` +
      `score: ${result.score?.toFixed(3)} | images: ${result.imageCount ?? 1}${reasonStr}`
    );
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ [Worker] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[Worker] Unexpected error:', err);
  });

  console.log('🚀 [Worker] Catalogue ingest worker started — waiting for jobs...');
  console.log(`   Quality threshold: ${QUALITY_THRESHOLD}`);
  console.log(`   Concurrency: ${concurrency} jobs`);
  console.log(`   Multi-image AI mode: ${ANALYZE_ALL_IMAGES ? 'ALL images' : 'primary only'}`);
};

bootstrap().catch((err) => {
  console.error('[Worker] Failed to start:', err);
  process.exit(1);
});
