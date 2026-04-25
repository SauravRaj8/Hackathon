import { parse } from 'csv-parse';
import { v4 as uuidv4 } from 'uuid';
import { ingestQueue } from '../config/queue.js';
import { PendingCatalogue } from '../models/PendingCatalogue.js';
import { generateProductEmbedding } from '../services/embeddingService.js';
import { indexDocument } from '../services/elasticsearchService.js';
import { embedImagesMeanPooled, downloadImageBuffer } from '../services/clipService.js';
import { normalizeDomain } from '../config/domains.js';

// ─── CSV → image URL list ───────────────────────────────────────────────────

const URL_LIST_SEPARATOR = /\s*[|]\s*/;          // pipe-separated (preferred — pipes don't appear in URLs)
const NUMBERED_COL_RE = /^image_url[_\-]?(\d+)$/i; // image_url_1, image_url-2, image_url3, ...

/**
 * Extracts the ordered, deduped, validated list of image URLs from a CSV row.
 * Supported shapes (in priority order; the first one that yields >=1 URL wins):
 *
 *   1. `image_urls` (or `images`) — pipe-separated:  "url1|url2|url3"
 *   2. `image_url_1`, `image_url_2`, ..., `image_url_N` — numbered columns
 *   3. `image_url` — single legacy column
 *
 * Returns: string[] in original order, deduplicated, only http(s) URLs kept.
 */
