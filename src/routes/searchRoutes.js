import { Router } from 'express';
import { default as multer, memoryStorage } from 'multer';
import { search } from '../controllers/searchController.js';

const router = Router();

// Accept images up to 20MB
const imageUpload = multer({
  storage: memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

/**
 * POST /search
 * Body: multipart/form-data
 *   query  — text query (any language)
 *   image  — product image file
 * At least one of query or image is required
 */
router.post('/', imageUpload.single('image'), search);

export default router;
