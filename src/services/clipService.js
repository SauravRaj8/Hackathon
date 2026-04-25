import sharp from 'sharp';
import axios from 'axios';

// ─── CLIP via transformers.js ──────────────────────────────────────────────
// We use Xenova/clip-vit-base-patch32 — 512-dim image+text embeddings in a
// shared space. Model weights are downloaded to ./.cache on first call and
// then memoised in memory. All image I/O is done by our outer `sharp` so
// we never touch transformers.js's internal sharp dependency.

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

// The native output of CLIP ViT-B/32's projection head is 512-d.
// However some ONNX exports of the same model (or alternate quantisations)
// may return a different size. We detect the actual size at runtime and
// normalise to IMAGE_EMBEDDING_DIMS so Elasticsearch always gets consistent vectors.
// Set IMAGE_EMBEDDING_DIMS env var to match your ES index mapping (default 512).
export const CLIP_DIMS = 512; // native model output (kept for reference)
export const IMAGE_EMBEDDING_DIMS = parseInt(process.env.IMAGE_EMBEDDING_DIMS || '512', 10);

// Target shape CLIP-ViT-B/32 expects for the vision tower
const CLIP_IMAGE_SIZE = 224;

// CLIP normalisation constants (OpenAI original)
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

// Lazy singletons — loading the model is ~100–200MB and slow, so do it once
let processorPromise = null;
let visionModelPromise = null;
let textModelPromise = null;
let tokenizerPromise = null;

const loadTransformers = async () => {
  // ESM dynamic import — avoids forcing @xenova/transformers to be a hard
  // require at boot time, so the API server doesn't stall if CLIP is unused.
  const t = await import('@xenova/transformers');

  // Disable local model fetching from the filesystem — we always pull from the Hub
  if (t.env) {
    t.env.allowLocalModels = false;
    // Keep a dedicated on-disk cache so repeated boots don't re-download
    if (t.env.cacheDir === undefined) t.env.cacheDir = './.cache/transformers';
  }

  return t;
};

/**
 * Ensures the CLIP vision model and image-processing helpers are loaded.
 * First call is slow (model download + ONNX init); subsequent calls are instant.
 */
const ensureVisionModel = async () => {
  if (visionModelPromise) return { visionModel: await visionModelPromise };

  const t = await loadTransformers();
  visionModelPromise = t.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID);
  return { visionModel: await visionModelPromise };
};

const ensureTextModel = async () => {
  if (textModelPromise && tokenizerPromise) {
    return { textModel: await textModelPromise, tokenizer: await tokenizerPromise };
  }
  const t = await loadTransformers();
  if (!textModelPromise) textModelPromise = t.CLIPTextModelWithProjection.from_pretrained(MODEL_ID);
  if (!tokenizerPromise) tokenizerPromise = t.AutoTokenizer.from_pretrained(MODEL_ID);
  return { textModel: await textModelPromise, tokenizer: await tokenizerPromise };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Converts a raw image buffer into the normalised 1x3x224x224 float32 tensor
 * CLIP expects. We do this ourselves via `sharp` so we don't depend on
 * transformers.js's image loaders (which need extra native packages).
 */
const bufferToClipTensor = async (buffer) => {
  // 1. Resize to 224x224 with bicubic, centre-crop fallback, convert to RGB raw bytes.
  const { data, info } = await sharp(buffer)
    .rotate() // honour EXIF orientation
    .resize(CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) {
    throw new Error(`Expected 3 channels after removeAlpha, got ${info.channels}`);
  }

  // 2. Normalise HWC uint8 → CHW float32 with CLIP's mean/std
  const pixels = data.length / 3;
  const float = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    const r = data[i * 3] / 255;
    const g = data[i * 3 + 1] / 255;
    const b = data[i * 3 + 2] / 255;
    float[0 * pixels + i] = (r - CLIP_MEAN[0]) / CLIP_STD[0];
    float[1 * pixels + i] = (g - CLIP_MEAN[1]) / CLIP_STD[1];
    float[2 * pixels + i] = (b - CLIP_MEAN[2]) / CLIP_STD[2];
  }

  // 3. Wrap in a transformers.js Tensor of shape [1, 3, 224, 224]
  const t = await loadTransformers();
  return new t.Tensor('float32', float, [1, 3, CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE]);
};

/**
 * L2-normalises a Float32Array (or plain number[]) in place.
 * CLIP embeddings are unit-norm by convention so cosine similarity = dot product.
 */
const l2normalise = (vec) => {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
};

/**
 * Resizes a Float32Array to exactly `targetDim` by truncating or zero-padding,
 * then L2-normalises. This keeps Elasticsearch's dense_vector field happy when
 * the model returns a different number of floats than the index mapping expects.
 *
 * Truncation is Matryoshka-safe for projection-head CLIP variants.
 * Zero-padding is only a last resort for up-sizing.
 */
const resizeAndNormalise = (vec, targetDim) => {
  if (vec.length === targetDim) {
    l2normalise(vec);
    return vec;
  }
  let resized;
  if (vec.length > targetDim) {
    resized = new Float32Array(targetDim);
    resized.set(vec.subarray(0, targetDim));
  } else {
    resized = new Float32Array(targetDim); // zero-initialised
    resized.set(vec);
  }
  l2normalise(resized);
  return resized;
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Downloads an image from a URL (used by the ingest worker / approve flow).
 * Returns a Buffer suitable for embedImage.
 */
export const downloadImageBuffer = async (url) => {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'CatalogueBot/1.0' },
  });
  return Buffer.from(res.data);
};

