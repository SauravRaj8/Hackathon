import mongoose from 'mongoose';
import { ALLOWED_DOMAINS } from '../config/domains.js';

// ─── Per-image AI extraction sub-schema ───────────────────────────────────
// One entry per source image. The aggregated `aiExtracted` field below is
// derived by merging across all entries in this array.
const aiExtractedPerImageSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, required: true },
    // primaryObjects: what the product IS (used for search + embedding)
    primaryObjects: [{ type: String }],
    // objects: incidental items also visible — stored for audit, not searched
    objects: [{ type: String }],
    brand: { type: String },
    colour: { type: String },
    colours: [{ type: String }],
    category: { type: String },
    subcategory: { type: String },
    tags: [{ type: String }],
    // attributes: domain-specific key/value pairs (gender, fabric, model, ram, etc.)
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidence: { type: Number },
    error: { type: String }, // populated if the per-image AI call failed
  },
  { _id: false }
);

const pendingCatalogueSchema = new mongoose.Schema(
  {
    rowIndex: { type: Number },

    // ─── Original CSV metadata ───────────────────────────────────────────
    title: { type: String },

    // Multi-image support. `imageUrls` is the source of truth; `imageUrl`
    // is a denormalised convenience pointer to imageUrls[0] (primary image)
    // kept for backwards compatibility with the dashboard, search results,
    // and any external consumers.
    imageUrls: {
      type: [String],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0,
        message: 'imageUrls must contain at least one URL',
      },
    },
    imageUrl: { type: String, required: true }, // = imageUrls[0]

    sku: { type: String },
    // domain: declared by seller in CSV column "domain". Validated against ALLOWED_DOMAINS.
    // `providedDomain` is the raw CSV value; `domain` is the resolved/validated value.
    // A reviewer can correct `domain` on a pending item before approval.
    providedDomain: { type: String },
    domain: {
      type: String,
      enum: [...ALLOWED_DOMAINS, null],
      default: null,
    },
    providedBrand: { type: String },
    providedColour: { type: String },
    providedCategory: { type: String },
    providedTags: [{ type: String }],

    // ─── AI-extracted attributes ─────────────────────────────────────────
    // Aggregated/merged across all images — used by the scoring service
    // and as the source for the final approved product.
    aiExtracted: {
      // primaryObjects: what the product IS (intersection-merged across images)
      primaryObjects: [{ type: String }],
      // objects: incidental items visible in image(s) — audit only
      objects: [{ type: String }],
      brand: { type: String },
      colour: { type: String },
      colours: [{ type: String }],
      category: { type: String },
      subcategory: { type: String },
      tags: [{ type: String }],
      // attributes: domain-specific fields (gender, fabric, model, ram, skin_type, etc.)
      attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
      confidence: { type: Number },
    },

    // Per-image breakdown for audit / re-processing. May be empty when only
    // the primary image was analysed (default behaviour).
    aiExtractedPerImage: { type: [aiExtractedPerImageSchema], default: [] },

    // ─── Scoring breakdown ───────────────────────────────────────────────
    qualityScore: { type: Number, required: false },
    fieldScores: { type: mongoose.Schema.Types.Mixed }, // { category: 0.9, brand: 0.1, ... }
    failedFields: [{ type: String }],

    // ─── CLIP image embeddings (per image) ───────────────────────────────
    // Stored here for audit and potential future re-indexing strategies
    // (e.g. switching to per-image max-similarity once ES is upgraded).
    // Elasticsearch only receives the mean-pooled aggregate.
    imageEmbeddings: { type: [[Number]], default: [] }, // [[512 floats], ...]

    // ─── Status lifecycle ────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'rejected'],
      default: 'draft',
    },
    // pendingReason: human-readable explanation of why the item was routed to pending.
    // e.g. "quality score below threshold", "domain missing", "image set inconsistent"
    pendingReason: { type: String },
    rejectionReason: { type: String },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

// Keep `imageUrl` in sync with `imageUrls[0]` defensively so application
// code reading either path always sees a consistent primary image.
pendingCatalogueSchema.pre('validate', function syncPrimaryImage() {
  if (Array.isArray(this.imageUrls) && this.imageUrls.length > 0) {
    this.imageUrl = this.imageUrls[0];
  } else if (this.imageUrl && (!this.imageUrls || this.imageUrls.length === 0)) {
    // Legacy path: caller only set `imageUrl` (single). Promote to imageUrls.
    this.imageUrls = [this.imageUrl];
  }
});

pendingCatalogueSchema.index({ status: 1, createdAt: -1 });
pendingCatalogueSchema.index({ qualityScore: 1 });

export const PendingCatalogue = mongoose.model('PendingCatalogue', pendingCatalogueSchema);
