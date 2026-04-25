import { Router } from 'express';
import { default as multer, memoryStorage } from 'multer';
import {
  ingestCatalogue,
  getPendingItems,
  getDraftItems,
  approvePending,
  rejectPending,
  updatePending,
} from '../controllers/catalogueController.js';

const router = Router();

// Memory storage — CSV files are small enough to hold in RAM
const csvUpload = multer({
  storage: memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

/**
 * POST /catalogue/ingest
 * Body: multipart/form-data, field "file" = CSV file
 * Dispatches one BullMQ job per CSV row
 */
router.post('/ingest', csvUpload.single('file'), ingestCatalogue);

/**
 * GET /catalogue/pending
 * Query: status, page, limit, minScore, maxScore
 * Returns items that failed quality scoring
 */
router.get('/pending', getPendingItems);

/**
 * GET /catalogue/drafts
 * Returns items that are newly ingested and waiting for AI processing
 */
router.get('/drafts', getDraftItems);

/**
 * PATCH /catalogue/pending/:id
 * Edit a pending item (title, provided* fields, aiExtracted sub-fields)
 */
router.patch('/pending/:id', updatePending);

/**
 * POST /catalogue/pending/:id/approve
 * Generates embedding + indexes in Elasticsearch, marks pending doc approved
 */
router.post('/pending/:id/approve', approvePending);

/**
 * POST /catalogue/pending/:id/reject
 * Body: { reason?: string, reviewedBy?: string }
 */
router.post('/pending/:id/reject', rejectPending);

export default router;
