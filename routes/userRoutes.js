const router = require('express').Router();
const { updateLocation, getProfile } = require('../controllers/userController');
const { protect } = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const { locationSchema } = require('../validators/schemas');

// All user routes are protected
router.use(protect);

router.get('/profile', getProfile);
router.patch('/location', validate(locationSchema), updateLocation);

module.exports = router;
