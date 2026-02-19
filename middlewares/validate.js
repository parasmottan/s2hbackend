const AppError = require('../utils/AppError');

/**
 * Generic Joi validation middleware factory.
 *
 * Usage in route:
 *   const validate = require('../middlewares/validate');
 *   const { searchSchema } = require('../validators/requestValidators');
 *   router.post('/search', validate(searchSchema), ctrl.searchHelp);
 *
 * @param {import('joi').ObjectSchema} schema  Joi schema to validate req.body against
 */
const validate = (schema) => {
  return (req, _res, next) => {
    const { error } = schema.validate(req.body, {
      abortEarly: false, // collect all errors
      stripUnknown: true, // remove unknown fields
    });

    if (error) {
      const message = error.details.map((d) => d.message).join(', ');
      return next(new AppError(message, 400));
    }

    next();
  };
};

module.exports = validate;
