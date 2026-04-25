# DigiHaat API Documentation

This document provides details for the APIs available in the DigiHaat backend.

---

## Catalogue Management

### 1. Ingest Catalogue
Upload a CSV file to ingest products into the background processing queue.

- **Method:** `POST`
- **Path:** `/catalogue/ingest`
- **Content-Type:** `multipart/form-data`
- **Request Body:**
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `file` | File | A CSV file containing product data. |

**CSV Requirement (multi-image supported):**
Each row must supply at least one image URL via **any one** of these shapes:

| Shape | Example header | Example value | Notes |
| :--- | :--- | :--- | :--- |
| **Pipe-separated bulk** (preferred) | `image_urls` (or `images`) | `https://a.jpg\|https://b.jpg\|https://c.jpg` | Pipe `\|` is used because URLs may legitimately contain commas. |
| **Numbered columns** | `image_url_1`, `image_url_2`, … | one URL per cell | Order is preserved by numeric suffix. |
| **Single legacy column** | `image_url` | `https://a.jpg` | Backwards-compatible; can also hold a pipe-separated list. |

The first URL in the resulting list is treated as the **primary image** (used in cards, search result thumbnails, and as the `imageUrl` field).

- **Optional Columns:** `title`, `brand`, `colour` (or `color`), `category`, `tags` (comma-separated), `sku` (or `id`)

**AI processing of multiple images:**
By default, only the **primary image** is sent to Gemini Vision (preserves original cost/latency). Set the env var `ANALYZE_ALL_IMAGES=true` on the worker to fan out across every image — the per-image AI extractions are merged (union for tags/colours/objects, first-non-null for brand/category, max for confidence).

CLIP embeddings are computed for **all** images regardless of the AI mode (CLIP is local and cheap). The per-image vectors are stored in MongoDB (`imageEmbeddings`) for audit, while a single mean-pooled, L2-normalised vector is sent to Elasticsearch as `imageEmbedding` — so search query logic is unchanged.

- **Response:** `202 Accepted`
  ```json
  {
    "message": "Catalogue ingestion started. Jobs are processing in the background.",
    "total": 100,
    "queued": 98,
    "skipped": 2,
    "skippedRows": [{ "rowIndex": 7, "reason": "no valid image URL(s)" }],
    "qualityThreshold": 0.75,
    "pendingEndpoint": "GET /catalogue/pending",
    "note": "Items with quality score below the threshold will appear in /catalogue/pending. Each row may have one or many images (pipe-separated, numbered columns, or single image_url)."
  }
  ```

---

### 2. Get Pending Items
Retrieve items that failed the automated quality gate and require manual review.

- **Method:** `GET`
- **Path:** `/catalogue/pending`
- **Query Parameters:**
  | Parameter | Type | Default | Description |
  | :--- | :--- | :--- | :--- |
  | `status` | string | `pending` | Filter by status (`pending`, `approved`, `rejected`). |
  | `page` | number | `1` | Page number for pagination. |
  | `limit` | number | `20` | Items per page (max 100). |
  | `minScore` | number | - | Filter items with quality score >= this value. |
  | `maxScore` | number | - | Filter items with quality score <= this value. |

- **Response:** `200 OK`
  ```json
  {
    "total": 50,
    "page": 1,
    "limit": 20,
    "pages": 3,
    "items": [
      {
        "_id": "60d...",
        "imageUrl": "https://a.jpg",
        "imageUrls": ["https://a.jpg", "https://b.jpg", "https://c.jpg"],
        "qualityScore": 0.65,
        "status": "pending",
        "aiExtracted": { "brand": "Nike", "category": "footwear", "...": "..." },
        "aiExtractedPerImage": [
          { "imageUrl": "https://a.jpg", "brand": "Nike", "confidence": 0.92 }
        ],
        "providedBrand": "Nike",
        "...": "..."
      }
    ]
  }
  ```
  Note: the bulky per-image CLIP vectors stored in MongoDB are stripped from this response.

---

### 3. Update Pending Item
Manually edit the attributes of a pending item before approval.

- **Method:** `PATCH`
- **Path:** `/catalogue/pending/:id`
- **Content-Type:** `application/json`
- **Request Body:**
  ```json
  {
    "title": "New Title",
    "providedBrand": "Nike",
    "imageUrls": ["https://a.jpg", "https://b.jpg"],
    "aiExtracted": {
      "category": "Shoes"
    }
  }
  ```
  Notes:
  - Replacing `imageUrls` resets the cached CLIP vectors so the approve flow re-embeds against the new image list.
  - The first URL becomes the primary image (`imageUrl`).
- **Response:** `200 OK`
  ```json
  {
    "message": "Updated",
    "item": { ... }
  }
  ```

---

### 4. Approve Pending Item
Approve a pending item to generate embeddings and index it in Elasticsearch for search.

- **Method:** `POST`
- **Path:** `/catalogue/pending/:id/approve`
- **Request Body (Optional):**
  ```json
  {
    "reviewedBy": "admin_user"
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "message": "Approved and indexed",
    "productId": "uuid-...",
    "pendingId": "mongo-id-...",
    "imageCount": 3,
    "product": {
      "id": "uuid-...",
      "imageUrl": "https://a.jpg",
      "imageUrls": ["https://a.jpg", "https://b.jpg", "https://c.jpg"],
      "...": "..."
    }
  }
  ```
  The CLIP vectors for each image are mean-pooled into the single `imageEmbedding` stored in Elasticsearch — search query logic is unchanged from the single-image case.

---

### 5. Reject Pending Item
Reject a pending item. It will not be indexed.

- **Method:** `POST`
- **Path:** `/catalogue/pending/:id/reject`
- **Content-Type:** `application/json`
- **Request Body:**
  ```json
  {
    "reason": "Image quality too low",
    "reviewedBy": "admin_user"
  }
  ```
- **Response:** `200 OK`
  ```json
  {
    "message": "Rejected",
    "pendingId": "mongo-id-..."
  }
  ```

---

## Search

### 1. Unified Search
Perform multi-modal search using text query, product image, or both.

- **Method:** `POST`
- **Path:** `/search`
- **Content-Type:** `multipart/form-data`
- **Request Body:**
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `query` | string | Optional text search string (supports multi-language). |
  | `image` | binary | Optional product image file. |
  | `element` | number | Optional index of the product in the image to search for (default: 0). |

- **Response:** `200 OK`
  ```json
  {
    "searchSource": "image",
    "multiElement": true,
    "elements": [
      {
        "index": 0,
        "name": "sneakers",
        "searchText": "red running sneakers",
        "bbox": [10, 10, 100, 100]
      }
    ],
    "selectedElement": { "index": 0, "name": "sneakers" },
    "results": [
      {
        "id": "...",
        "title": "Red Nike Zoom",
        "score": 0.95,
        "imageUrl": "..."
      }
    ]
  }
  ```

---

## Miscellaneous

### 1. Health Check
Check the status of the server and its dependencies (Elasticsearch).

- **Method:** `GET`
- **Path:** `/health`
- **Response:** `200 OK`
  ```json
  {
    "status": "ok",
    "services": {
      "elasticsearch": "connected"
    },
    "timestamp": "2026-04-25T02:00:00Z"
  }
  ```
