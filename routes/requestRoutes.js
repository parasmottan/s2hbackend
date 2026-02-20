const router = require('express').Router();
const {
  searchHelp,
  getRequestById,
  cancelRequest,
  getMyRequests,
} = require('../controllers/requestController');
const { protect, authorize } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { searchSchema } = require('../validators/schemas');
const { searchLimiter } = require('../middlewares/rateLimiter');

// All request routes are protected
router.use(protect);

// Get my request history (seeker or helper)
router.get('/my', getMyRequests);

// Seeker-only: create a search request (rate-limited)
router.post(
  '/search',
  authorize('seeker'),
  searchLimiter,
  validate(searchSchema),
  searchHelp
);

// Fetch request by ID (seeker or helper)
router.get('/:id', getRequestById);

// Seeker-only: cancel a request
router.patch('/:id/cancel', authorize('seeker'), cancelRequest);

module.exports = router;