export const parseImageUrls = (row) => {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const url = String(raw).trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };

  // 1. Pipe-separated bulk column
  const bulk = row.image_urls ?? row.images ?? null;
  if (bulk) {
    String(bulk).split(URL_LIST_SEPARATOR).forEach(push);
    if (out.length > 0) return out;
  }

  // 2. Numbered columns — sort by their numeric suffix so order is deterministic
  const numbered = Object.keys(row)
    .map((k) => {
      const m = k.match(NUMBERED_COL_RE);
      return m ? { key: k, idx: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx);

  if (numbered.length > 0) {
    numbered.forEach(({ key }) => push(row[key]));
    if (out.length > 0) return out;
  }

  // 3. Legacy single column — also accept pipe-separated values here for
  //    convenience (some users will wedge multi-image into the singular column)
  if (row.image_url) {
    String(row.image_url).split(URL_LIST_SEPARATOR).forEach(push);
  }

  return out;
};

// ─── POST /catalogue/ingest ─────────────────────────────────────────────────

/**
 * Accepts a CSV file upload, parses it, and dispatches each row as a BullMQ job.
 *
 * Required: at least one image URL per row, supplied via any of:
 *   - `image_urls` (or `images`) column with pipe-separated URLs
 *   - `image_url_1`, `image_url_2`, ... numbered columns
 *   - `image_url` (single, legacy)
 *
 * Optional columns: title, brand, colour/color, category, tags (comma-separated), sku/id
 */
export const ingestCatalogue = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'No file uploaded. Send a CSV as multipart/form-data with field name "file".',
    });
  }

  // Parse CSV from buffer
  let records;
  try {
    records = await new Promise((resolve, reject) => {
      parse(
        req.file.buffer,
        { columns: true, skip_empty_lines: true, trim: true },
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
  } catch (err) {
    return res.status(400).json({ error: `CSV parse error: ${err.message}` });
  }

  if (!records || records.length === 0) {
    return res.status(400).json({ error: 'CSV file is empty or has no data rows.' });
  }

  // Validate that the first row supplies at least one image URL via any
  // accepted shape. We probe the parser rather than asserting on a specific
  // column name, since multiple shapes are valid.
  if (parseImageUrls(records[0]).length === 0) {
    return res.status(400).json({
      error: 'CSV must contain at least one image URL per row.',
      receivedColumns: Object.keys(records[0]),
      acceptedShapes: [
        'image_urls (or images) — pipe-separated, e.g. "https://a.jpg|https://b.jpg"',
        'image_url_1, image_url_2, ... numbered columns',
        'image_url — single URL (legacy)',
      ],
      example: 'title,image_urls,brand,colour,category,tags,sku',
    });
  }

  // Track rows we had to skip because they were missing an image entirely.
  const skipped = [];

  // Build jobs — stagger by 600ms each to respect Gemini rate limits
  const jobs = (await Promise.all(records.map(async (row, index) => {
    const imageUrls = parseImageUrls(row);
    if (imageUrls.length === 0) {
      skipped.push({ rowIndex: index, reason: 'no valid image URL(s)' });
      return null;
    }

    // Resolve and validate domain from CSV. null = missing/invalid → forced pending.
    const providedDomain = row.domain || row.Domain || null;
    const domain = normalizeDomain(providedDomain);

    // Create draft entry in MongoDB
    const draftDoc = await PendingCatalogue.create({
      rowIndex: index,
      title: row.title || null,
      imageUrls,
      imageUrl: imageUrls[0], // pre-validate hook also enforces this — set explicitly for clarity
      sku: row.sku || row.id || null,
      providedDomain: providedDomain || null,
      domain: domain || null,
      providedBrand: row.brand || null,
      providedColour: row.colour || row.color || null,
      providedCategory: row.category || null,
      providedTags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      status: 'draft',
      // Flag missing/invalid domain upfront so the worker can route to pending immediately.
      pendingReason: !domain ? `Domain missing or invalid (got: "${providedDomain || ''}")` : null,
    });

    return {
      name: `row-${index}`,
      data: {
        rowIndex: index,
        mongoId: draftDoc._id.toString(),
        title: row.title || null,
        imageUrls,
        imageUrl: imageUrls[0], // legacy field kept in the job payload
        domain: domain || null,     // null triggers forced-pending in the worker
        brand: row.brand || null,
        colour: row.colour || row.color || null,
        category: row.category || null,
        tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        sku: row.sku || row.id || null,
      },
      opts: {
        delay: index * 600, // stagger to avoid Gemini rate limits
        jobId: `ingest-${Date.now()}-${index}`,
      },
    };
  }))).filter(Boolean);

  await ingestQueue.addBulk(jobs);

  return res.status(202).json({
    message: 'Catalogue ingestion started. Jobs are processing in the background.',
    total: records.length,
    queued: jobs.length,
    skipped: skipped.length,
    skippedRows: skipped,
    qualityThreshold: parseFloat(process.env.QUALITY_THRESHOLD || '0.75'),
    pendingEndpoint: 'GET /catalogue/pending',
    note: 'Items with quality score below the threshold will appear in /catalogue/pending. Each row may have one or many images (pipe-separated, numbered columns, or single image_url).',
  });
};

// ─── GET /catalogue/pending ─────────────────────────────────────────────────

/**
 * Returns paginated list of catalogue items that failed quality scoring.
 *
 * Query params:
 *   status   — "pending" | "approved" | "rejected" (default: "pending")
 *   page     — page number (default: 1)
 *   limit    — items per page (default: 20, max: 100)
 *   minScore — filter items above a score (optional)
 *   maxScore — filter items below a score (optional)
 */
export const getPendingItems = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status = 'pending',
    minScore,
    maxScore,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

  const filter = { status };
  if (minScore !== undefined || maxScore !== undefined) {
    filter.qualityScore = {};
    if (minScore !== undefined) filter.qualityScore.$gte = parseFloat(minScore);
    if (maxScore !== undefined) filter.qualityScore.$lte = parseFloat(maxScore);
  }

  const [items, total] = await Promise.all([
    PendingCatalogue.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      // The CLIP per-image vectors are large (~5x 512 floats per row) and
      // useless to a dashboard reviewer — strip them out of the list view.
      .select('-imageEmbeddings')
      .lean(),
    PendingCatalogue.countDocuments(filter),
  ]);

  return res.json({
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum),
    items,
  });
};

// ─── GET /catalogue/drafts ──────────────────────────────────────────────────

/**
 * Returns paginated list of catalogue items in "draft" state (just ingested).
 */