/**
 * Embeds an image into CLIP's 512-dim space.
 * @param {Buffer} buffer raw image bytes (any format sharp can read)
 * @returns {Promise<number[]>} unit-norm 512-dim vector as a plain array
 */
export const embedImage = async (buffer) => {
  const { visionModel } = await ensureVisionModel();
  const pixelValues = await bufferToClipTensor(buffer);

  const output = await visionModel({ pixel_values: pixelValues });
  // CLIPVisionModelWithProjection returns { image_embeds: Tensor[1, N] }
  const embeds = output.image_embeds ?? output.last_hidden_state;
  const flat = new Float32Array(embeds.data);
  if (flat.length !== IMAGE_EMBEDDING_DIMS) {
    console.warn(
      `[CLIP] image embedding is ${flat.length}-dim, expected ${IMAGE_EMBEDDING_DIMS} ` +
      `— resizing to ${IMAGE_EMBEDDING_DIMS} (truncate/pad + L2-normalise).`
    );
    return Array.from(resizeAndNormalise(flat, IMAGE_EMBEDDING_DIMS));
  }
  l2normalise(flat);
  // ES dense_vector wants plain JS number[] (JSON-serialisable), not Float32Array
  return Array.from(flat);
};

/**
 * Embeds a piece of text into CLIP's 512-dim space (shared with image space).
 * Useful for text queries that want CLIP-side matching against image vectors.
 */
export const embedText = async (text) => {
  const { textModel, tokenizer } = await ensureTextModel();

  // Safety: CLIP's text tower has a 77-token limit; truncate long inputs.
  const inputs = await tokenizer(text, { padding: true, truncation: true, max_length: 77 });
  const output = await textModel(inputs);
  const embeds = output.text_embeds ?? output.last_hidden_state;
  const flat = new Float32Array(embeds.data);
  if (flat.length !== IMAGE_EMBEDDING_DIMS) {
    console.warn(
      `[CLIP] text embedding is ${flat.length}-dim, expected ${IMAGE_EMBEDDING_DIMS} ` +
      `— resizing to ${IMAGE_EMBEDDING_DIMS} (truncate/pad + L2-normalise).`
    );
    return Array.from(resizeAndNormalise(flat, IMAGE_EMBEDDING_DIMS));
  }
  l2normalise(flat);
  return Array.from(flat);
};

/**
 * Embeds multiple images and returns a mean-pooled, L2-normalised aggregate
 * vector along with the per-image vectors that produced it.
 *
 * Why mean-pool? Elasticsearch 7's `dense_vector` field stores a single
 * vector per document — it does not support arrays of vectors. Mean-pooling
 * unit-norm CLIP embeddings produces a centroid in the same 512-d space that
 * captures the "average appearance" of the product across all its images,
 * and degenerates to the single-image case when there is only one image.
 * Per-image vectors are still returned so callers can persist them (e.g. in
 * Mongo) for audit or future re-indexing under a different strategy.
 *
 * Failure handling: per-image embedding failures are skipped (logged via
 * `errors[]`), not propagated. If every image fails the function throws.
 *
 * @param {Buffer[]} buffers raw image bytes for each image (in order)
 * @param {Object} [options]
 * @param {number[][]} [options.precomputed] — already-computed per-image
 *   vectors. When supplied, `buffers` is ignored and only the mean is
 *   recomputed. Useful for re-pooling after editing the image list.
 * @returns {Promise<{ mean: number[], perImage: number[][], errors: Array<{index:number,error:string}> }>}
 */
export const embedImagesMeanPooled = async (buffers, options = {}) => {
  let perImage;
  const errors = [];

  if (Array.isArray(options.precomputed) && options.precomputed.length > 0) {
    perImage = options.precomputed;
  } else {
    if (!Array.isArray(buffers) || buffers.length === 0) {
      throw new Error('embedImagesMeanPooled: at least one image buffer is required');
    }
    perImage = [];
    // Sequential to keep memory + CPU pressure predictable. CLIP is cheap
    // per call; the bottleneck is usually network/IO upstream, not us.
    for (let i = 0; i < buffers.length; i++) {
      try {
        const vec = await embedImage(buffers[i]);
        perImage.push(vec);
      } catch (err) {
        errors.push({ index: i, error: err.message });
      }
    }
    if (perImage.length === 0) {
      throw new Error(
        `All ${buffers.length} image embeddings failed: ${errors.map((e) => e.error).join('; ')}`
      );
    }
  }

  // Mean-pool across whichever vectors we have, then re-normalise so the
  // result lives back on the unit sphere (matches the existing single-image
  // contract — cosineSimilarity behaves identically).
  const dims = perImage[0].length;
  const mean = new Float32Array(dims);
  for (const vec of perImage) {
    for (let d = 0; d < dims; d++) mean[d] += vec[d];
  }
  for (let d = 0; d < dims; d++) mean[d] /= perImage.length;
  l2normalise(mean);

  return { mean: Array.from(mean), perImage, errors };
};

/**
 * Warms up the model so the first real request doesn't pay the ~5–10s init
 * cost. Call once at boot (fire-and-forget is fine).
 */
export const warmupClip = async () => {
  try {
    // Tiny 32x32 solid image — enough to force model init
    const dummy = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 128, g: 128, b: 128 } },
    }).jpeg().toBuffer();
    await embedImage(dummy);
    console.log('[CLIP] warmup complete');
  } catch (err) {
    console.warn('[CLIP] warmup failed — first real call will pay the init cost:', err.message);
  }
};
