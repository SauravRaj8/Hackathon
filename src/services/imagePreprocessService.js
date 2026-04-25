import sharp from 'sharp';

// ─── Blur detection via Laplacian variance ──────────────────────────────────
// We approximate the Laplacian by applying a 3x3 Laplacian kernel and
// computing the variance of the output. Low variance = blurry. Values below
// ~100 on an 8-bit gray image typically indicate a blurry capture.

const LAPLACIAN_KERNEL = {
  width: 3,
  height: 3,
  kernel: [
    0,  1, 0,
    1, -4, 1,
    0,  1, 0,
  ],
};

const BLUR_THRESHOLD = 120;       // variance below this is considered blurry
const MIN_LONGEST_EDGE = 224;     // upscale tiny images — embeddings need detail
const MAX_LONGEST_EDGE = 1280;    // downscale huge images — keep pipelines fast

/**
 * Computes a Laplacian-variance proxy for focus/sharpness.
 * @param {Buffer} buffer raw image bytes
 * @returns {Promise<number>} variance (higher = sharper)
 */
const computeBlurScore = async (buffer) => {
  // 1. Convert to small-ish grayscale (faster)
  const gray = await sharp(buffer)
    .resize({ width: 512, withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 2. Apply Laplacian convolution (returns raw signed result in 0..255 clipped)
  const { data } = await sharp(gray.data, {
    raw: { width: gray.info.width, height: gray.info.height, channels: 1 },
  })
    .convolve(LAPLACIAN_KERNEL)
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 3. Variance
  let sum = 0;
  let sumSq = 0;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
};

/**
 * Pipeline:
 *   1. Measure blur (Laplacian variance).
 *   2. Resize if image is tiny or huge.
 *   3. Strip metadata & normalise contrast always.
 *   4. If blurry, apply an unsharp mask + light median denoise.
 *
 * @param {Buffer} inputBuffer raw image bytes from multer
 * @returns {Promise<{ buffer: Buffer, mimeType: string, metrics: Object }>}
 */
export const preprocessSearchImage = async (inputBuffer) => {
  const metrics = { applied: [] };

  let blurScore;
  try {
    blurScore = await computeBlurScore(inputBuffer);
  } catch (err) {
    // If detection blows up on an exotic format, skip preprocessing rather than fail the search.
    return {
      buffer: inputBuffer,
      mimeType: 'image/jpeg',
      metrics: { blurScore: null, isBlurry: false, applied: ['skipped-preprocess'], error: err.message },
    };
  }
  metrics.blurScore = parseFloat(blurScore.toFixed(2));
  metrics.isBlurry = blurScore < BLUR_THRESHOLD;

  let pipeline = sharp(inputBuffer).rotate(); // honour EXIF orientation, then strip

  const meta = await sharp(inputBuffer).metadata();
  const longest = Math.max(meta.width || 0, meta.height || 0);

  if (longest && longest < MIN_LONGEST_EDGE) {
    pipeline = pipeline.resize({ width: MIN_LONGEST_EDGE, kernel: 'lanczos3' });
    metrics.applied.push('upscale');
  } else if (longest > MAX_LONGEST_EDGE) {
    pipeline = pipeline.resize({ width: MAX_LONGEST_EDGE, withoutEnlargement: true });
    metrics.applied.push('downscale');
  }

  // Always-on: normalise contrast, remove metadata
  pipeline = pipeline.normalise();
  metrics.applied.push('normalise');

  if (metrics.isBlurry) {
    // Unsharp mask for sharpening + median filter to reduce noise introduced by sharpening.
    // sharp.sharpen(sigma, flat, jagged) — moderate values work for compression blur.
    pipeline = pipeline.sharpen({ sigma: 1.2, m1: 1.0, m2: 2.0 }).median(3);
    metrics.applied.push('sharpen', 'denoise');
  }

  const output = await pipeline.jpeg({ quality: 92 }).toBuffer();

  return { buffer: output, mimeType: 'image/jpeg', metrics };
};

// ─── Bounding-box cropping ──────────────────────────────────────────────────

const MIN_CROP_EDGE = 96;   // Below this, CLIP image embeddings degrade badly
const CROP_PAD_RATIO = 0.05; // 5% outward pad around each crop for safety margin

/**
 * Crops an image by a Gemini-style bbox `[ymin, xmin, ymax, xmax]` on a
 * 0..1000 normalised scale. If the resulting crop is smaller than
 * MIN_CROP_EDGE on its shorter side, pads to a square and lanczos-upscales
 * so CLIP has enough pixels to work with.
 *
 * @param {Buffer} buffer source image bytes
 * @param {number[]|null} bbox [ymin, xmin, ymax, xmax] on 0..1000, or null/undefined
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, upscaled: boolean }>}
 */
export const cropByBbox = async (buffer, bbox) => {
  const meta = await sharp(buffer).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (!imgW || !imgH) throw new Error('Image has no readable dimensions');

  // If no bbox given, use the whole image as the crop (single-element fallback)
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    const out = await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
    return { buffer: out, width: imgW, height: imgH, upscaled: false };
  }

  let [ymin, xmin, ymax, xmax] = bbox;
  // Convert 0..1000 → pixel coords
  let left = Math.round((xmin / 1000) * imgW);
  let top = Math.round((ymin / 1000) * imgH);
  let right = Math.round((xmax / 1000) * imgW);
  let bottom = Math.round((ymax / 1000) * imgH);

  // Pad outward by CROP_PAD_RATIO of the longer edge, clamped to image bounds
  const padX = Math.round((right - left) * CROP_PAD_RATIO);
  const padY = Math.round((bottom - top) * CROP_PAD_RATIO);
  left = Math.max(0, left - padX);
  top = Math.max(0, top - padY);
  right = Math.min(imgW, right + padX);
  bottom = Math.min(imgH, bottom + padY);

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  let pipeline = sharp(buffer).rotate().extract({ left, top, width, height });

  // If crop is tiny, upscale to CLIP-friendly size. `fit: contain` pads the
  // shorter edge; we use a neutral grey pad that CLIP sees as background.
  const shortest = Math.min(width, height);
  let upscaled = false;
  if (shortest < MIN_CROP_EDGE) {
    const target = 224; // CLIP native input size
    pipeline = pipeline.resize(target, target, {
      fit: 'contain',
      background: { r: 128, g: 128, b: 128 },
      kernel: 'lanczos3',
    });
    upscaled = true;
  }

  const out = await pipeline.jpeg({ quality: 92 }).toBuffer();
  return { buffer: out, width, height, upscaled };
};