export const getDraftItems = (req, res) => {
  req.query.status = 'draft';
  return getPendingItems(req, res);
};

// ─── PATCH /catalogue/pending/:id ───────────────────────────────────────────

/**
 * Edit the AI-extracted attributes or CSV-provided metadata on a pending item
 * before approving. Allowed top-level fields:
 *   title, providedBrand, providedColour, providedCategory, providedTags,
 *   imageUrls (array of URLs — replaces the whole list; primary = imageUrls[0])
 *   aiExtracted.{brand, colour, colours, category, subcategory, tags, objects}
 */
export const updatePending = async (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};

  const doc = await PendingCatalogue.findById(id);
  if (!doc) {
    return res.status(404).json({ error: `Pending item ${id} not found` });
  }
  if (doc.status !== 'pending') {
    return res.status(409).json({
      error: `Cannot edit item in status "${doc.status}". Only pending items are editable.`,
    });
  }

  // Shallow updates on provided/top-level fields
  const topLevel = ['title', 'providedBrand', 'providedColour', 'providedCategory', 'providedTags'];
  for (const key of topLevel) {
    if (key in patch) doc[key] = patch[key];
  }

  // Allow reviewer to assign or correct the domain.
  if ('domain' in patch) {
    const resolvedDomain = normalizeDomain(patch.domain);
    if (!resolvedDomain) {
      return res.status(400).json({
        error: `Invalid domain "${patch.domain}". Allowed values: fashion, beauty, electronics, food, grocery`,
      });
    }
    doc.domain = resolvedDomain;
    // Clear the pending reason if domain was the only blocker.
    if (doc.pendingReason && doc.pendingReason.startsWith('Domain missing')) {
      doc.pendingReason = null;
    }
  }

  // Allow the reviewer to add/remove/reorder images. Primary auto-syncs via
  // the schema's pre-validate hook.
  if (Array.isArray(patch.imageUrls)) {
    const cleaned = patch.imageUrls.map((u) => String(u).trim()).filter(Boolean);
    if (cleaned.length === 0) {
      return res.status(400).json({ error: 'imageUrls must contain at least one URL' });
    }
    doc.imageUrls = cleaned;
    // Existing CLIP vectors are stale once the image list changes — drop them
    // so the approve flow re-embeds against the new set.
    doc.imageEmbeddings = [];
  }

  // Merge updates into aiExtracted sub-document
  if (patch.aiExtracted && typeof patch.aiExtracted === 'object') {
    doc.aiExtracted = { ...doc.aiExtracted.toObject?.() ?? doc.aiExtracted, ...patch.aiExtracted };
  }

  await doc.save();
  return res.json({ message: 'Updated', item: doc.toObject() });
};

// ─── POST /catalogue/pending/:id/approve ───────────────────────────────────

/**
 * Approves a pending item:
 *   1. Build the final product by merging AI-extracted + CSV-provided fields
 *      (AI wins on conflicts, but CSV values fill gaps)
 *   2. Generate text embedding for the product attributes
 *   3. CLIP-embed every image and mean-pool into a single vector
 *      (re-uses any vectors already computed by the worker)
 *   4. Index in Elasticsearch with imageUrls[]
 *   5. Mark the MongoDB pending doc as approved with review metadata
 *
 * Optional body: { reviewedBy: "<user>" }
 */
