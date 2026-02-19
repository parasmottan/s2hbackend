const Joi = require('joi');

/**
 * Joi schemas for request-related endpoints.
 */

const searchSchema = Joi.object({
  category: Joi.string().trim().required().messages({
    'any.required': 'Help category is required',
  }),
  budget: Joi.number().positive().required().messages({
    'any.required': 'Budget is required',
    'number.positive': 'Budget must be a positive number',
  }),
  estimatedArrivalTime: Joi.number().integer().min(1).required().messages({
    'any.required': 'Estimated arrival time is required',
    'number.min': 'Arrival time must be at least 1 minute',
  }),
  longitude: Joi.number().min(-180).max(180).required().messages({
    'any.required': 'Longitude is required',
  }),
  latitude: Joi.number().min(-90).max(90).required().messages({
    'any.required': 'Latitude is required',
  }),
});

const registerSchema = Joi.object({
  name: Joi.string().trim().max(60).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid('seeker', 'helper').required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const locationSchema = Joi.object({
  longitude: Joi.number().min(-180).max(180).required(),
  latitude: Joi.number().min(-90).max(90).required(),
});

module.exports = {
  searchSchema,
  registerSchema,
  loginSchema,
  locationSchema,
};
