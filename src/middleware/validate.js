/**
 * express-validator integration: runs validation chains and converts any
 * violations into a single 422 ApiError with per-field details.
 */
'use strict';

const { validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

function validate(chains) {
  return [
    ...chains,
    (req, res, next) => {
      const errors = validationResult(req);
      if (errors.isEmpty()) return next();
      const details = errors.array().map((e) => ({ field: e.path, message: e.msg }));
      next(ApiError.unprocessable('Validation failed', details));
    },
  ];
}

module.exports = validate;
