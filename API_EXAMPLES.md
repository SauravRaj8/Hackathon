# DigiHaat API Examples & Usage Guide

This guide provides practical examples for interacting with the DigiHaat APIs using `curl`.

---

## 🚀 Catalogue Ingestion

### Ingest CSV
Upload a CSV to start the background ingestion process.

**Command:**
```bash
curl -X POST \
  -F "file=@path/to/your/catalogue.csv" \
  http://localhost:3000/catalogue/ingest
```

**Sample CSV Content (`catalogue.csv`):**
```csv
title,image_url,brand,colour,category,tags,sku
Red Running Shoes,https://example.com/shoes.jpg,Nike,Red,Footwear,"running,sports",NK-RS-01
Blue Denim Jacket,https://example.com/jacket.jpg,Levi's,Blue,Apparel,"denim,casual",LV-DJ-02
```

---

## 🔍 Search

### Text Search
Search for products using a natural language query (supports auto-translation).

**Command:**
```bash
curl -X POST \
  -F "query=red sneakers for running" \
  http://localhost:3000/search
```

### Image Search
Upload an image to find similar products.

**Command:**
```bash
curl -X POST \
  -F "image=@path/to/product_photo.jpg" \
  http://localhost:3000/search
```

### Multi-Modal Search (Image + Text)
Refine an image search with specific text criteria.

**Command:**
```bash
curl -X POST \
  -F "image=@path/to/photo.jpg" \
  -F "query=only nike brand" \
  http://localhost:3000/search
```

---

## 🛠️ Manual Review (Curation)

### List Pending Items
Get items that are below the quality threshold (~0.75).

**Command:**
```bash
curl "http://localhost:3000/catalogue/pending?status=pending&limit=5"
```

### Update a Pending Item
Fix attributes before approval.

**Command:**
```bash
curl -X PATCH \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Corrected Product Title",
    "providedBrand": "Adidas"
  }' \
  http://localhost:3000/catalogue/pending/671a...id.../
```

### Approve an Item
Index the item into Elasticsearch.

**Command:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"reviewedBy": "saurav_admin"}' \
  http://localhost:3000/catalogue/pending/671a...id.../approve
```

### Reject an Item
Discard the item with a reason.

**Command:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Image is blurry",
    "reviewedBy": "saurav_admin"
  }' \
  http://localhost:3000/catalogue/pending/671a...id.../reject
```

---

## 🏥 Utility

### Health Check
Verify server and Elasticsearch status.

**Command:**
```bash
curl http://localhost:3000/health
```

**Sample Response:**
```json
{
  "status": "ok",
  "services": {
    "elasticsearch": "connected"
  },
  "timestamp": "2026-04-25T02:06:00.000Z"
}
```