export const approvePending = async (req, res) => {
  const { id } = req.params;
  const reviewedBy = (req.body && req.body.reviewedBy) || req.query.reviewedBy || 'dashboard';

  const doc = await PendingCatalogue.findById(id);
  if (!doc) {
    return res.status(404).json({ error: `Pending item ${id} not found` });
  }
  if (doc.status === 'approved') {
    return res.status(409).json({ error: 'Item is already approved' });
  }
  if (doc.status === 'rejected') {
    return res.status(409).json({ error: 'Cannot approve a rejected item' });
  }

  const ai = doc.aiExtracted || {};
  const imageUrls = (doc.imageUrls && doc.imageUrls.length > 0)
    ? doc.imageUrls
    : (doc.imageUrl ? [doc.imageUrl] : []);

  if (imageUrls.length === 0) {
    return res.status(409).json({ error: 'Cannot approve an item with no image URLs' });
  }

  const product = {
    id: uuidv4(),
    sku: doc.sku || null,
    title: doc.title || null,
    imageUrl: imageUrls[0],
    imageUrls,
    domain: doc.domain || null,
    brand: ai.brand || doc.providedBrand || null,
    colour: ai.colour || doc.providedColour || null,
    colours: ai.colours || [],
    category: ai.category || doc.providedCategory || null,
    subcategory: ai.subcategory || null,
    tags: [...new Set([...(ai.tags || []), ...(doc.providedTags || [])])],
    // primaryObjects: what this listing is actually selling (drives embedding + search).
    // Falls back to objects[] if Gemini didn't return the split (old prompt / error).
    primaryObjects: ai.primaryObjects && ai.primaryObjects.length > 0
      ? ai.primaryObjects
      : (ai.objects || []),
    // objects: incidental/prop items in the image — stored for audit, not searched.
    objects: ai.objects || [],
    // attributes: domain-specific fields (gender, fabric, model, ram, skin_type, etc.)
    attributes: ai.attributes || {},
    qualityScore: doc.qualityScore,
  };

  try {
    const embedding = await generateProductEmbedding(product);

    // CLIP image embedding(s) — non-fatal on failure (we still index with text).
    // If the worker already populated `doc.imageEmbeddings`, we re-use those
    // and avoid re-downloading; otherwise we download + embed all images now.
    let imageEmbedding = null;
    try {
      let perImage = doc.imageEmbeddings && doc.imageEmbeddings.length === imageUrls.length
        ? doc.imageEmbeddings
        : null;

      if (!perImage) {
        const buffers = await Promise.all(imageUrls.map((url) => downloadImageBuffer(url)));
        const result = await embedImagesMeanPooled(buffers);
        perImage = result.perImage;
        imageEmbedding = result.mean;
      } else {
        // Already have per-image vectors — just re-pool (cheap, in-memory)
        const { mean } = await embedImagesMeanPooled([], { precomputed: perImage });
        imageEmbedding = mean;
      }
    } catch (clipErr) {
      console.warn(`[approve] CLIP embedding failed for ${doc._id}: ${clipErr.message}`);
    }

    await indexDocument(product, embedding, imageEmbedding);
  } catch (err) {
    return res.status(500).json({ error: `Indexing failed: ${err.message}` });
  }

  doc.status = 'approved';
  doc.reviewedBy = reviewedBy;
  doc.reviewedAt = new Date();
  await doc.save();

  return res.json({
    message: 'Approved and indexed',
    productId: product.id,
    pendingId: doc._id.toString(),
    imageCount: imageUrls.length,
    product,
  });
};

// ─── POST /catalogue/pending/:id/reject ────────────────────────────────────

/**
 * Rejects a pending item. Nothing is indexed. The Mongo doc is kept for audit.
 * Body: { reason?: "<why>", reviewedBy?: "<user>" }
 */
export const rejectPending = async (req, res) => {
  const { id } = req.params;
  const { reason, reviewedBy } = req.body || {};

  const doc = await PendingCatalogue.findById(id);
  if (!doc) {
    return res.status(404).json({ error: `Pending item ${id} not found` });
  }
  if (doc.status === 'rejected') {
    return res.status(409).json({ error: 'Item is already rejected' });
  }
  if (doc.status === 'approved') {
    return res.status(409).json({ error: 'Cannot reject an approved item' });
  }

  doc.status = 'rejected';
  doc.rejectionReason = reason || 'No reason provided';
  doc.reviewedBy = reviewedBy || 'dashboard';
  doc.reviewedAt = new Date();
  await doc.save();

  return res.json({ message: 'Rejected', pendingId: doc._id.toString() });
};
