const router = require('express').Router();
const { getProfile, switchRole } = require('../controllers/userController');
const { protect } = require('../middlewares/auth');

router.use(protect);

// Get own profile
router.get('/me', getProfile);

// Toggle role (seeker ↔ helper)
router.patch('/role', switchRole);

module.exports = router;
