'use strict';

/** Consistent JSON shape: `id` instead of `_id`, no `__v`, and per-schema hidden fields. */
function jsonPlugin(schema, options = {}) {
  const hidden = options.hidden || [];
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform(_doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const f of hidden) delete ret[f];
      return ret;
    },
  });
}

/**
 * Financial records are append-only: block deletes on the model. Corrections are recorded as
 * new adjustment documents instead.
 */
function noDeletePlugin(schema) {
  const block = function blockDelete(next) {
    next(new Error('Financial records cannot be deleted'));
  };
  for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove']) {
    schema.pre(op, { document: true, query: true }, block);
  }
}

module.exports = { jsonPlugin, noDeletePlugin };
